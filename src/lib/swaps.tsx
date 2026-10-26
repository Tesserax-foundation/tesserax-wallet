/** The market of the wallet: purchases of TESS, claimed as soon as their maker fills them, and the
 * maker of an account, which fills its offers while the wallet is open. Both run whatever page is
 * shown. */

import {
  addressOfKey,
  Amount,
  BITCOIN_LOCK_SECONDS,
  claimTransaction,
  Esplora,
  EVM_CHAINS,
  extractSigned,
  findLock,
  makerKey,
  MIN_CONFIRMATIONS,
  hashOf,
  lockPsbt,
  newSecret,
  outpointBytes,
  paymentDue,
  paymentSymbol,
  paymentDecimals,
  refundKey,
  refundTransaction,
  tessFor,
  type EvmSwaps,
  type Keypair,
  type Offer,
  type SwapChain,
} from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
import { bitcoinNetworkOf, connectBitcoin, keyHex } from "./bitcoin";
import { useChain } from "./chain";
import { connectEvm, decimal, evmNetworkOf, evmReader, hex, unhex } from "./evm";
import { decryptSecret, encryptSecret, LOCK_SEARCH_SECONDS, MIN_REMAINING_SECONDS, PAYMENT_LOCK_SECONDS, ROUND_SECONDS } from "./market";
import { useWallet } from "./session";
import { getMaker, listPurchases, putMaker, putPurchase, type StoredMaker, type StoredPurchase } from "./storage";

/** Whether the browser wallet refused the request. */
const rejected = (error: unknown) => (error as { code?: number }).code === 4001 || /reject|denied/i.test((error as Error).message ?? "");

const errorText = (error: unknown) => {
  const message = error instanceof Error ? ((error as { shortMessage?: string }).shortMessage ?? error.message) : String(error);
  return message.split("\n")[0];
};

export interface MakerActivity {
  at: number;
  text: string;
  tone?: "success" | "danger";
}

interface Market {
  genesis?: string;
  purchases: StoredPurchase[];
  /** Lock the payment of `amount` TESS of `offer` from the browser EVM wallet, for the account
   * `account`. Returns once the payment is locked; the TESS are claimed once the maker fills. */
  buy(offer: Offer, amount: Amount, account: string, onStep?: (step: string) => void): Promise<StoredPurchase>;
  /** Take back the payment of a purchase the maker never filled. */
  refund(purchase: StoredPurchase): Promise<string>;
  maker: {
    /** Name of the account whose offers are filled, while running. */
    account?: string;
    state?: StoredMaker;
    activity: MakerActivity[];
    start(account: string): void;
    stop(): void;
    /** Collect the payment of trade `trade` with the browser EVM wallet. */
    collect(trade: string): Promise<string>;
    /** Where the payments in BTC of the maker of `account` go once collected. */
    setBitcoinAddress(account: string, address: string): Promise<void>;
  };
}

const MarketContext = createContext<Market | null>(null);

export function useMarket(): Market {
  const market = useContext(MarketContext);
  if (!market) throw new Error("useMarket outside of MarketProvider");
  return market;
}

const emptyMaker = (): StoredMaker => ({ evmBlocks: {}, tesseraxBlock: 0, trades: {}, collect: {} });

export function MarketProvider({ children }: { children: ReactNode }) {
  const { client, url, network } = useChain();
  const wallet = useWallet();
  const genesis = useQuery({ queryKey: ["genesis", url], queryFn: async () => hex(await client.genesisHash()), staleTime: Infinity }).data;
  const [purchases, setPurchases] = useState<StoredPurchase[]>([]);
  const [makerAccount, setMakerAccount] = useState<string>();
  const [makerState, setMakerState] = useState<StoredMaker>();
  const [activity, setActivity] = useState<MakerActivity[]>([]);
  const keypair = useRef(wallet.keypair);
  keypair.current = wallet.keypair;

  const reload = useCallback(async () => {
    if (genesis) setPurchases(await listPurchases(genesis));
  }, [genesis]);
  useEffect(() => void reload(), [reload]);

  const save = useCallback(
    async (purchase: StoredPurchase) => {
      await putPurchase(purchase);
      await reload();
    },
    [reload],
  );

  const log = useCallback((text: string, tone?: MakerActivity["tone"]) => setActivity((a) => [{ at: Date.now(), text, tone }, ...a].slice(0, 50)), []);

  // Claims: every purchase waiting for its maker is claimed as soon as it is filled.
  useEffect(() => {
    if (!genesis) return;
    let busy = false;
    const round = async () => {
      if (busy) return;
      busy = true;
      try {
        for (const purchase of await listPurchases(genesis)) {
          try {
            const next = await advance(purchase);
            if (next) await save(next);
          } catch (error) {
            // Tried again next round.
            console.warn(`Purchase ${purchase.hash}:`, error);
          }
        }
      } finally {
        busy = false;
      }
    };
    /** Claim the trade the maker filled for `p`: the purchase claimed, nothing to save, or null
     * when no trade of it is waiting for its claim. */
    const claimFilled = async (p: StoredPurchase): Promise<StoredPurchase | undefined | null> => {
      const id = await client.swaps.tradeOfLock(p.chain, unhex(p.lock!));
      const trade = id === undefined ? undefined : await client.swaps.trade(id);
      if (id !== undefined && trade) {
        if (trade.taker !== p.taker) return p.note ? undefined : { ...p, trade: id, note: "The maker filled it for another account: do not claim, take the payment back once its lock expires." };
        if (trade.amount.planck < BigInt(p.amount)) return p.note ? undefined : { ...p, trade: id, note: `The maker filled ${trade.amount} TESS only: take the payment back once its lock expires.` };
        const key = await keypair.current(p.account);
        const secret = decryptSecret(key.seed(), p.nonce, p.ciphertext);
        if (hex(hashOf(secret)) !== hex(trade.hash)) return undefined;
        // Recorded before the claim: once it is submitted, the trade vanishing means it is claimed.
        await save({ ...p, trade: id, status: "claiming", note: undefined });
        await client.swaps.claim(id, secret);
        return { ...p, trade: id, status: "claimed", note: undefined };
      }
      if (id !== undefined && p.status === "claiming") return { ...p, trade: id, status: "claimed" };
      return null;
    };
    const advanceBitcoin = async (p: StoredPurchase): Promise<StoredPurchase | undefined> => {
      if (p.status === "locking") {
        // Not signed, or not broadcast.
        if (Date.now() / 1000 - p.createdAt / 1000 > LOCK_SEARCH_SECONDS) return { ...p, status: "failed", note: "The payment was not broadcast." };
        return undefined;
      }
      if ((p.status !== "locked" && p.status !== "claiming") || !p.lock || !p.bitcoin) return undefined;
      const filled = await claimFilled(p);
      if (filled !== null) return filled;
      const esplora = new Esplora(bitcoinNetworkOf(network), network.esploraUrl);
      const now = await esplora.medianTime();
      // Spent before its timelock, the payment was collected with the secret a claim revealed.
      if (await esplora.isSpent(p.bitcoin.txid, p.bitcoin.vout)) return now <= p.timelock ? { ...p, status: "claimed" } : { ...p, status: "refunded" };
      if (now <= p.timelock) return undefined;
      return { ...p, status: "refundable", note: undefined };
    };
    const advance = async (p: StoredPurchase): Promise<StoredPurchase | undefined> => {
      if (p.chain === "Bitcoin") return advanceBitcoin(p);
      const evm = evmNetworkOf(network, p.chain);
      if (!evm) return undefined;
      const reader = evmReader(evm);
      if (p.status === "locking") {
        const head = await reader.head();
        const found = (await reader.locks(BigInt(p.fromBlock), head.number, p.recipient as Address)).find((l) => hex(l.hash) === p.hash && l.sender.toLowerCase() === p.sender.toLowerCase());
        if (found) return { ...p, lock: found.id, timelock: found.timelock, deadline: Math.floor(Date.now() / 1000) + found.timelock - head.time, status: "locked", note: undefined };
        if (Date.now() / 1000 - p.createdAt / 1000 > LOCK_SEARCH_SECONDS) return { ...p, status: "failed", note: "No payment was locked." };
        return undefined;
      }
      if ((p.status !== "locked" && p.status !== "claiming") || !p.lock) return undefined;
      const filled = await claimFilled(p);
      if (filled !== null) return filled;
      // The maker collected with the secret: only a claim reveals it.
      const status = await reader.lockStatus(p.lock as `0x${string}`);
      if (status?.state === "Claimed") return { ...p, status: "claimed" };
      if (status?.state === "Refunded") return { ...p, status: "refunded" };
      // Not filled, or no longer claimable: the payment returns once its lock expires.
      if ((await reader.head()).time < p.timelock) return undefined;
      return { ...p, status: "refundable", note: undefined };
    };
    void round();
    const timer = setInterval(round, ROUND_SECONDS * 1000);
    return () => clearInterval(timer);
  }, [genesis, client, network, save]);

  const buyWithBitcoin = async (offer: Offer, amount: Amount, account: string, onStep?: (step: string) => void): Promise<StoredPurchase> => {
    if (!genesis) throw new Error("not connected yet");
    const named = wallet.accounts.find((a) => a.name === account);
    if (!named) throw new Error("no such account");
    const btcNetwork = bitcoinNetworkOf(network);
    const esplora = new Esplora(btcNetwork, network.esploraUrl);
    onStep?.("Connecting the Bitcoin wallet…");
    const payer = await connectBitcoin(btcNetwork);
    const payment = paymentDue(amount.planck, offer.price);
    onStep?.("Reading the bitcoin of the wallet…");
    const utxos = await esplora.utxos(payer.address);
    const funds = utxos.reduce((sum, u) => sum + u.amount, 0n);
    if (funds < payment) throw new Error(`${payer.name} has ${decimal(funds, 8)} BTC at ${payer.address}: ${decimal(payment, 8)} BTC and the fees are needed.`);
    const paying = await Promise.all(utxos.map(async (u) => ({ ...u, rawTx: await esplora.rawTransaction(u.txid) })));
    const key = await wallet.keypair(account);
    const { secret, hash } = newSecret();
    const refund = refundKey(key.seed(), hash);
    const now = await esplora.medianTime();
    const timelock = now + BITCOIN_LOCK_SECONDS;
    const htlc = { hash, maker: offer.payout, taker: refund.publicKey, timelock };
    const built = lockPsbt({
      htlc,
      announcement: { offer: offer.id, taker: named.address, hash, timelock, refund: refund.publicKey },
      amount: payment,
      payer: payer.address,
      utxos: paying,
      feeRate: await esplora.feeRate(2),
      network: btcNetwork,
    });
    // The secret is saved before anything is signed: without it, the TESS cannot be claimed.
    const purchase: StoredPurchase = {
      id: `${genesis}/${hex(hash)}`,
      genesis,
      account,
      taker: named.address,
      offer: offer.id,
      chain: "Bitcoin",
      asset: "Native",
      amount: amount.planck.toString(),
      payment: payment.toString(),
      recipient: keyHex(offer.payout),
      sender: payer.address,
      hash: hex(hash),
      ...encryptSecret(key.seed(), secret),
      fromBlock: "0",
      timelock,
      // The median time of Bitcoin runs about an hour behind the clock.
      deadline: Math.floor(Date.now() / 1000) + BITCOIN_LOCK_SECONDS + 3600,
      status: "locking",
      createdAt: Date.now(),
    };
    await save(purchase);
    onStep?.(`Confirm the payment in ${payer.name}…`);
    let signed: { raw: Uint8Array; txid: string };
    try {
      signed = extractSigned(await payer.sign(built.psbt, built.inputs));
    } catch (error) {
      await save({ ...purchase, status: "failed", note: rejected(error) ? `Refused in ${payer.name}.` : errorText(error) });
      throw new Error(errorText(error));
    }
    const locked: StoredPurchase = {
      ...purchase,
      lock: hex(outpointBytes(signed.txid, built.vout)),
      bitcoin: { maker: keyHex(offer.payout), refund: keyHex(refund.publicKey), wallet: payer.name, payer: payer.address, txid: signed.txid, vout: built.vout },
      status: "locked",
    };
    // Saved before the broadcast: the refund needs the output.
    await save(locked);
    onStep?.("Broadcasting the payment…");
    try {
      await esplora.broadcast(signed.raw);
    } catch (error) {
      await save({ ...locked, status: "failed", note: errorText(error) });
      throw new Error(errorText(error));
    }
    return locked;
  };

  const refundBitcoin = async (purchase: StoredPurchase): Promise<string> => {
    const b = purchase.bitcoin;
    if (!b) throw new Error("no payment to take back");
    const btcNetwork = bitcoinNetworkOf(network);
    const esplora = new Esplora(btcNetwork, network.esploraUrl);
    const now = await esplora.medianTime();
    if (now <= purchase.timelock) throw new Error(`The payment can be taken back in about ${Math.ceil((purchase.timelock + 1 - now) / 3600)} hour(s), once the median time of Bitcoin passes its lock.`);
    const key = await wallet.keypair(purchase.account);
    const hash = unhex(purchase.hash);
    const refund = refundKey(key.seed(), hash);
    const htlc = { hash, maker: unhex(b.maker), taker: refund.publicKey, timelock: purchase.timelock };
    const raw = refundTransaction({ txid: b.txid, vout: b.vout, amount: BigInt(purchase.payment), htlc }, refund.secretKey, b.payer, await esplora.feeRate(6), btcNetwork);
    const txid = await esplora.broadcast(raw);
    await save({ ...purchase, status: "refunded", note: undefined });
    return txid;
  };

  const buy: Market["buy"] = async (offer, amount, account, onStep) => {
    if (!genesis) throw new Error("not connected yet");
    if (offer.payment.chain === "Bitcoin") return buyWithBitcoin(offer, amount, account, onStep);
    const evm = evmNetworkOf(network, offer.payment.chain);
    if (!evm) throw new Error("This chain is not paid from the web wallet.");
    const named = wallet.accounts.find((a) => a.name === account);
    if (!named) throw new Error("no such account");
    onStep?.("Connecting the EVM wallet…");
    const { swaps, address } = await connectEvm(evm);
    const recipient = hex(offer.payout) as Address;
    const payment = paymentDue(amount.planck, offer.price);
    const balance = await swaps.balance(address, offer.payment.asset);
    if (balance < payment) throw new Error(`This EVM account has ${decimal(balance, paymentDecimals(offer.payment))} ${paymentSymbol(offer.payment)} on ${evm.name}.`);
    const key = await wallet.keypair(account);
    const { secret, hash } = newSecret();
    const head = await swaps.head();
    // The secret is saved before anything is locked: without it, the TESS cannot be claimed.
    const purchase: StoredPurchase = {
      id: `${genesis}/${hex(hash)}`,
      genesis,
      account,
      taker: named.address,
      offer: offer.id,
      chain: offer.payment.chain,
      asset: offer.payment.asset,
      amount: amount.planck.toString(),
      payment: payment.toString(),
      recipient,
      sender: address,
      hash: hex(hash),
      ...encryptSecret(key.seed(), secret),
      fromBlock: head.number.toString(),
      timelock: head.time + PAYMENT_LOCK_SECONDS,
      deadline: Math.floor(Date.now() / 1000) + PAYMENT_LOCK_SECONDS,
      status: "locking",
      createdAt: Date.now(),
    };
    await save(purchase);
    onStep?.(offer.payment.asset === "Native" ? "Confirm the payment in the EVM wallet…" : "Confirm the approval, then the payment, in the EVM wallet…");
    try {
      const lock = await swaps.lockPayment({ asset: offer.payment.asset, recipient, amount: payment, hash, timelock: purchase.timelock, offer: offer.id, taker: named.address });
      const locked: StoredPurchase = { ...purchase, lock, status: "locked" };
      await save(locked);
      return locked;
    } catch (error) {
      // Refused in the wallet: nothing was locked. Otherwise the lock may exist: it is searched.
      if (rejected(error)) await save({ ...purchase, status: "failed", note: "Refused in the EVM wallet." });
      throw new Error(errorText(error));
    }
  };

  const refund: Market["refund"] = async (purchase) => {
    if (purchase.chain === "Bitcoin") return refundBitcoin(purchase);
    const evm = evmNetworkOf(network, purchase.chain);
    if (!evm || !purchase.lock) throw new Error("no payment to take back");
    const { swaps } = await connectEvm(evm);
    try {
      const tx = await swaps.refund(purchase.lock as `0x${string}`);
      await save({ ...purchase, status: "refunded", note: undefined });
      return tx;
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  // The maker: fills the offers of its account for the payments locked for them.
  useEffect(() => {
    if (!makerAccount || !genesis) return;
    const named = wallet.accounts.find((a) => a.name === makerAccount);
    if (!named) return;
    let stopped = false;
    let busy = false;
    const round = async () => {
      if (busy || stopped) return;
      busy = true;
      try {
        const key = await keypair.current(makerAccount);
        const state = (await getMaker(genesis, named.address)) ?? emptyMaker();
        if (state.tesseraxBlock === 0) state.tesseraxBlock = await client.bestBlockNumber();
        await makerRound(key, named.address, state);
        await putMaker(genesis, named.address, state);
        if (!stopped) setMakerState({ ...state });
      } catch (error) {
        log(errorText(error), "danger");
      } finally {
        busy = false;
      }
    };
    const warned = { otherKey: false };
    const makerRound = async (key: Keypair, maker: string, state: StoredMaker) => {
      const offers = (await client.swaps.offers()).filter((o) => o.maker === maker);
      for (const chain of EVM_CHAINS) {
        const mine = offers.filter((o) => o.payment.chain === chain);
        const evm = evmNetworkOf(network, chain);
        if (mine.length === 0 || !evm) continue;
        await fillChain(key, chain, evmReader(evm), mine, state);
      }
      const bitcoinOffers = offers.filter((o) => o.payment.chain === "Bitcoin");
      if (bitcoinOffers.length > 0) {
        try {
          await fillBitcoin(key, bitcoinOffers, state);
        } catch (error) {
          log(`Bitcoin offers: ${errorText(error)}`, "danger");
        }
      }

      // Trades expired unclaimed: their TESS return to the offer.
      const best = await client.bestBlockNumber();
      for (const trade of await client.swaps.trades()) {
        if (trade.maker === maker && trade.expires < best) {
          try {
            await client.swaps.refund(key, trade.id);
            log(`Trade #${trade.id} expired unclaimed: its ${trade.amount} TESS are back.`);
          } catch (error) {
            log(`Taking back trade #${trade.id}: ${errorText(error)}`, "danger");
          }
        }
      }

      // Claims reveal the secrets of the payments to collect.
      const last = Math.min(best, state.tesseraxBlock + 500);
      let unreadable = 0;
      for (let number = state.tesseraxBlock + 1; number <= last; number++) {
        let events: Awaited<ReturnType<typeof client.swaps.events>>;
        try {
          events = await client.swaps.events(number);
        } catch (error) {
          // A node that is not an archive node keeps the state of its recent blocks only.
          if (!/discarded|pinned|UnknownBlock/i.test(errorText(error))) throw error;
          unreadable++;
          state.tesseraxBlock = number;
          continue;
        }
        for (const event of events) {
          if (event.type === "Filled" && event.trade.maker === maker && !state.trades[event.trade.id]) {
            state.trades[event.trade.id] = { chain: event.trade.payment.chain, lock: hex(event.trade.paymentLock), timelock: 0 };
          } else if (event.type === "Claimed" && state.trades[event.trade]) {
            state.collect[event.trade] = { ...state.trades[event.trade], secret: hex(event.secret) };
            delete state.trades[event.trade];
            log(`Trade #${event.trade} claimed: collect its payment.`, "success");
          } else if (event.type === "Refunded") {
            delete state.trades[event.trade];
          }
        }
        state.tesseraxBlock = number;
      }
      if (unreadable > 0) log(`${unreadable} old blocks not read: the node no longer keeps their state, nor the claims they had.`, "danger");

      // Payments in BTC: collected with the maker key, which this wallet holds.
      for (const [trade, c] of Object.entries(state.collect)) {
        if (c.chain !== "Bitcoin") continue;
        try {
          const txid = await collectBitcoin(key, c, state);
          delete state.collect[trade];
          log(txid ? `Collected the payment of trade #${trade} in BTC.` : `The payment of trade #${trade} is already spent.`, "success");
        } catch (error) {
          log(`Collecting the payment of trade #${trade}, again next round: ${errorText(error)}`, "danger");
        }
      }

      // Payments someone else collected.
      for (const [trade, c] of Object.entries(state.collect)) {
        if (c.chain === "Bitcoin") continue;
        const evm = evmNetworkOf(network, c.chain);
        if (!evm) continue;
        const reader = evmReader(evm);
        const status = await reader.lockStatus(c.lock as `0x${string}`);
        if (status?.state === "Claimed") {
          delete state.collect[trade];
          log(`The payment of trade #${trade} is collected.`, "success");
        } else if (status && c.deadline === undefined) {
          const now = (await reader.head()).time;
          state.collect[trade] = { ...c, timelock: status.timelock, deadline: Math.floor(Date.now() / 1000) + status.timelock - now };
        }
      }
    };
    /** Fill the Bitcoin offers paid to the maker key of the account, for the payments the
     * transactions to its address announce, once confirmed. */
    const fillBitcoin = async (key: Keypair, mine: Offer[], state: StoredMaker) => {
      const own = makerKey(key.seed());
      const ours = mine.filter((o) => hex(o.payout) === hex(own.publicKey));
      if (ours.length < mine.length && !warned.otherKey) {
        warned.otherKey = true;
        log("Bitcoin offers paid to another key, such as one of the command line wallet, are filled by their own maker.");
      }
      if (ours.length === 0) return;
      const btcNetwork = bitcoinNetworkOf(network);
      const esplora = new Esplora(btcNetwork, network.esploraUrl);
      const [height, now] = await Promise.all([esplora.height(), esplora.medianTime()]);
      const seen = new Set(state.bitcoinSeen ?? []);
      const address = addressOfKey(own.publicKey, btcNetwork);
      let after: string | undefined;
      // The latest transactions, back to those older than a payment lock.
      for (let page = 0; page < 8; page++) {
        const txs = await esplora.addressTransactions(address, after);
        let older = false;
        for (const t of txs) {
          if (t.time !== undefined && t.time + PAYMENT_LOCK_SECONDS < now) {
            older = true;
            continue;
          }
          if (t.height === undefined || seen.has(t.txid) || height - t.height + 1 < MIN_CONFIRMATIONS) continue;
          const lock = findLock(await esplora.rawTransaction(t.txid), own.publicKey);
          const offer = lock && ours.find((o) => o.id === lock.offer);
          const lockBytes = lock && outpointBytes(lock.txid, lock.vout);
          if (
            !lock ||
            !offer ||
            lock.htlc.timelock < now + MIN_REMAINING_SECONDS ||
            (await esplora.isSpent(lock.txid, lock.vout)) ||
            (await client.swaps.tradeOfLock("Bitcoin", lockBytes!)) !== undefined
          ) {
            seen.add(t.txid);
            continue;
          }
          const current = await client.swaps.offer(offer.id);
          const amount = tessFor(lock.amount, offer.price);
          if (!current || amount === 0n || amount > current.available.planck || (amount < current.minFill.planck && amount !== current.available.planck)) {
            log(`A payment of ${decimal(lock.amount, 8)} BTC does not fit offer #${offer.id}: its sender takes it back.`);
            seen.add(t.txid);
            continue;
          }
          try {
            const trade = await client.swaps.fill(key, offer.id, { taker: lock.taker, amount: new Amount(amount), hash: lock.htlc.hash, paymentLock: lockBytes! });
            state.trades[trade] = { chain: "Bitcoin", lock: hex(lockBytes!), timelock: lock.htlc.timelock };
            seen.add(t.txid);
            log(`Filled trade #${trade}: ${new Amount(amount)} TESS for ${decimal(lock.amount, 8)} BTC.`, "success");
          } catch (error) {
            log(`Filling a payment of offer #${offer.id}: ${errorText(error)}`, "danger");
          }
        }
        after = [...txs].reverse().find((t) => t.height !== undefined)?.txid;
        if (older || txs.length < 25 || !after) break;
      }
      state.bitcoinSeen = [...seen].slice(-500);
    };
    /** Collect the payment in BTC `c` with the secret, sweeping the notices to the maker key.
     * Returns the transaction, or nothing if the payment is already spent. */
    const collectBitcoin = async (key: Keypair, c: StoredMaker["collect"][string], state: StoredMaker): Promise<string | undefined> => {
      const own = makerKey(key.seed());
      const btcNetwork = bitcoinNetworkOf(network);
      const esplora = new Esplora(btcNetwork, network.esploraUrl);
      const bytes = unhex(c.lock);
      const txid = hex(bytes.slice(0, 32).reverse()).slice(2);
      const vout = new DataView(bytes.buffer, bytes.byteOffset + 32, 4).getUint32(0, true);
      if (await esplora.isSpent(txid, vout)) return undefined;
      const lock = findLock(await esplora.rawTransaction(txid), own.publicKey);
      if (!lock || lock.vout !== vout) throw new Error("this payment is not locked for the maker key of the account");
      const address = addressOfKey(own.publicKey, btcNetwork);
      const notices = (await esplora.utxos(address)).filter((u) => u.confirmed);
      const raw = claimTransaction(lock, unhex(c.secret), own.secretKey, state.bitcoinAddress ?? address, await esplora.feeRate(2), btcNetwork, notices);
      return esplora.broadcast(raw);
    };
    const fillChain = async (key: Keypair, chain: SwapChain, reader: EvmSwaps, mine: Offer[], state: StoredMaker) => {
      const head = await reader.head();
      const saved = state.evmBlocks[chain];
      const from = saved ? BigInt(saved) + 1n : head.number > 1_000n ? head.number - 1_000n : 0n;
      if (from > head.number) return;
      // A round reads at most 20,000 blocks: a maker closed for long catches up over rounds.
      const to = head.number - from > 20_000n ? from + 20_000n : head.number;
      const payouts = [...new Set(mine.map((o) => hex(o.payout)))];
      for (const payout of payouts) {
        for (const lock of await reader.locks(from, to, payout as Address)) {
          const offer = mine.find((o) => o.id === lock.offer && hex(o.payout) === payout);
          if (!offer) continue;
          const paid = reader.amountOf(lock, offer.payment);
          if (paid === undefined || lock.state !== "Locked" || lock.timelock < head.time + MIN_REMAINING_SECONDS) continue;
          if ((await client.swaps.tradeOfLock(chain, unhex(lock.id))) !== undefined) continue;
          const current = await client.swaps.offer(offer.id);
          const amount = tessFor(paid, offer.price);
          if (!current || amount === 0n || amount > current.available.planck || (amount < current.minFill.planck && amount !== current.available.planck)) {
            log(`A payment of ${decimal(paid, paymentDecimals(offer.payment))} ${paymentSymbol(offer.payment)} does not fit offer #${offer.id}: its sender takes it back.`);
            continue;
          }
          try {
            const trade = await client.swaps.fill(key, offer.id, { taker: lock.taker, amount: new Amount(amount), hash: lock.hash, paymentLock: unhex(lock.id) });
            state.trades[trade] = { chain, lock: lock.id, timelock: lock.timelock };
            log(`Filled trade #${trade}: ${new Amount(amount)} TESS for ${decimal(paid, paymentDecimals(offer.payment))} ${paymentSymbol(offer.payment)}.`, "success");
          } catch (error) {
            log(`Filling a payment of offer #${offer.id}: ${errorText(error)}`, "danger");
          }
        }
      }
      state.evmBlocks[chain] = to.toString();
    };
    log(`Maker of ${makerAccount} started.`);
    void round();
    const timer = setInterval(round, ROUND_SECONDS * 1000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [makerAccount, genesis, client, network, log]);

  // The state of the maker of the active account, shown even while it does not run.
  const activeAddress = wallet.accounts.find((a) => a.name === (makerAccount ?? wallet.active?.name))?.address;
  useEffect(() => {
    if (!genesis || !activeAddress || makerAccount) return;
    void getMaker(genesis, activeAddress).then(setMakerState);
  }, [genesis, activeAddress, makerAccount]);

  const collect = async (trade: string) => {
    const owner = wallet.accounts.find((a) => a.name === (makerAccount ?? wallet.active?.name));
    if (!genesis || !owner) throw new Error("no maker");
    const state = (await getMaker(genesis, owner.address)) ?? emptyMaker();
    const c = state.collect[trade];
    if (!c) throw new Error("nothing to collect for this trade");
    const evm = evmNetworkOf(network, c.chain);
    if (!evm) throw new Error("unknown chain");
    const { swaps } = await connectEvm(evm);
    try {
      const tx = await swaps.claim(c.lock as `0x${string}`, unhex(c.secret));
      delete state.collect[trade];
      await putMaker(genesis, owner.address, state);
      setMakerState({ ...state });
      log(`Collected the payment of trade #${trade}.`, "success");
      return tx;
    } catch (error) {
      throw new Error(errorText(error));
    }
  };

  const value: Market = {
    genesis,
    purchases,
    buy,
    refund,
    maker: {
      account: makerAccount,
      state: makerState,
      activity,
      start: (account) => {
        setActivity([]);
        setMakerAccount(account);
      },
      stop: () => {
        if (makerAccount) log(`Maker of ${makerAccount} stopped.`);
        setMakerAccount(undefined);
      },
      collect,
      setBitcoinAddress: async (account, address) => {
        const owner = wallet.accounts.find((a) => a.name === account);
        if (!genesis || !owner) return;
        const state = (await getMaker(genesis, owner.address)) ?? emptyMaker();
        await putMaker(genesis, owner.address, { ...state, bitcoinAddress: address });
      },
    },
  };
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}
