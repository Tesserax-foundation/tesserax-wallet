import type { Keypair, TesseraxClient } from "@tesserax/sdk";
import { ArrowDownLeft, ArrowUpRight, Bot, CircleAlert, Coins, Copy, Droplets, Lock, ScrollText, ShieldAlert, Users, Zap } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router";
import { encode } from "uqr";
import { AddressInput, AmountInput, Button, parseAmount } from "../components/forms";
import { PayWith } from "../components/PayWith";
import { Page } from "../components/Layout";
import { Amount as AmountText, AddressLink, ExplorerLink, Identicon, TimeAgo } from "../components/links";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, cx, EmptyState, ErrorState, Skeleton, SkeletonRows } from "../components/ui";
import { copyText } from "../lib/clipboard";
import { normalizeAddress, useBalance, useChain, useReceivedDelegations } from "../lib/chain";
import { callLabel, formatTess, humanize } from "../lib/format";
import { useActivity, useHistoryAvailable } from "../lib/history";
import { useWallet } from "../lib/session";

function BalanceCard() {
  const { active } = useWallet();
  // Faucet of the testnet, which gives test TESS; none on the mainnet.
  const { faucetUrl } = useChain().network;
  const { data, error, isLoading } = useBalance(active?.address);
  const total = data ? data.free.planck + data.reserved.planck : 0n;
  return (
    <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 sm:p-8">
      <div className="glow absolute inset-0" />
      <div className="relative">
        <div className="flex items-center gap-2 text-sm text-muted">
          <Coins size={16} /> Total balance
        </div>
        <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
          {isLoading ? (
            <Skeleton className="h-12 w-56" />
          ) : error ? (
            <span className="text-base text-danger">The node does not answer. Check it in the settings.</span>
          ) : (
            <>
              <span className="min-w-0 break-all text-[34px] font-bold leading-tight tracking-tight tabular sm:text-5xl">{formatTess(total, 4)}</span>
              <span className="text-lg font-semibold text-muted">TESS</span>
            </>
          )}
        </div>
        {data && (
          <div className="mt-5 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 [&>div]:min-w-0">
            <div>
              <div className="text-muted">Transferable</div>
              <div className="mt-0.5 truncate font-semibold tabular">{formatTess(data.transferable.planck, 4)}</div>
            </div>
            <div title="Deposits of an agent registration, channels and tasks, returned when they end">
              <div className="text-muted">Reserved</div>
              <div className="mt-0.5 truncate font-semibold tabular">{formatTess(data.reserved.planck, 4)}</div>
            </div>
            <div title="Locked by vesting or another lock">
              <div className="text-muted">Locked</div>
              <div className="mt-0.5 truncate font-semibold tabular">{formatTess(data.frozen.planck, 4)}</div>
            </div>
          </div>
        )}
        <div className="mt-6 grid grid-cols-2 gap-3 sm:flex">
          <Link to="/send" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-5 text-sm font-semibold text-white shadow-[0_6px_20px_-8px_var(--accent)] hover:bg-accent-strong">
            <ArrowUpRight size={18} /> Send
          </Link>
          <Link to="/receive" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 text-sm font-semibold hover:border-line-strong">
            <ArrowDownLeft size={18} /> Receive
          </Link>
          {faucetUrl && active && (
            <a
              href={`${faucetUrl}/#${active.address}`}
              target="_blank"
              rel="noreferrer noopener"
              className="col-span-2 inline-flex h-11 items-center justify-center gap-2 rounded-xl border border-line bg-surface px-5 text-sm font-semibold hover:border-line-strong sm:col-span-1"
            >
              <Droplets size={18} /> Get test TESS
            </a>
          )}
        </div>
      </div>
    </div>
  );
}

function Activity() {
  const { active } = useWallet();
  const { data, error, isLoading } = useActivity(active?.address);
  if (!useHistoryAvailable()) {
    return (
      <EmptyState title="History unavailable">
        This build has no explorer database for the history. <ExplorerLink path={`/account/${active?.address}`}>See the account in the explorer</ExplorerLink>
      </EmptyState>
    );
  }
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <SkeletonRows rows={5} />;
  if (!data?.length) return <EmptyState title="No activity yet">Receive TESS at your address to start.</EmptyState>;
  return (
    <ul className="divide-y divide-line">
      {data.map((item) => (
        <li key={`${item.blockNumber}-${item.kind}-${item.index}`} className="flex items-center gap-3 px-4 py-3.5 sm:px-5">
          <span
            className={cx(
              "flex size-10 shrink-0 items-center justify-center rounded-xl",
              item.kind === "received" ? "bg-success-soft text-success" : item.kind === "sent" ? "bg-accent-soft text-accent" : item.success === false ? "bg-danger-soft text-danger" : "bg-surface-3 text-muted",
            )}
          >
            {item.kind === "received" ? <ArrowDownLeft size={18} /> : item.kind === "sent" ? <ArrowUpRight size={18} /> : <ScrollText size={18} />}
          </span>
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium">
              {item.kind === "received" ? "Received" : item.kind === "sent" ? "Sent" : callLabel(item.pallet!, item.call!)}
              {item.success === false && <Badge tone="danger" className="ml-2">{item.error ? humanize(item.error.split(/[.:]+/).pop()!) : "Failed"}</Badge>}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted">
              {item.counterparty ? (
                <>
                  {item.kind === "sent" ? "to" : "from"} <AddressLink address={item.counterparty} />
                </>
              ) : (
                <span>Block #{item.blockNumber.toLocaleString("en-US")}</span>
              )}
            </div>
          </div>
          <div className="shrink-0 text-right">
            {item.amount ? (
              <div className={cx("text-sm font-semibold tabular", item.kind === "received" ? "text-success" : "")}>
                {item.kind === "received" ? "+" : "−"}
                {formatTess(item.amount, 4)} TESS
              </div>
            ) : item.fee ? (
              <div className="text-xs text-muted tabular">fee {formatTess(item.fee, 6)}</div>
            ) : null}
            {item.hash ? (
              <ExplorerLink path={`/extrinsic/${item.hash}`} className="text-xs">
                <TimeAgo date={item.timestamp} className="!text-inherit" />
              </ExplorerLink>
            ) : (
              <TimeAgo date={item.timestamp} className="text-xs" />
            )}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function Home() {
  const { active } = useWallet();
  const received = useReceivedDelegations(active?.address);
  return (
    <Page className="space-y-6">
      {active && !active.backedUp && (
        <Link to="/accounts" className="flex items-center gap-3 rounded-2xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
          <ShieldAlert size={18} className="shrink-0" />
          <span className="flex-1">The recovery phrase of {active.name} is not backed up. Back it up before receiving TESS.</span>
        </Link>
      )}
      <BalanceCard />
      {(received.data?.length ?? 0) > 0 && (
        <Card>
          <CardHeader title="Spending for owners" icon={<Bot size={16} />} action={<Link to="/agents" className="text-sm font-medium text-accent">Details</Link>} />
          <ul className="divide-y divide-line">
            {received.data!.map((d) => (
              <li key={d.owner} className="flex items-center justify-between gap-3 px-4 py-3 text-sm sm:px-5">
                <span className="flex min-w-0 items-center gap-2">
                  <span className="text-muted">Owner</span> <AddressLink address={d.owner} />
                </span>
                <span className="shrink-0 text-right">
                  <span className="font-semibold tabular">{formatTess(d.remaining.planck, 4)}</span> <span className="text-muted">TESS left</span>
                  {d.expired && <Badge tone="danger" className="ml-2">Expired</Badge>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <div className="grid grid-cols-3 gap-3">
        {[
          { to: "/agents", icon: Bot, label: "AI agents", text: "Budgets and registry" },
          { to: "/tasks", icon: Users, label: "Tasks", text: "Order or do work" },
          { to: "/channels", icon: Zap, label: "Channels", text: "Micropayments" },
        ].map(({ to, icon: Icon, label, text }) => (
          <Link key={to} to={to} className="rounded-2xl border border-line bg-surface p-4 hover:border-line-strong">
            <Icon size={20} className="text-accent" />
            <div className="mt-3 text-sm font-semibold">{label}</div>
            <div className="mt-0.5 hidden text-xs text-muted sm:block">{text}</div>
          </Link>
        ))}
      </div>
      <Card>
        <CardHeader title="Activity" icon={<ScrollText size={16} />} />
        <Activity />
      </Card>
    </Page>
  );
}

export function Send() {
  const wallet = useWallet();
  const tx = useTransaction();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const active = wallet.active!;
  const balance = useBalance(active.address);
  const received = useReceivedDelegations(active.address);
  const [to, setTo] = useState(params.get("to") ?? "");
  const [amount, setAmount] = useState(params.get("amount") ?? "");
  // "" spends the account's own TESS; an owner address spends from that owner's delegation.
  const [from, setFrom] = useState(params.get("from") ?? "");
  const [submitted, setSubmitted] = useState(false);
  const delegation = received.data?.find((d) => d.owner === from);
  const available = from ? delegation?.remaining : balance.data?.transferable;
  const recipient = normalizeAddress(to);
  const parsed = parseAmount(amount, { max: available?.planck });
  const errors = {
    to: !to ? "Enter the recipient" : !recipient ? "Not a Tesserax address: they start with “te”." : recipient === active.address && !from ? "This is the account sending" : null,
    amount: !amount
      ? "Enter an amount"
      : parsed.error ??
        (delegation && parsed.amount && parsed.amount.planck > delegation.policy.maxPerCall.planck
          ? `Above the limit per transfer of this delegation, ${formatTess(delegation.policy.maxPerCall.planck, 6)} TESS`
          : null),
    delegation: !delegation
      ? null
      : delegation.expired
        ? "This delegation has expired"
        : !delegation.policy.transfers
          ? "This delegation does not allow transfers"
          : recipient && delegation.policy.targets.length > 0 && !delegation.policy.targets.includes(recipient)
            ? "This delegation does not allow this recipient"
            : null,
  };
  const submit = () => {
    setSubmitted(true);
    if (errors.to || errors.amount || errors.delegation || !parsed.amount || !recipient) return;
    const value = parsed.amount;
    tx({
      title: "Send TESS",
      summary: (
        <>
          {formatTess(value.planck, 12)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["To", <AddressLink key="to" address={recipient} full />],
        ...(from ? ([["Paid by", <span key="by">the owner <AddressLink address={from} />, within your delegation</span>]] as Array<[string, React.ReactNode]>) : []),
      ],
      warning: wallet.accounts.some((a) => a.address === recipient) ? undefined : "Check the address: a transfer cannot be undone.",
      operation: (client: TesseraxClient, key: Keypair) => (from ? client.agentTransfer(key, from, recipient, value) : client.transfer(key, recipient, value)),
      onDone: () => navigate("/"),
    });
  };
  return (
    <Page narrow>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Send TESS</h1>
      <Card className="space-y-5 p-5 sm:p-6">
        <PayWith value={from} onChange={setFrom} />
        <AddressInput label="Recipient" value={to} onChange={setTo} error={submitted ? errors.to : null} exclude={active.address} />
        <AmountInput label="Amount" value={amount} onChange={setAmount} max={available} error={submitted ? errors.amount : null} />
        {from && delegation && (
          <p className={errors.delegation && submitted ? "text-sm text-danger" : "text-xs text-muted"}>
            {errors.delegation && submitted ? errors.delegation : <>At most <AmountText planck={delegation.policy.maxPerCall.planck.toString()} decimals={6} /> per transfer under this delegation.</>}
          </p>
        )}
        <Button className="w-full" onClick={submit}>
          Review
        </Button>
      </Card>
    </Page>
  );
}

/** A QR code of `text`, drawn as SVG from its modules. */
export function QrCode({ text, size = 220 }: { text: string; size?: number }) {
  const { data } = useMemo(() => encode(text, { ecc: "M", border: 2 }), [text]);
  const n = data.length;
  const path = useMemo(() => {
    let d = "";
    data.forEach((row, y) => row.forEach((on, x) => on && (d += `M${x} ${y}h1v1h-1z`)));
    return d;
  }, [data]);
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} className="rounded-2xl bg-white" shapeRendering="crispEdges" role="img" aria-label="QR code of the address">
      <path d={path} fill="#07090d" />
    </svg>
  );
}

export function Receive() {
  const { active } = useWallet();
  const [copied, setCopied] = useState(false);
  if (!active) return null;
  return (
    <Page narrow>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Receive TESS</h1>
      <Card className="flex flex-col items-center p-6 text-center sm:p-8">
        <div className="rounded-3xl border border-line p-3">
          <QrCode text={active.address} />
        </div>
        <div className="mt-5 flex items-center gap-2">
          <Identicon address={active.address} size={22} />
          <span className="font-semibold">{active.name}</span>
        </div>
        <p className="mt-3 break-all font-mono text-sm">{active.address}</p>
        <Button
          variant="secondary"
          className="mt-5"
          onClick={() => {
            void copyText(active.address).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          <Copy size={16} /> {copied ? "Copied" : "Copy the address"}
        </Button>
        <div className="mt-6 flex items-start gap-2 rounded-xl bg-surface-2 px-4 py-3 text-left text-xs text-muted">
          <CircleAlert size={14} className="mt-0.5 shrink-0" />
          Tesserax addresses start with “te”. Only send TESS on the Tesserax network to this address.
        </div>
        {!active.backedUp && (
          <div className="mt-3 flex items-start gap-2 rounded-xl bg-warning-soft px-4 py-3 text-left text-xs text-warning">
            <Lock size={14} className="mt-0.5 shrink-0" />
            Back up the recovery phrase of this account first: without it, TESS received here would be lost with this browser.
          </div>
        )}
      </Card>
    </Page>
  );
}
