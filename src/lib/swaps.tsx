/** The market of the wallet: purchases of TESS, claimed as soon as their maker fills them, and the
 * maker of an account, which fills its offers while the wallet is open. Both run whatever page is
 * shown. */

import { Amount, EVM_CHAINS, hashOf, newSecret, paymentDue, paymentSymbol, paymentDecimals, tessFor, type EvmSwaps, type Keypair, type Offer, type SwapChain } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import type { Address } from "viem";
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
    const advance = async (p: StoredPurchase): Promise<StoredPurchase | undefined> => {
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
      const id = await client.swaps.tradeOfLock(p.chain, unhex(p.lock));
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
      // The maker collected with the secret: only a claim reveals it.
      const status = await reader.lockStatus(p.lock as `0x${string}`);
      if (status?.state === "Claimed") return { ...p, trade: id, status: "claimed" };
      if (status?.state === "Refunded") return { ...p, status: "refunded" };
      // Not filled, or no longer claimable: the payment returns once its lock expires.
      if ((await reader.head()).time < p.timelock) return undefined;
      return { ...p, status: "refundable", note: undefined };
    };
    void round();
    const timer = setInterval(round, ROUND_SECONDS * 1000);
    return () => clearInterval(timer);
  }, [genesis, client, network, save]);

  const buy: Market["buy"] = async (offer, amount, account, onStep) => {
    if (!genesis) throw new Error("not connected yet");
    const evm = evmNetworkOf(network, offer.payment.chain);
    if (!evm) throw new Error("Offers paid on Bitcoin come with the Bitcoin support of the market.");
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
    const makerRound = async (key: Keypair, maker: string, state: StoredMaker) => {
      const offers = (await client.swaps.offers()).filter((o) => o.maker === maker);
      for (const chain of EVM_CHAINS) {
        const mine = offers.filter((o) => o.payment.chain === chain);
        const evm = evmNetworkOf(network, chain);
        if (mine.length === 0 || !evm) continue;
        await fillChain(key, chain, evmReader(evm), mine, state);
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
      for (let number = state.tesseraxBlock + 1; number <= last; number++) {
        for (const event of await client.swaps.events(number)) {
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

      // Payments someone else collected.
      for (const [trade, c] of Object.entries(state.collect)) {
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
    },
  };
  return <MarketContext.Provider value={value}>{children}</MarketContext.Provider>;
}
