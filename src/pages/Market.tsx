import {
  paymentDecimals,
  paymentDue,
  paymentSymbol,
  tokenOf,
  type Keypair,
  type Offer,
  type Payment,
  type SwapAsset,
  type SwapChain,
  type TesseraxClient,
} from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeftRight, CircleCheck, Clock, Coins, ExternalLink, Play, Plus, Square, Store, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AmountInput, Button, parseAmount, Select, TextInput } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink } from "../components/links";
import { Sheet } from "../components/Sheet";
import { explainError, useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, cx, EmptyState, ErrorState, PageHeader, SkeletonRows, Tabs } from "../components/ui";
import { bitcoinNetworkOf, bitcoinTxUrl, bitcoinWallets } from "../lib/bitcoin";
import { useChain } from "../lib/chain";
import { browserWallet, connectEvm, decimal, evmNetworkOf, evmNetworksOf, evmTxUrl, hex, unhex, units } from "../lib/evm";
import { formatTess, timeAgo } from "../lib/format";
import { useWallet } from "../lib/session";
import type { StoredPurchase } from "../lib/storage";
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

/** The name of the chain an offer is paid on, on this network. */
function useChainName(chain: SwapChain): string {
  const { network } = useChain();
  if (chain === "Bitcoin") return network.id === "mainnet" ? "Bitcoin" : network.bitcoinNetwork === "regtest" ? "Bitcoin regtest" : "Bitcoin testnet4";
  return evmNetworkOf(network, chain)?.name ?? chain;
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

function OfferSheet({ onClose }: { onClose: () => void }) {
  const { network } = useChain();
  const { active } = useWallet();
  const tx = useTransaction();
  const chains = evmNetworksOf(network);
  const [chain, setChain] = useState<SwapChain>("Base");
  const [asset, setAsset] = useState<SwapAsset>("Usdc");
  const [price, setPrice] = useState("");
  const [amount, setAmount] = useState("");
  const [min, setMin] = useState("1");
  const [payout, setPayout] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [connectError, setConnectError] = useState<string>();
  const evm = chains.find((n) => n.chain === chain)!;
  const assets = (["Native", "Usdc", "Usdt"] as SwapAsset[]).filter((a) => tokenOf(evm, a) !== undefined);
  const payment: Payment = { chain, asset: assets.includes(asset) ? asset : "Native" };
  const parsedPrice = units(price, paymentDecimals(payment));
  const parsedAmount = parseAmount(amount, { min: 1n });
  const parsedMin = parseAmount(min, { min: 1n });
  const payoutOk = /^0x[0-9a-fA-F]{40}$/.test(payout.trim());
  const errors = {
    price: parsedPrice.error ?? (parsedPrice.value === 0n ? "The price must be above zero" : undefined),
    amount: !amount ? "Enter an amount" : parsedAmount.error,
    min: parsedMin.error ?? (parsedMin.amount && parsedAmount.amount && parsedMin.amount.planck > parsedAmount.amount.planck ? "Above the amount offered" : undefined),
    payout: payoutOk ? undefined : "An EVM address: 0x and 40 digits",
  };

  const fromWallet = async () => {
    setConnectError(undefined);
    try {
      setPayout((await connectEvm(evm)).address);
    } catch (e) {
      setConnectError(explainError(e));
    }
  };

  const review = () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean) || !parsedPrice.value || !parsedAmount.amount || !parsedMin.amount) return;
    const offer = { payment, price: parsedPrice.value, amount: parsedAmount.amount, minFill: parsedMin.amount, payout: unhex(payout) };
    tx({
      title: "Offer TESS",
      summary: (
        <>
          {formatTess(offer.amount.planck, 4)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["Price", `${priceText(payment, offer.price)} per TESS`],
        ["Paid on", evm.name],
        ["Paid to", payout.trim()],
        ["Smallest trade", `${formatTess(offer.minFill.planck, 4)} TESS`],
      ],
      warning: "The TESS are held until sold or withdrawn. Trades are filled while a maker runs: here, with this wallet open, or with the command line wallet.",
      operation: (c: TesseraxClient, key: Keypair) => c.swaps.createOffer(key, offer),
      onDone: onClose,
    });
  };

  return (
    <Sheet title="Sell TESS" icon={<Plus size={18} />} onClose={onClose}>
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Select label="Paid on" value={chain} onChange={(v) => setChain(v as SwapChain)} options={chains.map((n) => ({ value: n.chain, label: n.name }))} />
          <Select label="In" value={payment.asset} onChange={(v) => setAsset(v as SwapAsset)} options={assets.map((a) => ({ value: a, label: ASSET_NAMES[a] }))} />
        </div>
        <TextInput label={`Price of one TESS, in ${paymentSymbol(payment)}`} value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.05" inputMode="decimal" error={submitted ? errors.price : null} />
        <AmountInput label="TESS offered" value={amount} onChange={setAmount} error={submitted ? (errors.amount ?? null) : null} hint={active ? <>From {active.name}</> : undefined} />
        <AmountInput label="Smallest trade, in TESS" value={min} onChange={setMin} error={submitted ? (errors.min ?? null) : null} />
        <div>
          <TextInput label="EVM address paid" value={payout} onChange={(e) => setPayout(e.target.value)} placeholder="0x…" mono error={submitted ? (errors.payout ?? null) : null} />
          {browserWallet() && (
            <button onClick={fromWallet} className="mt-1.5 text-xs font-medium text-accent">
              Use the address of my EVM wallet
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
          While it runs, the wallet fills your offers for the payments locked for them, and takes back the trades that expired. Keep this tab open; for a maker that never sleeps, or for
          offers paid in BTC, run <span className="font-mono text-xs">tesserax-wallet swap make</span>.
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
                  Trade #{trade} · {evmNetworkOf(network, c.chain)?.name}
                  {c.deadline !== undefined && <span className="block text-xs text-warning">Before its lock expires, {hoursLeft(c.deadline)}</span>}
                </span>
                <Button size="sm" busy={busy === trade} onClick={() => onCollect(trade)} disabled={!browserWallet()}>
                  Collect
                </Button>
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

function SellTab() {
  const offers = useOffers();
  const { active } = useWallet();
  const { network } = useChain();
  const tx = useTransaction();
  const [creating, setCreating] = useState(false);
  const mine = (offers.data ?? []).filter((o) => o.maker === active?.address);

  return (
    <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
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
                    {evmNetworkOf(network, o.payment.chain)?.name}
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
      <MakerCard />
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
