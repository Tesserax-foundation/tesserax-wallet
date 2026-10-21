import { Channels as ChannelCalls, CLOSE_SAFETY_BLOCKS, Voucher, type ChannelInfo, type Keypair, type TesseraxClient } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownLeft, ArrowUpRight, Check, Clock, Copy, FileSignature, Inbox, Plus, Zap } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AddressInput, AmountInput, Button, ErrorText, parseAmount, TextArea } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink } from "../components/links";
import { PayWith } from "../components/PayWith";
import { Sheet } from "../components/Sheet";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, EmptyState, ErrorState, PageHeader, SkeletonRows } from "../components/ui";
import { copyText } from "../lib/clipboard";
import { channelsOf, normalizeAddress, useBalance, useBestBlock, useChain, useReceivedDelegations } from "../lib/chain";
import { blocksDuration, formatTess } from "../lib/format";
import { useWallet } from "../lib/session";

const MIN_DEPOSIT = 10_000_000_000n; // 0.01 TESS

export function Channels() {
  const chain = useChain();
  const { active } = useWallet();
  const [opening, setOpening] = useState(false);
  const { data, error, isLoading } = useQuery({
    queryKey: ["channels", chain.url, active?.address],
    queryFn: () => channelsOf(chain, active!.address),
    enabled: Boolean(active),
    refetchInterval: 20_000,
  });
  return (
    <Page>
      <PageHeader title="Payment channels" icon={<Zap size={20} />} subtitle="Pay a service many times with signed vouchers, settled on chain once.">
        <Button onClick={() => setOpening(true)}>
          <Plus size={16} /> Open a channel
        </Button>
      </PageHeader>
      <Card>
        {error ? (
          <ErrorState error={error} />
        ) : isLoading ? (
          <SkeletonRows rows={3} />
        ) : !data?.length ? (
          <EmptyState title="No channel">
            Open a channel to a service with a deposit, then pay it off chain with vouchers. Services claim them; the rest returns to you when the channel closes.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {data.map((c) => (
              <ChannelRow key={c.id.toString()} channel={c} />
            ))}
          </ul>
        )}
      </Card>
      <HowItWorks />
      {opening && <OpenSheet onClose={() => setOpening(false)} />}
    </Page>
  );
}

function HowItWorks() {
  const steps = [
    { icon: ArrowUpRight, title: "Open", text: "Lock a deposit for one payee. Vouchers are signed by your key, or by your agent's key." },
    { icon: FileSignature, title: "Pay off chain", text: "Each request carries a voucher of the total owed. No fee, no block to wait for." },
    { icon: ArrowDownLeft, title: "Settle", text: "The payee claims the last voucher. Close the channel: the rest returns after 6 hours." },
  ];
  return (
    <div className="mt-6 grid gap-3 sm:grid-cols-3">
      {steps.map(({ icon: Icon, title, text }, i) => (
        <div key={title} className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span className="flex size-7 items-center justify-center rounded-lg bg-accent-soft text-accent">
              <Icon size={15} />
            </span>
            {i + 1}. {title}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted">{text}</p>
        </div>
      ))}
    </div>
  );
}

type Role = "payer" | "payee" | "signer";

function ChannelRow({ channel: c }: { channel: ChannelInfo }) {
  const { active } = useWallet();
  const tx = useTransaction();
  const best = useBestBlock();
  const [sheet, setSheet] = useState<"top-up" | "voucher" | "claim" | null>(null);
  const me = active!.address;
  const role: Role = c.payee === me ? "payee" : c.payer === me ? "payer" : "signer";
  // The signing agent acts for the payer through its delegation.
  const owner = role === "signer" ? c.payer : undefined;
  const left = c.deposit.planck - c.claimed.planck;
  const share = c.deposit.planck === 0n ? 0 : Number((c.claimed.planck * 1000n) / c.deposit.planck) / 10;
  const closing = c.closesAt !== undefined;
  const closable = closing && best.data !== undefined && best.data >= c.closesAt!;
  const details = (extra: Array<[string, ReactNode]> = []): Array<[string, ReactNode]> => [["Channel", `#${c.id}`], ["Payee", <AddressLink key="p" address={c.payee} />], ...extra];
  return (
    <li className="px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">Channel #{c.id.toString()}</span>
            <Badge tone={role === "payee" ? "success" : "accent"}>{role === "payee" ? "Receiving" : role === "payer" ? "Paying" : "Paying as agent"}</Badge>
            {closing && (
              <Badge tone="warning">
                <Clock size={11} /> {closable ? "Ready to finalize" : best.data ? `Closes in ${blocksDuration(c.closesAt! - best.data)}` : "Closing"}
              </Badge>
            )}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            <span className="flex items-center gap-1">
              {role === "payee" ? "From" : "To"} <AddressLink address={role === "payee" ? c.payer : c.payee} />
            </span>
            {c.signer !== c.payer && (
              <span className="flex items-center gap-1">
                Vouchers signed by <AddressLink address={c.signer} />
              </span>
            )}
          </div>
        </div>
        <div className="text-right">
          <div className="text-lg font-semibold tabular">{formatTess(left, 4)} TESS</div>
          <div className="text-xs text-muted">left of {formatTess(c.deposit.planck, 4)}</div>
        </div>
      </div>
      <div className="mt-3 h-2 overflow-hidden rounded-full bg-surface-3">
        <div className="h-full rounded-full bg-accent" style={{ width: `${Math.min(100, share)}%` }} />
      </div>
      <div className="mt-1.5 text-xs text-muted">{formatTess(c.claimed.planck, 6)} TESS claimed by the payee</div>
      <div className="mt-4 flex flex-wrap gap-2">
        {role === "payee" ? (
          <>
            <Button size="sm" onClick={() => setSheet("claim")}>
              <Inbox size={14} /> Claim a voucher
            </Button>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                tx({
                  title: "Close the channel",
                  details: details([["Returns to the payer", `${formatTess(left, 6)} TESS`]]),
                  warning: "Claim the last voucher first: once closed, vouchers of this channel are worthless.",
                  operation: (cl: TesseraxClient, k: Keypair) => new ChannelCalls(cl).close(k, c.id),
                })
              }
            >
              Close
            </Button>
          </>
        ) : (
          <>
            {c.signer === me && (
              <Button variant="secondary" size="sm" onClick={() => setSheet("voucher")}>
                <FileSignature size={14} /> Sign a voucher
              </Button>
            )}
            {!closing && (
              <Button variant="secondary" size="sm" onClick={() => setSheet("top-up")}>
                <Plus size={14} /> Top up
              </Button>
            )}
            {!closing && (
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  tx({
                    title: "Request to close",
                    details: details(),
                    warning: `The payee has 6 hours to claim its last voucher. Then finalize the close: the rest, about ${formatTess(left, 4)} TESS, returns to the payer.`,
                    operation: (cl: TesseraxClient, k: Keypair) => new ChannelCalls(cl).requestClose(k, owner, c.id),
                  })
                }
              >
                Close
              </Button>
            )}
            {closable && (
              <Button
                size="sm"
                onClick={() =>
                  tx({
                    title: "Finalize the close",
                    details: details([["Returns to the payer", `${formatTess(left, 6)} TESS`]]),
                    operation: (cl: TesseraxClient, k: Keypair) => new ChannelCalls(cl).finalizeClose(k, c.id),
                  })
                }
              >
                <Check size={14} /> Finalize
              </Button>
            )}
          </>
        )}
      </div>
      {sheet === "top-up" && <TopUpSheet channel={c} owner={owner} onClose={() => setSheet(null)} />}
      {sheet === "voucher" && <VoucherSheet channel={c} onClose={() => setSheet(null)} />}
      {sheet === "claim" && <ClaimSheet channel={c} onClose={() => setSheet(null)} />}
    </li>
  );
}

/** What the payer of an operation can spend: its own TESS or the owner's budget. */
function useAvailable(owner: string) {
  const { active } = useWallet();
  const balance = useBalance(active?.address);
  const received = useReceivedDelegations(active?.address);
  return owner ? received.data?.find((d) => d.owner === owner)?.remaining : balance.data?.transferable;
}

function OpenSheet({ onClose }: { onClose: () => void }) {
  const { active } = useWallet();
  const tx = useTransaction();
  const [from, setFrom] = useState("");
  const [payee, setPayee] = useState("");
  const [deposit, setDeposit] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const available = useAvailable(from);
  const payeeAddress = normalizeAddress(payee);
  const parsed = parseAmount(deposit, { min: MIN_DEPOSIT, max: available?.planck });
  const errors = {
    payee: !payee ? "Enter the payee: the service you will pay" : !payeeAddress ? "Not a Tesserax address" : payeeAddress === (from || active?.address) ? "The payer cannot be the payee" : null,
    deposit: !deposit ? "Enter a deposit" : parsed.error,
  };
  return (
    <Sheet title="Open a channel" icon={<Zap size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <PayWith value={from} onChange={setFrom} />
        <AddressInput label="Payee" value={payee} onChange={setPayee} error={submitted ? errors.payee : null} exclude={active?.address} />
        <AmountInput label="Deposit" value={deposit} onChange={setDeposit} max={available} error={submitted ? errors.deposit : null} />
        <p className="text-xs text-muted">At least 0.01 TESS. A storage deposit is also reserved while the channel is open, returned when it closes.</p>
        <Button
          className="w-full"
          onClick={() => {
            setSubmitted(true);
            if (errors.payee || errors.deposit || !parsed.amount || !payeeAddress) return;
            const value = parsed.amount;
            tx({
              title: "Open a channel",
              summary: (
                <>
                  {formatTess(value.planck, 12)} <span className="text-xl text-muted">TESS</span>
                </>
              ),
              details: [
                ["Payee", <AddressLink key="p" address={payeeAddress} full />],
                ["Vouchers signed by", active!.name],
                ...(from ? ([["Paid by", <AddressLink key="o" address={from} />]] as Array<[string, ReactNode]>) : []),
              ],
              operation: (cl: TesseraxClient, k: Keypair) => (from ? new ChannelCalls(cl).agentOpen(k, from, payeeAddress, value) : new ChannelCalls(cl).open(k, payeeAddress, value)),
              onDone: onClose,
            });
          }}
        >
          Review
        </Button>
      </div>
    </Sheet>
  );
}

function TopUpSheet({ channel, owner, onClose }: { channel: ChannelInfo; owner?: string; onClose: () => void }) {
  const tx = useTransaction();
  const [amount, setAmount] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const available = useAvailable(owner ?? "");
  const parsed = parseAmount(amount, { max: available?.planck });
  const error = !amount ? "Enter an amount" : parsed.error;
  return (
    <Sheet title={`Top up channel #${channel.id}`} icon={<Plus size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <AmountInput label="Amount to add" value={amount} onChange={setAmount} max={available} error={submitted ? error : null} />
        <Button
          className="w-full"
          onClick={() => {
            setSubmitted(true);
            if (error || !parsed.amount) return;
            const value = parsed.amount;
            tx({
              title: "Top up the channel",
              summary: (
                <>
                  +{formatTess(value.planck, 12)} <span className="text-xl text-muted">TESS</span>
                </>
              ),
              details: [
                ["Channel", `#${channel.id}`],
                ["New deposit", `${formatTess(channel.deposit.planck + value.planck, 6)} TESS`],
              ],
              operation: (cl: TesseraxClient, k: Keypair) => new ChannelCalls(cl).topUp(k, owner, channel.id, value),
              onDone: onClose,
            });
          }}
        >
          Review
        </Button>
      </div>
    </Sheet>
  );
}

/** Sign a voucher by hand: for a payee that takes vouchers outside of HTTP. */
function VoucherSheet({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const wallet = useWallet();
  const { client } = useChain();
  const [total, setTotal] = useState("");
  const [voucher, setVoucher] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const parsed = parseAmount(total, { min: channel.claimed.planck + 1n, max: channel.deposit.planck });
  return (
    <Sheet title={`Sign a voucher · channel #${channel.id}`} icon={<FileSignature size={18} />} onClose={onClose}>
      {!voucher ? (
        <div className="space-y-5">
          <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
            A voucher states the <b>total</b> owed on the channel since it opened, not one payment. The payee can claim up to this total at once.
          </div>
          <AmountInput label="Total owed" value={total} onChange={(v) => { setTotal(v); setError(null); }} hint={`Claimed so far ${formatTess(channel.claimed.planck, 6)} TESS`} error={error ?? (total ? parsed.error : null)} />
          <Button
            className="w-full"
            disabled={!parsed.amount}
            onClick={async () => {
              try {
                const [key, genesis] = await Promise.all([wallet.keypair(), client.genesisHash()]);
                setVoucher(Voucher.sign(key, genesis, channel.id, parsed.amount!).toHeader());
              } catch (e) {
                setError((e as Error).message);
              }
            }}
          >
            Sign
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">Give this voucher to the payee. It is the value of the Tesserax-Voucher header.</p>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-xl border border-line bg-surface-2 p-3 font-mono text-xs">{voucher}</pre>
          <Button
            className="w-full"
            onClick={() =>
              void copyText(voucher).then((ok) => {
                if (!ok) return;
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              })
            }
          >
            {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy the voucher"}
          </Button>
        </div>
      )}
    </Sheet>
  );
}

function ClaimSheet({ channel, onClose }: { channel: ChannelInfo; onClose: () => void }) {
  const tx = useTransaction();
  const { client } = useChain();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const check = async (): Promise<Voucher> => {
    let voucher: Voucher;
    try {
      voucher = Voucher.fromHeader(text.trim());
    } catch {
      throw new Error("Not a voucher: paste the value of a Tesserax-Voucher header");
    }
    if (voucher.channel !== channel.id) throw new Error(`This voucher is for channel #${voucher.channel}`);
    if (!voucher.verify(await client.genesisHash(), channel.signerPublic)) throw new Error("The signature of this voucher is not valid for this channel");
    if (voucher.amount.planck <= channel.claimed.planck) throw new Error("Already claimed: the voucher is not above what was claimed");
    if (voucher.amount.planck > channel.deposit.planck) throw new Error("The voucher is above the deposit of the channel");
    return voucher;
  };
  return (
    <Sheet title={`Claim · channel #${channel.id}`} icon={<Inbox size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <TextArea label="Voucher" value={text} onChange={(e) => { setText(e.target.value); setError(null); }} placeholder='{"channel":1,"amount":"0.5","signature":"…"}' spellCheck={false} rows={5} mono />
        <ErrorText>{error}</ErrorText>
        <p className="text-xs text-muted">Claim the latest voucher before the channel closes. Services stop accepting vouchers {blocksDuration(CLOSE_SAFETY_BLOCKS)} before the close.</p>
        <Button
          className="w-full"
          disabled={!text.trim()}
          onClick={async () => {
            try {
              const voucher = await check();
              tx({
                title: "Claim a voucher",
                summary: (
                  <>
                    +{formatTess(voucher.amount.planck - channel.claimed.planck, 12)} <span className="text-xl text-muted">TESS</span>
                  </>
                ),
                details: [
                  ["Channel", `#${channel.id}`],
                  ["Voucher total", `${formatTess(voucher.amount.planck, 6)} TESS`],
                  ["Payer", <AddressLink key="p" address={channel.payer} />],
                ],
                operation: (cl: TesseraxClient, k: Keypair) => new ChannelCalls(cl).claim(k, voucher),
                onDone: onClose,
              });
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Check and claim
        </Button>
      </div>
    </Sheet>
  );
}
