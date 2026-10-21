/**
 * The approval window of the extension: what a site asks, in full, for the user to approve or
 * reject. Transactions go through the same review as in the wallet, with their exact fee.
 */

import { Amount, Channels as ChannelCalls, Voucher, type Keypair, type TesseraxClient, type TxOutcome } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { Check, CircleX, Globe, Link2, Loader2, PenLine, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useParams } from "react-router";
import { Button, PasswordInput } from "../components/forms";
import { AddressLink, Identicon } from "../components/links";
import { Row, Status, TransactionPanel, type TxRequest } from "../components/Transaction";
import { cx } from "../components/ui";
import { useAgentRecord, useChain } from "../lib/chain";
import { formatTess, shortAddress } from "../lib/format";
import { toBackground } from "../lib/platform";
import { useWallet } from "../lib/session";
import type { StoredAccount } from "../lib/storage";
import { ERRORS, MESSAGE_CONTEXT, type PendingRequest } from "../extension/protocol";

const hex = (bytes: Uint8Array) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Answer the site, then close the window. */
async function answer(id: string, outcome: { result: unknown } | { error: { code: number; message: string } } | "rejected") {
  try {
    if (outcome === "rejected") await toBackground({ type: "approval:reject", id });
    else if ("result" in outcome) await toBackground({ type: "approval:resolve", id, result: outcome.result });
    else await toBackground({ type: "approval:reject", id, error: outcome.error });
  } finally {
    window.close();
  }
}

const inclusion = (outcome?: TxOutcome) => (outcome ? { txHash: outcome.txHash, blockHash: outcome.blockHash, blockNumber: outcome.blockNumber } : {});

export function Approve() {
  const { id = "" } = useParams();
  const [request, setRequest] = useState<PendingRequest | null | undefined>(undefined);

  useEffect(() => {
    void toBackground<PendingRequest | null>({ type: "approval:get", id }).then(setRequest, () => setRequest(null));
    // Messages keep the background of the extension alive while the user decides.
    const ping = setInterval(() => void toBackground({ type: "approval:ping" }).catch(() => {}), 20_000);
    return () => clearInterval(ping);
  }, [id]);

  if (request === undefined) {
    return (
      <Shell>
        <div className="flex justify-center py-20">
          <Loader2 className="animate-spin text-accent" />
        </div>
      </Shell>
    );
  }
  if (request === null) {
    return (
      <Shell>
        <Status icon={<CircleX size={40} className="text-muted" />} title="This request expired">
          The site can ask again.
          <Button variant="secondary" className="mt-6 w-full" onClick={() => window.close()}>
            Close
          </Button>
        </Status>
      </Shell>
    );
  }
  return (
    <Shell origin={request.origin}>
      <Request request={request} />
    </Shell>
  );
}

function Shell({ origin, children }: { origin?: string; children: ReactNode }) {
  return (
    <div className="mx-auto flex min-h-dvh max-w-md flex-col px-4 py-5">
      <div className="mb-4 flex items-center justify-between">
        <span className="flex items-center gap-2">
          <img src="/logo.png" alt="" className="size-7" />
          <span className="text-sm font-bold tracking-tight">Tesserax Wallet</span>
        </span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted">
          <ShieldCheck size={13} className="text-success" /> Signed in this browser
        </span>
      </div>
      {origin && (
        <div className="mb-4 flex items-center gap-3 rounded-2xl border border-line bg-surface px-4 py-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-accent">
            <Globe size={18} />
          </span>
          <span className="min-w-0">
            <span className="block text-xs text-muted">Request from</span>
            <span className="block truncate font-mono text-sm font-medium">{origin}</span>
          </span>
        </div>
      )}
      {children}
    </div>
  );
}

function Request({ request }: { request: PendingRequest }) {
  const wallet = useWallet();
  const { method, params } = request;
  if (method === "tesserax_requestAccounts") return <Connect request={request} />;
  const account = wallet.accounts.find((a) => a.address === params.from);
  if (!account) {
    return (
      <Status icon={<CircleX size={40} className="text-danger" />} title="Unknown account">
        This account is no longer in the wallet.
        <Button variant="secondary" className="mt-6 w-full" onClick={() => answer(request.id, { error: { code: ERRORS.unauthorized, message: "This account is not in the wallet" } })}>
          Close
        </Button>
      </Status>
    );
  }
  if (method === "tesserax_signMessage") return <SignMessage request={request} account={account} />;
  if (method === "tesserax_signVoucher") return <SignVoucher request={request} account={account} />;
  return <SignTransaction request={request} account={account} />;
}

function Connect({ request }: { request: PendingRequest }) {
  const wallet = useWallet();
  const [chosen, setChosen] = useState<string[]>(() => (wallet.active ? [wallet.active.address] : []));
  const toggle = (address: string) => setChosen((c) => (c.includes(address) ? c.filter((a) => a !== address) : [...c, address]));
  return (
    <div className="flex flex-1 flex-col">
      <h1 className="flex items-center gap-2 text-xl font-semibold tracking-tight">
        <Link2 size={20} className="text-accent" /> Connect this site
      </h1>
      <p className="mt-1 text-sm text-muted">Choose the accounts it may see. It will be able to ask for signatures, which you approve one by one.</p>
      <ul className="mt-4 space-y-2">
        {wallet.accounts.map((a) => {
          const on = chosen.includes(a.address);
          return (
            <li key={a.address}>
              <button
                onClick={() => toggle(a.address)}
                aria-pressed={on}
                className={cx("flex w-full items-center gap-3 rounded-2xl border px-3 py-2.5 text-left", on ? "border-accent bg-accent-soft" : "border-line bg-surface hover:border-line-strong")}
              >
                <Identicon address={a.address} size={32} className="rounded-lg" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{a.name}</span>
                  <span className="block truncate font-mono text-xs text-muted">{shortAddress(a.address, 8, 6)}</span>
                </span>
                <span className={cx("flex size-5 shrink-0 items-center justify-center rounded-md border", on ? "border-accent bg-accent text-white" : "border-line-strong")}>{on && <Check size={13} />}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 rounded-xl bg-surface-2 px-3 py-2.5 text-xs text-muted">The site sees the addresses and names of these accounts, never their keys. Disconnect it at any time in Settings.</p>
      <div className="mt-auto flex gap-3 pt-5">
        <Button variant="secondary" className="flex-1" onClick={() => answer(request.id, "rejected")}>
          Reject
        </Button>
        <Button className="flex-1" disabled={chosen.length === 0} onClick={() => answer(request.id, { result: chosen })}>
          Connect
        </Button>
      </div>
    </div>
  );
}

function SignTransaction({ request, account }: { request: PendingRequest; account: StoredAccount }) {
  const { params, method } = request;
  const owner = params.owner;
  const agent = useAgentRecord(method === "tesserax_payAgent" ? params.agent : undefined);

  const tx: TxRequest = useMemo(() => {
    const amount = Amount.fromTess(params.amount ?? params.deposit);
    const summary = (
      <>
        {formatTess(amount.planck, 12)} <span className="text-xl text-muted">TESS</span>
      </>
    );
    const paidBy: Array<[string, ReactNode]> = owner ? [["Paid by", <AddressLink key="o" address={owner} />]] : [];
    // The site gets the inclusion at once; the window stays to show it.
    const onDone = (value: unknown, outcome?: TxOutcome) =>
      void toBackground({ type: "approval:resolve", id: request.id, result: { ...inclusion(outcome), ...(typeof value === "bigint" ? { channel: value.toString() } : {}) } });
    const base = { summary, account: account.name, onDone };
    switch (method) {
      case "tesserax_payAgent":
        return {
          ...base,
          title: "Pay an agent",
          details: [["Agent", <AddressLink key="a" address={params.agent} full />], ...paidBy],
          operation: (c: TesseraxClient, k: Keypair) => (owner ? c.agentPayAgent(k, owner, params.agent, amount) : c.payAgent(k, params.agent, amount)),
        };
      case "tesserax_openChannel":
        return {
          ...base,
          title: "Open a payment channel",
          details: [["Payee", <AddressLink key="p" address={params.payee} full />], ["Vouchers signed by", account.name], ...paidBy],
          warning: "The deposit stays locked in the channel until it closes. The site can then ask you to sign vouchers for it.",
          operation: (c: TesseraxClient, k: Keypair) => (owner ? new ChannelCalls(c).agentOpen(k, owner, params.payee, amount) : new ChannelCalls(c).open(k, params.payee, amount)),
        };
      default:
        return {
          ...base,
          title: "Send TESS",
          details: [["To", <AddressLink key="t" address={params.to} full />], ...paidBy],
          warning: "Check the recipient: a transfer cannot be undone.",
          operation: (c: TesseraxClient, k: Keypair) => (owner ? c.agentTransfer(k, owner, params.to, amount) : c.transfer(k, params.to, amount)),
        };
    }
  }, [request.id]);

  return (
    <>
      {agent.data && (
        <p className="mb-3 text-sm text-muted">
          Agent <span className="font-semibold text-fg">{agent.data.profile.name}</span>, rated {agent.data.reputation.positive - agent.data.reputation.negative >= 0 ? "+" : ""}
          {agent.data.reputation.positive - agent.data.reputation.negative}.
        </p>
      )}
      <TransactionPanel
        inline
        request={tx}
        onClose={(closed) => (closed.done ? window.close() : answer(request.id, closed.error ? { error: { code: ERRORS.internal, message: closed.error } } : "rejected"))}
      />
    </>
  );
}

/** Signatures that are not transactions: shown, then signed with the password if the settings ask. */
function SignPanel({ title, icon, rows, children, warning, onSign, onReject }: { title: string; icon: ReactNode; rows: Array<[string, ReactNode]>; children?: ReactNode; warning?: ReactNode; onSign: () => Promise<void>; onReject: () => void }) {
  const wallet = useWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="space-y-5 rounded-3xl border border-line bg-surface p-5">
      <h1 className="flex items-center gap-2 text-lg font-semibold">
        {icon} {title}
      </h1>
      <dl className="divide-y divide-line rounded-2xl border border-line bg-surface-2">
        {rows.map(([label, value], i) => (
          <Row key={i} label={label}>
            {value}
          </Row>
        ))}
      </dl>
      {children}
      {warning && <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">{warning}</div>}
      {wallet.settings.confirmWithPassword && (
        <PasswordInput
          label="Wallet password"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          error={error}
          autoFocus
        />
      )}
      {error && !wallet.settings.confirmWithPassword && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-3">
        <Button variant="secondary" className="flex-1" onClick={onReject}>
          Reject
        </Button>
        <Button
          className="flex-1"
          busy={busy}
          onClick={async () => {
            setBusy(true);
            try {
              if (wallet.settings.confirmWithPassword && !(await wallet.checkPassword(password))) {
                setError("Wrong password");
                return;
              }
              await onSign();
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          Sign
        </Button>
      </div>
      <p className="text-center text-xs text-muted">Signed in this browser with ML-DSA-87. Your key never leaves it.</p>
    </div>
  );
}

function SignMessage({ request, account }: { request: PendingRequest; account: StoredAccount }) {
  const wallet = useWallet();
  const message = request.params.message;
  return (
    <SignPanel
      title="Sign a message"
      icon={<PenLine size={18} className="text-accent" />}
      rows={[["Account", <AddressLink key="a" address={account.address} label={account.name} />]]}
      warning="Sign only messages you understand. A message signature cannot move funds: it is not valid as a transaction or a voucher."
      onReject={() => answer(request.id, "rejected")}
      onSign={async () => {
        const key = await wallet.keypair(account.name);
        const signature = key.sign(new TextEncoder().encode(message), MESSAGE_CONTEXT);
        await answer(request.id, { result: { address: account.address, publicKey: hex(key.publicKey), signature: hex(signature) } });
      }}
    >
      <div>
        <div className="mb-1.5 text-sm text-muted">Message</div>
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-2xl border border-line bg-surface-2 p-4 font-mono text-[13px] leading-relaxed">{message}</pre>
      </div>
    </SignPanel>
  );
}

function SignVoucher({ request, account }: { request: PendingRequest; account: StoredAccount }) {
  const wallet = useWallet();
  const { client, channels, url } = useChain();
  const id = BigInt(request.params.channel);
  const total = Amount.fromTess(request.params.amount);
  const channel = useQuery({ queryKey: ["channel", url, id.toString()], queryFn: async () => (await channels.channel(id)) ?? null });
  const c = channel.data;
  const problem = channel.isLoading
    ? null
    : !c
      ? "This channel does not exist, or it closed."
      : c.signer !== account.address
        ? "This account does not sign the vouchers of this channel."
        : total.planck > c.deposit.planck
          ? "The amount is above the deposit of the channel."
          : total.planck <= c.claimed.planck
            ? "The payee already claimed this much."
            : null;
  if (channel.isLoading) {
    return (
      <div className="flex justify-center py-16">
        <Loader2 className="animate-spin text-accent" />
      </div>
    );
  }
  if (problem) {
    return (
      <Status icon={<CircleX size={40} className="text-danger" />} title="Cannot sign this voucher">
        {problem}
        <Button variant="secondary" className="mt-6 w-full" onClick={() => answer(request.id, { error: { code: ERRORS.invalidParams, message: problem } })}>
          Close
        </Button>
      </Status>
    );
  }
  const owed = total.planck - c!.claimed.planck;
  return (
    <SignPanel
      title="Sign a payment voucher"
      icon={<PenLine size={18} className="text-accent" />}
      rows={[
        ["Channel", `#${id}`],
        ["Payee", <AddressLink key="p" address={c!.payee} />],
        ["Total owed", `${formatTess(total.planck, 12)} TESS`],
        ["New to the payee", `${formatTess(owed, 12)} TESS`],
        ["Left in the channel", `${formatTess(c!.deposit.planck - total.planck, 6)} TESS`],
      ]}
      warning="A voucher states the total owed on the channel. The payee can claim it on chain, up to the deposit."
      onReject={() => answer(request.id, "rejected")}
      onSign={async () => {
        const [key, genesis] = await Promise.all([wallet.keypair(account.name), client.genesisHash()]);
        await answer(request.id, { result: { voucher: Voucher.sign(key, genesis, id, total).toHeader() } });
      }}
    />
  );
}
