import {
  addressOfKey,
  Amount,
  makerKey,
  paymentDecimals,
  paymentDue,
  paymentSymbol,
  tokenOf,
  type Bid,
  type Keypair,
  type Offer,
  type Payment,
  type SwapAsset,
  type SwapChain,
  type TesseraxClient,
} from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, Circle, CircleAlert, CircleCheck, Clock, Coins, ExternalLink, HandCoins, Loader2, Play, Plus, Square, Store, Wallet } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { AmountInput, Button, parseAmount, Select, TextInput } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink } from "../components/links";
import { Sheet } from "../components/Sheet";
import { explainError, useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, cx, EmptyState, ErrorState, PageHeader, SkeletonRows, Tabs } from "../components/ui";
import { bitcoinNetworkOf, bitcoinTxUrl, bitcoinWallets, connectBitcoin } from "../lib/bitcoin";
import { estimateFee, useBalance, useChain } from "../lib/chain";
import type { Network } from "../lib/networks";
import { browserWallet, connectEvm, decimal, evmNetworkOf, evmNetworksOf, evmTxUrl, hex, unhex, units } from "../lib/evm";
import { formatTess, timeAgo } from "../lib/format";
import { useWallet } from "../lib/session";
import type { SaleStatus, StoredPurchase, StoredSale } from "../lib/storage";
import { useMarket } from "../lib/swaps";

const priceText = (payment: Payment, price: bigint) => `${decimal(price, paymentDecimals(payment))} ${paymentSymbol(payment)}`;

const ASSET_NAMES: Record<SwapAsset, string> = { Native: "ETH", Usdc: "USDC", Usdt: "USDT" };

const hoursLeft = (unix: number | undefined) => {
  if (unix === undefined || Number.isNaN(unix)) return "once its lock expires";
  const seconds = unix - Date.now() / 1000;
  if (seconds <= 0) return "now";
  const hours = Math.floor(seconds / 3600);
  return hours >= 1 ? `in ${hours} h ${Math.floor((seconds % 3600) / 60)} min` : `in ${Math.max(1, Math.round(seconds / 60))} min`;
};

/** The chain has no market before the runtime upgrade that brings it. */
export class NoMarket extends Error {}

function useOffers() {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["offers", url],
    queryFn: async () => {
      try {
        return await client.swaps.offers();
      } catch (error) {
        if (/Swaps/.test(String((error as Error).message))) throw new NoMarket();
        throw error;
      }
    },
    refetchInterval: 18_000,
    retry: (count, error) => !(error instanceof NoMarket) && count < 1,
  });
}

function OffersError({ error }: { error: unknown }) {
  if (error instanceof NoMarket) return <EmptyState title="No market on this network yet">It opens with the runtime upgrade that brings atomic swaps.</EmptyState>;
  return <ErrorState error={error} />;
}

/** The name of the chain an offer is paid on, on `network`. */
function chainName(network: Network, chain: SwapChain): string {
  if (chain === "Bitcoin") return network.id === "mainnet" ? "Bitcoin" : network.bitcoinNetwork === "regtest" ? "Bitcoin regtest" : "Bitcoin testnet4";
  return evmNetworkOf(network, chain)?.name ?? chain;
}

function useChainName(chain: SwapChain): string {
  return chainName(useChain().network, chain);
}

/** The Bitcoin wallets of this browser, once detected. */
function useBitcoinWallets(): string[] | undefined {
  return useQuery({ queryKey: ["bitcoin-wallets"], queryFn: bitcoinWallets, staleTime: 30_000 }).data;
}

function NoBitcoinWallet() {
  return (
    <p className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-warning">
      No Bitcoin wallet in this browser. Payments in BTC are signed by one, such as the Bitcoin account of MetaMask, Xverse or Unisat: open the web wallet in a browser that has it.
    </p>
  );
}

function NoBrowserWallet() {
  return (
    <p className="rounded-xl bg-warning-soft px-3 py-2.5 text-sm text-warning">
      No EVM wallet in this browser. Payments in ETH, USDC and USDT are signed by one, such as MetaMask or Rabby: open the web wallet in a browser that has it.
    </p>
  );
}

function OfferRow({ offer, own, onBuy }: { offer: Offer; own: boolean; onBuy: () => void }) {
  const chainName = useChainName(offer.payment.chain);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold tabular">{formatTess(offer.available.planck, 2)} TESS</span>
          <span className="text-sm text-muted">
            at <span className="font-medium text-fg tabular">{priceText(offer.payment, offer.price)}</span> each
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Badge>{chainName}</Badge>
          <span>from {formatTess(offer.minFill.planck, 2)} TESS</span>
          <span>
            {offer.completed}/{offer.fills} trades completed
          </span>
          <span className="inline-flex items-center gap-1">
            by <AddressLink address={offer.maker} />
          </span>
        </div>
      </div>
      {own ? (
        <Badge tone="accent">Your offer</Badge>
      ) : (
        <Button size="sm" onClick={onBuy}>
          Buy
        </Button>
      )}
    </li>
  );
}

function BuySheet({ offer, onClose }: { offer: Offer; onClose: () => void }) {
  const { active } = useWallet();
  const market = useMarket();
  const [amount, setAmount] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [step, setStep] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState(false);
  const parsed = parseAmount(amount, { max: offer.available.planck });
  let invalid = !amount ? "Enter an amount" : parsed.error ?? null;
  if (!invalid && parsed.amount && parsed.amount.planck < offer.minFill.planck && parsed.amount.planck !== offer.available.planck) {
    invalid = `This offer sells at least ${formatTess(offer.minFill.planck, 4)} TESS`;
  }
  const due = parsed.amount ? paymentDue(parsed.amount.planck, offer.price) : undefined;
  const chainName = useChainName(offer.payment.chain);
  const symbol = paymentSymbol(offer.payment);
  const bitcoin = offer.payment.chain === "Bitcoin";
  const bitcoinWalletsFound = useBitcoinWallets();
  const payerReady = bitcoin ? (bitcoinWalletsFound?.length ?? 0) > 0 : Boolean(browserWallet());

  const buy = async () => {
    setSubmitted(true);
    if (invalid || !parsed.amount || !active) return;
    setError(undefined);
    try {
      await market.buy(offer, parsed.amount, active.name, setStep);
      setDone(true);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setStep(undefined);
    }
  };

  return (
    <Sheet title={`Buy TESS of offer #${offer.id}`} icon={<Coins size={18} />} onClose={onClose}>
      {done ? (
        <div className="space-y-4 text-center">
          <CircleCheck size={40} className="mx-auto text-success" />
          <p className="font-semibold">Payment locked</p>
          <p className="text-sm text-muted">
            The wallet claims the TESS for {active?.name} as soon as the maker fills the payment, without fee. If the maker does not, the payment returns to you in 24 hours: take it back from
            Your purchases.
          </p>
          <Button className="w-full" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="text-xs text-muted">Price</div>
              <div className="mt-0.5 font-semibold tabular">
                {priceText(offer.payment, offer.price)} <span className="font-normal text-muted">/ TESS</span>
              </div>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="text-xs text-muted">Paid on</div>
              <div className="mt-0.5 font-semibold">{chainName}</div>
            </div>
          </div>
          <AmountInput
            label="TESS to buy"
            value={amount}
            onChange={setAmount}
            max={offer.available}
            error={submitted ? invalid : null}
            hint={<>From {formatTess(offer.minFill.planck, 4)} to {formatTess(offer.available.planck, 4)} TESS</>}
          />
          <div className="rounded-xl border border-line p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted">You pay</span>
              <span className="font-semibold tabular">{due !== undefined ? `${decimal(due, paymentDecimals(offer.payment))} ${symbol}` : "…"}</span>
            </div>
            <div className="mt-1.5 flex justify-between gap-3">
              <span className="text-muted">TESS go to</span>
              <span className="font-medium">{active?.name}</span>
            </div>
            <div className="mt-1.5 flex justify-between gap-3">
              <span className="text-muted">Fee on Tesserax</span>
              <span className="font-medium">None: it needs no TESS</span>
            </div>
          </div>
          {bitcoin ? (
            <ol className="space-y-1.5 text-xs text-muted">
              <li>1. Your Bitcoin wallet locks the payment for the maker in a script, for 24 hours, with the network fee.</li>
              <li>2. The maker fills it after 2 confirmations, about 20 minutes, and locks the TESS for you.</li>
              <li>3. This wallet claims them with a secret only it knows, which then releases the payment to the maker. If the maker never fills, this wallet takes the payment back after 24 hours, with a key of the account.</li>
            </ol>
          ) : (
            <ol className="space-y-1.5 text-xs text-muted">
              <li>1. Your EVM wallet locks the payment for the maker, for 24 hours, plus the gas of {chainName}.</li>
              <li>2. The maker checks it and locks the TESS for you.</li>
              <li>3. This wallet claims them with a secret only it knows, which then releases the payment to the maker.</li>
            </ol>
          )}
          {!payerReady && (bitcoin ? bitcoinWalletsFound && <NoBitcoinWallet /> : <NoBrowserWallet />)}
          {error && <p className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>}
          <Button className="w-full" onClick={buy} busy={Boolean(step)} disabled={!payerReady}>
            <Wallet size={16} />{" "}
            {step ??
              `Pay ${due !== undefined ? `${decimal(due, paymentDecimals(offer.payment))} ` : ""}${symbol} with my ${bitcoin ? (bitcoinWalletsFound?.[0] ?? "Bitcoin wallet") : "EVM wallet"}`}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

const STATUS: Record<StoredPurchase["status"], { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  locking: { label: "Locking the payment", tone: "neutral" },
  locked: { label: "Waiting for the maker", tone: "accent" },
  claiming: { label: "Claiming", tone: "accent" },
  claimed: { label: "Claimed", tone: "success" },
  refundable: { label: "To take back", tone: "warning" },
  refunded: { label: "Taken back", tone: "neutral" },
  failed: { label: "Not locked", tone: "danger" },
};

function Purchases() {
  const { network } = useChain();
  const market = useMarket();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{ id: string; url?: string }>();
  const shown = market.purchases.filter((p) => p.status !== "failed" || Date.now() - p.createdAt < 86_400_000);

  const refund = async (p: StoredPurchase) => {
    setBusy(p.id);
    setError(undefined);
    try {
      const tx = await market.refund(p);
      setDone({ id: p.id, url: p.chain === "Bitcoin" ? bitcoinTxUrl(bitcoinNetworkOf(network), tx) : evmTxUrl(evmNetworkOf(network, p.chain), tx) });
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card>
      <CardHeader title="Your purchases" icon={<Clock size={16} />} />
      {shown.length === 0 ? (
        <p className="p-4 text-sm text-muted sm:p-5">No purchase yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((p) => {
            const payment = { chain: p.chain, asset: p.asset };
            const status = STATUS[p.status];
            return (
              <li key={p.id} className="space-y-2 px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    <span className="font-semibold tabular">{formatTess(BigInt(p.amount), 4)} TESS</span>
                    <span className="text-muted">
                      {" "}
                      for {decimal(BigInt(p.payment), paymentDecimals(payment))} {paymentSymbol(payment)} · {p.account} · {timeAgo(new Date(p.createdAt))}
                    </span>
                  </span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
                {p.status === "locked" && !p.note && <p className="text-xs text-muted">Claimed without fee as soon as the maker fills it. Otherwise it can be taken back {hoursLeft(p.deadline)}.</p>}
                {p.note && <p className="text-xs text-warning">{p.note}</p>}
                {p.bitcoin && (p.status === "locked" || p.status === "claiming") && (
                  <a href={bitcoinTxUrl(bitcoinNetworkOf(network), p.bitcoin.txid)} target="_blank" rel="noreferrer" className="text-xs text-accent underline">
                    See the payment
                  </a>
                )}
                {p.status === "refundable" &&
                  (done?.id === p.id ? (
                    <p className="text-xs text-success">
                      Taken back.{" "}
                      {done.url && (
                        <a href={done.url} target="_blank" rel="noreferrer" className="underline">
                          See the transaction
                        </a>
                      )}
                    </p>
                  ) : (
                    <Button size="sm" variant="secondary" busy={busy === p.id} onClick={() => refund(p)} disabled={p.chain !== "Bitcoin" && !browserWallet()}>
                      Take back the payment
                    </Button>
                  ))}
              </li>
            );
          })}
        </ul>
      )}
      {error && <p className="mx-4 mb-4 rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger sm:mx-5">{error}</p>}
    </Card>
  );
}

function BuyTab() {
  const offers = useOffers();
  const { active } = useWallet();
  const { network } = useChain();
  const [buying, setBuying] = useState<Offer | null>(null);
  const [chain, setChain] = useState<SwapChain | "">("");
  const shown = (offers.data ?? []).filter((o) => (!chain || o.payment.chain === chain) && o.available.planck > 0n);
  // The best price first: one asset of one chain at a time compares.
  shown.sort((a, b) => a.payment.chain.localeCompare(b.payment.chain) || a.payment.asset.localeCompare(b.payment.asset) || (a.price < b.price ? -1 : a.price > b.price ? 1 : 0));

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <Card>
        <CardHeader
          title="Offers"
          icon={<Store size={16} />}
          action={
            <select value={chain} onChange={(e) => setChain(e.target.value as SwapChain | "")} className="h-8 rounded-lg border border-line bg-surface px-2 text-xs">
              <option value="">Every chain</option>
              {evmNetworksOf(network).map((n) => (
                <option key={n.chain} value={n.chain}>
                  {n.name}
                </option>
              ))}
            </select>
          }
        />
        {offers.error ? (
          <OffersError error={offers.error} />
        ) : !offers.data ? (
          <SkeletonRows rows={3} />
        ) : shown.length === 0 ? (
          <EmptyState title="No offer">Makers sell TESS from the Sell tab, or with the command line wallet.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((o) => (
              <OfferRow key={o.id} offer={o} own={o.maker === active?.address} onBuy={() => setBuying(o)} />
            ))}
          </ul>
        )}
      </Card>
      <div className="space-y-4">
        <Purchases />
        <Card className="p-4 text-sm text-muted sm:p-5">
          Atomic swaps: the payment and the TESS are each locked on their chain by the same secret. Either both sides are paid, or both return to their owners; no one holds your funds in
          between.
        </Card>
      </div>
      {buying && <BuySheet offer={buying} onClose={() => setBuying(null)} />}
    </div>
  );
}

const BITCOIN_ADDRESS = /^(bc1|tb1|bcrt1)[02-9ac-hj-np-z]{8,87}$|^[13mn2][1-9A-HJ-NP-Za-km-z]{25,34}$/;

function OfferSheet({ onClose }: { onClose: () => void }) {
  const { network } = useChain();
  const { active } = useWallet();
  const market = useMarket();
  const tx = useTransaction();
  const chains = evmNetworksOf(network);
  const bitcoinName = useChainName("Bitcoin");
  const [chain, setChain] = useState<SwapChain>("Base");
  const [asset, setAsset] = useState<SwapAsset>("Usdc");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [min, setMin] = useState("1");
  const [payout, setPayout] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  const bitcoin = chain === "Bitcoin";
  const evm = chains.find((n) => n.chain === chain);
  const assets = bitcoin ? (["Native"] as SwapAsset[]) : (["Native", "Usdc", "Usdt"] as SwapAsset[]).filter((a) => tokenOf(evm!, a) !== undefined);
  const payment: Payment = { chain, asset: assets.includes(asset) ? asset : "Native" };
  const parsedPrice = units(price, paymentDecimals(payment));
  const parsedAmount = parseAmount(amount, { min: 1n });
  const parsedMin = parseAmount(min, { min: 1n });
  const payoutOk = bitcoin ? !payout.trim() || BITCOIN_ADDRESS.test(payout.trim()) : /^0x[0-9a-fA-F]{40}$/.test(payout.trim());
  const errors = {
    price: parsedPrice.error ?? (parsedPrice.value === 0n ? "The price must be above zero" : undefined),
    amount: !amount ? "Enter an amount" : parsedAmount.error,
    min: parsedMin.error ?? (parsedMin.amount && parsedAmount.amount && parsedMin.amount.planck > parsedAmount.amount.planck ? "Above the amount offered" : undefined),
    payout: payoutOk ? undefined : bitcoin ? "A Bitcoin address" : "An EVM address: 0x and 40 digits",
  };

  const fromWallet = async () => {
    setConnectError(undefined);
    try {
      setPayout(bitcoin ? (await connectBitcoin(bitcoinNetworkOf(network))).address : (await connectEvm(evm!)).address);
    } catch (e) {
      setConnectError(explainError(e));
    }
  };

  const review = () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean) || !parsedPrice.value || !parsedAmount.amount || !parsedMin.amount) return;
    const terms = { payment, price: parsedPrice.value, amount: parsedAmount.amount, minFill: parsedMin.amount };
    const address = payout.trim();
    tx({
      title: "Offer TESS",
      summary: (
        <>
          {formatTess(terms.amount.planck, 4)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["Price", `${priceText(payment, terms.price)} per TESS`],
        ["Paid on", bitcoin ? bitcoinName : evm!.name],
        ["Paid to", bitcoin ? (address ? `${address}, once collected` : "The Bitcoin key of this account") : address],
        ["Smallest trade", `${formatTess(terms.minFill.planck, 4)} TESS`],
      ],
      warning: bitcoin
        ? "Payments in BTC are locked to a Bitcoin key this wallet derives from the account: its maker fills them and collects them by itself, while it runs. The TESS are held until sold or withdrawn."
        : "The TESS are held until sold or withdrawn. Trades are filled while a maker runs: here, with this wallet open, or with the command line wallet.",
      // The payout of an offer in BTC: the maker key of the account, which claims the payments.
      operation: (c: TesseraxClient, key: Keypair) => c.swaps.createOffer(key, { ...terms, payout: bitcoin ? makerKey(key.seed()).publicKey : unhex(address) }),
      onDone: () => {
        if (bitcoin && address && active) void market.maker.setBitcoinAddress(active.name, address);
        onClose();
      },
    });
  };

  return (
    <Sheet title="Sell TESS" icon={<Plus size={18} />} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select
            label="Paid on"
            value={chain}
            onChange={(v) => {
              setChain(v as SwapChain);
              setPayout("");
            }}
            options={[{ value: "Bitcoin", label: bitcoinName }, ...chains.map((n) => ({ value: n.chain, label: n.name }))]}
          />
          <Select label="In" value={payment.asset} onChange={(v) => setAsset(v as SwapAsset)} options={assets.map((a) => ({ value: a, label: bitcoin ? "BTC" : ASSET_NAMES[a] }))} />
        </div>
        <TextInput label={`Price of one TESS, in ${paymentSymbol(payment)}`} value={price} onChange={(e) => setPrice(e.target.value)} placeholder={bitcoin ? "0.000002" : "0.05"} inputMode="decimal" error={submitted ? errors.price : null} />
        <AmountInput label="TESS offered" value={amount} onChange={setAmount} error={submitted ? (errors.amount ?? null) : null} hint={active ? <>From {active.name}</> : undefined} />
        <AmountInput label="Smallest trade, in TESS" value={min} onChange={setMin} error={submitted ? (errors.min ?? null) : null} />
        <div>
          <TextInput
            label={bitcoin ? "Bitcoin address paid, optional" : "EVM address paid"}
            value={payout}
            onChange={(e) => setPayout(e.target.value)}
            placeholder={bitcoin ? "bc1…, or the key of this account" : "0x…"}
            mono
            error={submitted ? (errors.payout ?? null) : null}
          />
          {(bitcoin || browserWallet()) && (
            <button onClick={fromWallet} className="mt-1.5 text-xs font-medium text-accent">
              Use the address of my {bitcoin ? "Bitcoin" : "EVM"} wallet
            </button>
          )}
          {connectError && <p className="mt-1.5 text-xs text-danger">{connectError}</p>}
        </div>
        <p className="text-xs text-muted">
          A payment rounds up to the smallest unit of {paymentSymbol(payment)}: {paymentDecimals(payment)} decimals.
        </p>
        <Button className="w-full" onClick={review}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

function MakerCard() {
  const { active } = useWallet();
  const { network } = useChain();
  const market = useMarket();
  const maker = market.maker;
  const running = maker.account !== undefined;
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const collect = Object.entries(maker.state?.collect ?? {});
  const waiting = Object.keys(maker.state?.trades ?? {}).length;

  const onCollect = async (trade: string) => {
    setBusy(trade);
    setError(undefined);
    try {
      await maker.collect(trade);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(undefined);
    }
  };

  return (
    <Card>
      <CardHeader
        title="Maker"
        icon={<ArrowLeftRight size={16} />}
        action={running ? <Badge tone="success">Running for {maker.account}</Badge> : <Badge>Stopped</Badge>}
      />
      <div className="space-y-4 p-4 sm:p-5">
        <p className="text-sm text-muted">
          While it runs, the wallet fills your offers for the payments locked for them, and takes back the trades that expired. Payments in BTC are collected by
          the maker itself. Keep this tab open; for a maker that never sleeps, run <span className="font-mono text-xs">tesserax-wallet swap make</span>.
        </p>
        {running ? (
          <Button variant="secondary" className="w-full" onClick={maker.stop}>
            <Square size={14} /> Stop the maker
          </Button>
        ) : (
          <Button className="w-full" onClick={() => active && maker.start(active.name)} disabled={!active}>
            <Play size={14} /> Run the maker of {active?.name}
          </Button>
        )}
        {waiting > 0 && <p className="text-xs text-muted">{waiting} trade{waiting > 1 ? "s" : ""} waiting for the claim of the taker.</p>}
        {collect.length > 0 && (
          <div className="space-y-2">
            <div className="text-sm font-semibold">Payments to collect</div>
            {collect.map(([trade, c]) => (
              <div key={trade} className="flex items-center justify-between gap-3 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <span>
                  Trade #{trade} · {chainName(network, c.chain)}
                  {c.deadline !== undefined && <span className="block text-xs text-warning">Before its lock expires, {hoursLeft(c.deadline)}</span>}
                </span>
                {c.chain === "Bitcoin" ? (
                  <span className="text-xs text-muted">Collected by the maker</span>
                ) : (
                  <Button size="sm" busy={busy === trade} onClick={() => onCollect(trade)} disabled={!browserWallet()}>
                    Collect
                  </Button>
                )}
              </div>
            ))}
            {!browserWallet() && <NoBrowserWallet />}
          </div>
        )}
        {error && <p className="rounded-xl bg-danger-soft px-3 py-2.5 text-sm text-danger">{error}</p>}
        {maker.activity.length > 0 && (
          <ul className="max-h-56 space-y-1.5 overflow-y-auto border-t border-line pt-3 text-xs">
            {maker.activity.map((a, i) => (
              <li key={`${a.at}-${i}`} className={cx(a.tone === "success" ? "text-success" : a.tone === "danger" ? "text-danger" : "text-muted")}>
                <span className="text-faint">{new Date(a.at).toLocaleTimeString()}</span> {a.text}
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}

/** The chain has no bids before the runtime upgrade that brings them. */
class NoBids extends Error {}

function useBids() {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["bids", url],
    queryFn: async () => {
      try {
        return await client.swaps.bids();
      } catch (error) {
        if (/Bids|Swaps/.test(String((error as Error).message))) throw new NoBids();
        throw error;
      }
    },
    refetchInterval: 18_000,
    retry: (count, error) => !(error instanceof NoBids) && count < 1,
  });
}

function BidRow({ bid, own, supported, onSell }: { bid: Bid; own: boolean; supported: boolean; onSell: () => void }) {
  const chainName = useChainName(bid.payment.chain);
  return (
    <li className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span className="font-semibold tabular">{priceText(bid.payment, bid.price)}</span>
          <span className="text-sm text-muted">
            per TESS, for <span className="font-medium text-fg tabular">{formatTess(bid.wanted.planck, 2)} TESS</span>
          </span>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          <Badge>{chainName}</Badge>
          <span>from {formatTess(bid.minSale.planck, 2)} TESS</span>
          <span>
            {bid.completed}/{bid.sales} sales paid
          </span>
          <span className="inline-flex items-center gap-1">
            by <AddressLink address={bid.buyer} />
          </span>
        </div>
      </div>
      {own ? (
        <Badge tone="accent">Your bid</Badge>
      ) : (
        <Button size="sm" onClick={onSell} disabled={!supported}>
          Sell
        </Button>
      )}
    </li>
  );
}

function BidsCard({ bids }: { bids: ReturnType<typeof useBids> }) {
  const { active } = useWallet();
  const { network } = useChain();
  const bitcoinName = useChainName("Bitcoin");
  const [selling, setSelling] = useState<Bid | null>(null);
  const [chain, setChain] = useState<SwapChain | "">("");
  const shown = (bids.data ?? []).filter((b) => (!chain || b.payment.chain === chain) && b.wanted.planck > 0n);
  // The best price first: one asset of one chain at a time compares.
  shown.sort((a, b) => a.payment.chain.localeCompare(b.payment.chain) || a.payment.asset.localeCompare(b.payment.asset) || (a.price > b.price ? -1 : a.price < b.price ? 1 : 0));

  return (
    <>
      <Card>
        <CardHeader
          title="Bids"
          icon={<HandCoins size={16} />}
          action={
            <select value={chain} onChange={(e) => setChain(e.target.value as SwapChain | "")} className="h-8 rounded-lg border border-line bg-surface px-2 text-xs">
              <option value="">Every chain</option>
              <option value="Bitcoin">{bitcoinName}</option>
              {evmNetworksOf(network).map((n) => (
                <option key={n.chain} value={n.chain}>
                  {n.name}
                </option>
              ))}
            </select>
          }
        />
        {bids.error ? (
          <ErrorState error={bids.error} />
        ) : !bids.data ? (
          <SkeletonRows rows={3} />
        ) : shown.length === 0 ? (
          <EmptyState title="No bid">Buyers bid for TESS with the command line wallet. Sell into a bid at once, without waiting for a buyer.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((b) => (
              <BidRow
                key={b.id}
                bid={b}
                own={b.buyer === active?.address}
                supported={b.payment.chain === "Bitcoin" || evmNetworkOf(network, b.payment.chain) !== undefined}
                onSell={() => setSelling(b)}
              />
            ))}
          </ul>
        )}
      </Card>
      {selling && <SaleSheet bid={selling} onClose={() => setSelling(null)} />}
    </>
  );
}

function SaleSheet({ bid, onClose }: { bid: Bid; onClose: () => void }) {
  const { network } = useChain();
  const wallet = useWallet();
  const { active } = wallet;
  const market = useMarket();
  const tx = useTransaction();
  const balance = useBalance(active?.address).data;
  const bitcoin = bid.payment.chain === "Bitcoin";
  const evm = evmNetworkOf(network, bid.payment.chain);
  const chainName = useChainName(bid.payment.chain);
  const symbol = paymentSymbol(bid.payment);
  const decimals = paymentDecimals(bid.payment);
  const [amount, setAmount] = useState("");
  const [payout, setPayout] = useState("");
  const [destination, setDestination] = useState(market.maker.state?.bitcoinAddress ?? "");
  const [submitted, setSubmitted] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  const [made, setMade] = useState<string>();
  // The Bitcoin key of the account: the buyer locks the payment to it, and this wallet claims it.
  const bitcoinKey = useQuery({
    queryKey: ["bitcoin-key", active?.address],
    queryFn: async () => makerKey((await wallet.keypair(active!.name)).seed()).publicKey,
    enabled: bitcoin && Boolean(active),
    staleTime: Infinity,
  }).data;

  // The address of the EVM wallet, if it is connected already.
  useEffect(() => {
    const provider = browserWallet();
    if (bitcoin || !provider) return;
    provider
      .request({ method: "eth_accounts" })
      .then(([address]) => address && setPayout((p) => p || address))
      .catch(() => {});
  }, [bitcoin]);

  const parsed = parseAmount(amount);
  const transferable = balance?.transferable.planck;
  const max = transferable === undefined || transferable >= bid.wanted.planck ? bid.wanted : new Amount(transferable);
  let invalid: string | null = !amount ? "Enter an amount" : (parsed.error ?? null);
  if (!invalid && parsed.amount) {
    if (parsed.amount.planck > bid.wanted.planck) invalid = `This bid wants ${formatTess(bid.wanted.planck, 4)} TESS`;
    else if (parsed.amount.planck < bid.minSale.planck && parsed.amount.planck !== bid.wanted.planck) invalid = `This bid buys at least ${formatTess(bid.minSale.planck, 4)} TESS`;
    else if (transferable !== undefined && parsed.amount.planck > transferable) invalid = "More than the transferable TESS of the account";
  }
  const due = parsed.amount ? paymentDue(parsed.amount.planck, bid.price) : undefined;
  const payoutError = bitcoin
    ? destination.trim() && !BITCOIN_ADDRESS.test(destination.trim())
      ? "A Bitcoin address"
      : undefined
    : /^0x[0-9a-fA-F]{40}$/.test(payout.trim())
      ? undefined
      : "An EVM address: 0x and 40 digits";
  const keyAddress = bitcoinKey ? addressOfKey(bitcoinKey, bitcoinNetworkOf(network)) : undefined;
  const ready = bitcoin ? Boolean(bitcoinKey) : Boolean(evm && browserWallet());

  const fromWallet = async () => {
    setConnectError(undefined);
    try {
      if (bitcoin) setDestination((await connectBitcoin(bitcoinNetworkOf(network))).address);
      else setPayout((await connectEvm(evm!)).address);
    } catch (e) {
      setConnectError(explainError(e));
    }
  };

  const review = () => {
    setSubmitted(true);
    if (invalid || payoutError || !parsed.amount || !active || !ready) return;
    const sold = parsed.amount;
    const paidTo = bitcoin ? bitcoinKey! : unhex(payout.trim());
    const address = destination.trim();
    const account = active.name;
    const dueText = `${decimal(paymentDue(sold.planck, bid.price), decimals)} ${symbol}`;
    tx({
      title: `Sell TESS to bid #${bid.id}`,
      account,
      summary: (
        <>
          {formatTess(sold.planck, 4)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["You receive", `${dueText} on ${chainName}`],
        ["Price", `${priceText(bid.payment, bid.price)} per TESS`],
        ["Paid to", bitcoin ? `${address || keyAddress}, once claimed` : payout.trim()],
        ["Buyer", <AddressLink address={bid.buyer} />],
      ],
      warning: `Your TESS are held for the buyer for 24 hours. The buyer locks ${dueText} for you; this wallet checks the payment and claims it${
        bitcoin ? "" : " through your EVM wallet"
      }, and only that hands the TESS over. If the buyer does not pay, or pays wrong, nothing is claimed and you take the TESS back after 24 hours. Keep the wallet open until paid.`,
      // The sale saves its secret first: its fee is estimated without it.
      fee: async (c) => {
        const key = await wallet.keypair(account);
        return estimateFee(c, (estimating) => estimating.swaps.sell(key, bid.id, { amount: sold, hash: new Uint8Array(32), payout: paidTo }), key);
      },
      operation: (c: TesseraxClient, key: Keypair) => market.sell(c, key, bid, sold, account, paidTo, bitcoin ? address : undefined),
      onDone: (result) => setMade((result as StoredSale).id),
    });
  };

  const sale = market.sales.find((s) => s.id === made);
  return (
    <Sheet title={`Sell TESS to bid #${bid.id}`} icon={<HandCoins size={18} />} onClose={onClose}>
      {made ? (
        <div className="space-y-5">
          {sale ? <SaleProgress sale={sale} /> : <SkeletonRows rows={3} />}
          <p className="text-xs text-muted">You can close this: the wallet goes on while it is open, and shows the sale in Your sales.</p>
          <Button variant="secondary" className="w-full" onClick={onClose}>
            Close
          </Button>
        </div>
      ) : (
        <div className="space-y-5">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="text-xs text-muted">Price</div>
              <div className="mt-0.5 font-semibold tabular">
                {priceText(bid.payment, bid.price)} <span className="font-normal text-muted">/ TESS</span>
              </div>
            </div>
            <div className="rounded-xl bg-surface-2 p-3">
              <div className="text-xs text-muted">Paid on</div>
              <div className="mt-0.5 font-semibold">{chainName}</div>
            </div>
          </div>
          <AmountInput
            label="TESS to sell"
            value={amount}
            onChange={setAmount}
            max={max}
            error={submitted ? invalid : null}
            hint={<>From {formatTess(bid.minSale.planck, 4)} to {formatTess(bid.wanted.planck, 4)} TESS</>}
          />
          <div className="rounded-xl border border-line p-3 text-sm">
            <div className="flex justify-between gap-3">
              <span className="text-muted">You receive</span>
              <span className="font-semibold tabular">{due !== undefined ? `${decimal(due, decimals)} ${symbol}` : "…"}</span>
            </div>
            <div className="mt-1.5 flex justify-between gap-3">
              <span className="text-muted">TESS from</span>
              <span className="font-medium">{active?.name}</span>
            </div>
            <div className="mt-1.5 flex justify-between gap-3">
              <span className="text-muted">Buyer</span>
              <span className="font-medium">
                {bid.completed}/{bid.sales} sales paid
              </span>
            </div>
          </div>
          {bitcoin ? (
            <div>
              <TextInput
                label="Bitcoin address paid, optional"
                value={destination}
                onChange={(e) => setDestination(e.target.value)}
                placeholder={keyAddress ?? "bc1…"}
                mono
                error={submitted ? (payoutError ?? null) : null}
                hint={<>The payment is locked to the Bitcoin key of this account; once claimed, it goes to this address, or to the one of the key.</>}
              />
              <button onClick={fromWallet} className="mt-1.5 text-xs font-medium text-accent">
                Use the address of my Bitcoin wallet
              </button>
              {connectError && <p className="mt-1.5 text-xs text-danger">{connectError}</p>}
            </div>
          ) : (
            <div>
              <TextInput label="EVM address paid" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x…" mono error={submitted ? (payoutError ?? null) : null} />
              {browserWallet() && (
                <button onClick={fromWallet} className="mt-1.5 text-xs font-medium text-accent">
                  Use the address of my EVM wallet
                </button>
              )}
              {connectError && <p className="mt-1.5 text-xs text-danger">{connectError}</p>}
            </div>
          )}
          <ol className="space-y-1.5 text-xs text-muted">
            <li>1. Your TESS are held for the buyer, for 24 hours.</li>
            <li>
              2. The buyer locks {due !== undefined ? `${decimal(due, decimals)} ${symbol}` : "the payment"} for you on {chainName}, for 6 hours.
            </li>
            <li>
              3. This wallet checks it{bitcoin ? " after 2 confirmations, about 20 minutes," : ""} and claims it with a secret only it knows{bitcoin ? "" : ", through your EVM wallet"}.
            </li>
            <li>4. The secret, public then, hands the TESS to the buyer. If the buyer never pays, nothing is claimed and you take the TESS back after 24 hours.</li>
          </ol>
          {!bitcoin && evm && (
            <p className="rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">
              The claim is a transaction of your EVM wallet on {chainName}: keep a little {evm.nativeCurrency.symbol} there for its gas.
            </p>
          )}
          {!bitcoin && !browserWallet() && <NoBrowserWallet />}
          <Button className="w-full" onClick={review} disabled={!ready}>
            Review the sale
          </Button>
        </div>
      )}
    </Sheet>
  );
}

const SALE_STATUS: Record<SaleStatus, { label: string; tone: "neutral" | "accent" | "success" | "warning" | "danger" }> = {
  selling: { label: "Selling", tone: "neutral" },
  waiting: { label: "Waiting for payment", tone: "accent" },
  paid: { label: "Checking the payment", tone: "accent" },
  verified: { label: "Payment found", tone: "accent" },
  claiming: { label: "Claiming", tone: "accent" },
  collected: { label: "Paid", tone: "success" },
  done: { label: "Paid", tone: "success" },
  refused: { label: "Payment refused", tone: "danger" },
  expired: { label: "To take back", tone: "warning" },
  refunded: { label: "Taken back", tone: "neutral" },
  failed: { label: "Not sold", tone: "danger" },
};

/** Sales the wallet is working on. */
const SALE_RUNNING = new Set<SaleStatus>(["selling", "waiting", "paid", "verified", "claiming", "collected"]);

/** The step a sale is at: locking, payment, check, claim, delivery, done. */
function saleStage(s: StoredSale): number {
  switch (s.status) {
    case "selling":
    case "failed":
      return 0;
    case "waiting":
      return 1;
    case "paid":
    case "refused":
      return 2;
    case "verified":
    case "claiming":
      return 3;
    case "collected":
      return 4;
    case "done":
      return 5;
    default:
      return s.lock ? 2 : 1;
  }
}

const saleDue = (s: StoredSale) => {
  const payment = { chain: s.chain, asset: s.asset };
  return `${decimal(BigInt(s.payment), paymentDecimals(payment))} ${paymentSymbol(payment)}`;
};

function SaleProgress({ sale }: { sale: StoredSale }) {
  const chainName = useChainName(sale.chain);
  const stage = saleStage(sale);
  const running = SALE_RUNNING.has(sale.status);
  const steps = [
    `Lock ${formatTess(BigInt(sale.amount), 4)} TESS for the buyer`,
    `The buyer locks ${saleDue(sale)} for you on ${chainName}`,
    "Check the payment",
    "Claim the payment",
    "Hand the TESS to the buyer",
  ];
  return (
    <div className="space-y-4">
      <ol className="space-y-2.5 text-sm">
        {steps.map((text, i) => (
          <li key={i} className={cx("flex items-center gap-2.5", i > stage && "text-muted")}>
            {i < stage ? (
              <CircleCheck size={16} className="shrink-0 text-success" />
            ) : i === stage && running ? (
              <Loader2 size={16} className="shrink-0 animate-spin text-accent" />
            ) : i === stage ? (
              <CircleAlert size={16} className="shrink-0 text-danger" />
            ) : (
              <Circle size={16} className="shrink-0 text-faint" />
            )}
            {text}
          </li>
        ))}
      </ol>
      <SaleActions sale={sale} />
    </div>
  );
}

/** What a sale waits for, and what the user can do about it. */
function SaleActions({ sale }: { sale: StoredSale }) {
  const { network } = useChain();
  const market = useMarket();
  const tx = useTransaction();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const bitcoin = sale.chain === "Bitcoin";
  const claimUrl = sale.claim ? (bitcoin ? bitcoinTxUrl(bitcoinNetworkOf(network), sale.claim) : evmTxUrl(evmNetworkOf(network, sale.chain), sale.claim)) : undefined;

  const claim = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await market.claimSale(sale);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setBusy(false);
    }
  };

  const takeBack = () =>
    tx({
      title: `Take back sale #${sale.sale}`,
      account: sale.account,
      details: [["Returned", `${formatTess(BigInt(sale.amount), 4)} TESS`]],
      operation: (c: TesseraxClient, key: Keypair) => c.swaps.refundSale(key, sale.sale!),
      onDone: () => void market.saleRefunded(sale),
    });

  return (
    <div className="space-y-2">
      {sale.status === "waiting" && <p className="text-xs text-muted">The buyer locks the payment, usually within minutes. If it does not, the TESS can be taken back {hoursLeft(sale.deadline)}.</p>}
      {sale.status === "verified" && !bitcoin && !sale.note && <p className="text-xs text-muted">Confirm the claim in your EVM wallet, before its lock expires {hoursLeft(sale.lockDeadline)}.</p>}
      {sale.status === "collected" && <p className="text-xs text-muted">Payment claimed. The TESS go to the buyer.</p>}
      {sale.note && <p className={cx("text-xs", sale.status === "refused" || sale.status === "failed" ? "text-danger" : sale.status === "paid" ? "text-muted" : "text-warning")}>{sale.note}</p>}
      {sale.status === "refused" && <p className="text-xs text-muted">They can be taken back {hoursLeft(sale.deadline)}.</p>}
      {claimUrl && (
        <a href={claimUrl} target="_blank" rel="noreferrer" className="text-xs text-accent underline">
          See the claim of the payment
        </a>
      )}
      {sale.status === "verified" && !bitcoin && (
        <Button size="sm" busy={busy} onClick={claim} disabled={!browserWallet()}>
          <Wallet size={14} /> Claim {saleDue(sale)} with my EVM wallet
        </Button>
      )}
      {sale.status === "expired" && (
        <Button size="sm" variant="secondary" onClick={takeBack}>
          Take back the TESS
        </Button>
      )}
      {error && <p className="rounded-xl bg-danger-soft px-3 py-2.5 text-xs text-danger">{error}</p>}
    </div>
  );
}

function Sales() {
  const market = useMarket();
  const shown = market.sales.filter((s) => s.status !== "failed" || Date.now() - s.createdAt < 86_400_000);
  return (
    <Card>
      <CardHeader title="Your sales" icon={<Clock size={16} />} />
      {shown.length === 0 ? (
        <p className="p-4 text-sm text-muted sm:p-5">No sale yet.</p>
      ) : (
        <ul className="divide-y divide-line">
          {shown.map((s) => {
            const status = SALE_STATUS[s.status];
            return (
              <li key={s.id} className="space-y-2 px-4 py-3.5 sm:px-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm">
                    <span className="font-semibold tabular">{formatTess(BigInt(s.amount), 4)} TESS</span>
                    <span className="text-muted">
                      {" "}
                      for {saleDue(s)} · {s.account} · {timeAgo(new Date(s.createdAt))}
                    </span>
                  </span>
                  <Badge tone={status.tone}>{status.label}</Badge>
                </div>
                <SaleActions sale={s} />
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

function SellTab() {
  const offers = useOffers();
  const bids = useBids();
  const market = useMarket();
  const { active } = useWallet();
  const { network } = useChain();
  const tx = useTransaction();
  const [creating, setCreating] = useState(false);
  const mine = (offers.data ?? []).filter((o) => o.maker === active?.address);
  // Bids come with a runtime upgrade: without them, only offers.
  const withBids = !(bids.error instanceof NoBids);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
      <div className="min-w-0 space-y-5">
        {withBids && <BidsCard bids={bids} />}
        <Card>
          <CardHeader
            title="Your offers"
            icon={<Store size={16} />}
            action={
              <Button size="sm" onClick={() => setCreating(true)}>
                <Plus size={14} /> New offer
              </Button>
            }
          />
          {offers.error ? (
            <OffersError error={offers.error} />
          ) : !offers.data ? (
            <SkeletonRows rows={2} />
          ) : mine.length === 0 ? (
            <EmptyState title="No offer">Offer TESS for ETH, USDC or USDT: buyers lock their payment, and the maker of this wallet fills it.</EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {mine.map((o) => (
                <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
                  <div className="text-sm">
                    <div>
                      <span className="font-semibold">#{o.id}</span> · <span className="tabular">{formatTess(o.available.planck, 4)} TESS</span> at {priceText(o.payment, o.price)} on{" "}
                      {chainName(network, o.payment.chain)}
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      Paid to <span className="font-mono">{hex(o.payout)}</span> · {o.completed}/{o.fills} trades completed
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      tx({
                        title: `Withdraw offer #${o.id}`,
                        details: [["Returned", `${formatTess(o.available.planck, 4)} TESS, and the deposit of the offer`]],
                        warning: "Trades already filled go on: their TESS stay locked until claimed or expired.",
                        operation: (c: TesseraxClient, key: Keypair) => c.swaps.cancelOffer(key, o.id),
                      })
                    }
                  >
                    Withdraw
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
      <div className="space-y-5">
        {(withBids || market.sales.length > 0) && <Sales />}
        <MakerCard />
      </div>
      {creating && <OfferSheet onClose={() => setCreating(false)} />}
    </div>
  );
}

export function Market() {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const { network } = useChain();
  const testnets = network.id !== "mainnet";
  let note: ReactNode = null;
  if (network.evmLocalUrl) note = <Badge tone="warning">Local EVM chain</Badge>;
  else if (testnets) note = <Badge tone="warning">Paid on EVM testnets</Badge>;
  return (
    <Page>
      <PageHeader title="Market" icon={<ArrowLeftRight size={20} />} subtitle="TESS for BTC, and for ETH, USDC and USDT on Ethereum, Base and Arbitrum, by atomic swaps.">
        {note}
      </PageHeader>
      <div className="mb-5">
        <Tabs
          tabs={[
            { id: "buy", label: "Buy TESS" },
            { id: "sell", label: "Sell TESS" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>
      {tab === "buy" ? <BuyTab /> : <SellTab />}
      <p className="mt-6 flex items-center gap-1.5 text-xs text-faint">
        <ExternalLink size={12} /> Payments are signed by your Bitcoin or EVM wallet; their keys never reach Tesserax.
      </p>
    </Page>
  );
}
