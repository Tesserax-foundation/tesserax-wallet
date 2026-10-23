import { Amount, type Keypair, type TesseraxClient } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ArrowUpFromLine, Copy, EyeOff, RefreshCw, Send as SendIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { AddressInput, AmountInput, Button, parseAmount, TextArea } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink } from "../components/links";
import { useTransaction } from "../components/Transaction";
import { Card, ErrorState, Skeleton, Tabs } from "../components/ui";
import { normalizeAddress, useBalance, useChain } from "../lib/chain";
import { copyText } from "../lib/clipboard";
import { formatTess } from "../lib/format";
import { useWallet } from "../lib/session";
import { isShieldedAddress, loadShielded, minimumFee, sendPrivately, shield, syncShielded, unshield } from "../lib/shielded";

type Action = "shield" | "send" | "unshield";

const short = (address: string) => `${address.slice(0, 18)}…${address.slice(-10)}`;

/** The shielded account of the active account, synchronized with the chain. */
function useShielded() {
  const wallet = useWallet();
  const { client, url } = useChain();
  const active = wallet.active!;
  const [progress, setProgress] = useState<number | null>(null);
  const query = useQuery({
    queryKey: ["shielded", active.address, url],
    queryFn: async () => {
      const key = await wallet.keypair(active.name);
      try {
        return await syncShielded(client, key, setProgress);
      } finally {
        setProgress(null);
      }
    },
    refetchInterval: 30_000,
  });
  return { ...query, progress };
}

export function Private() {
  const wallet = useWallet();
  const tx = useTransaction();
  const { client } = useChain();
  const active = wallet.active!;
  const shielded = useShielded();
  const transparent = useBalance(active.address);
  const fee = useQuery({ queryKey: ["shielded-fee"], queryFn: () => minimumFee(client), staleTime: 600_000 });
  const [action, setAction] = useState<Action>("shield");
  const [amount, setAmount] = useState("");
  const [to, setTo] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [copied, setCopied] = useState(false);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    void loadShielded().then(() => setReady(true));
  }, []);
  useEffect(() => {
    setAmount("");
    setTo(action === "unshield" ? active.address : "");
    setSubmitted(false);
  }, [action, active.address]);

  const view = shielded.data;
  const feePlanck = fee.data ?? 0n;
  const privateMax = view ? (view.balance > feePlanck ? view.balance - feePlanck : 0n) : undefined;
  const max = action === "shield" ? transparent.data?.transferable.planck : privateMax;
  const parsed = parseAmount(amount, { max });
  const recipient = action === "unshield" ? normalizeAddress(to) : null;
  const errors = {
    amount: !amount ? "Enter an amount" : parsed.error ?? null,
    to:
      action === "send"
        ? !to.trim()
          ? "Enter the private address of the recipient"
          : ready && !isShieldedAddress(to.trim())
            ? "Not a private address: they start with “zte” and are about 1,670 characters long."
            : view && to.trim() === view.address
              ? "This is your own private address"
              : null
        : action === "unshield"
          ? !recipient
            ? "Not a Tesserax address: they start with “te”."
            : null
          : null,
  };

  const done = () => {
    setAmount("");
    setSubmitted(false);
    void shielded.refetch();
  };

  const review = () => {
    setSubmitted(true);
    if (errors.amount || errors.to || !parsed.amount) return;
    const value = parsed.amount.planck;
    const summary = (
      <>
        {formatTess(value, 12)} <span className="text-xl text-muted">TESS</span>
      </>
    );
    const privateFee = (c: TesseraxClient) => minimumFee(c).then((planck) => new Amount(planck));
    if (action === "shield") {
      tx({
        title: "Move to your private balance",
        summary,
        details: [["Visible on chain", "Your account and the amount, not where the TESS go next"]],
        operation: (c: TesseraxClient, key: Keypair) => shield(c, key, value),
        onDone: done,
      });
    } else if (action === "send") {
      const address = to.trim();
      tx({
        title: "Send privately",
        summary,
        details: [
          ["To", <span key="to" className="font-mono text-xs">{short(address)}</span>],
          ["Visible on chain", "Nothing: neither the sender, the recipient nor the amount"],
          ["Fee", "Paid from your private balance"],
        ],
        fee: privateFee,
        warning: "Check the private address: a transfer cannot be undone.",
        operation: (c: TesseraxClient, key: Keypair) => sendPrivately(c, key, address, value),
        onDone: done,
      });
    } else {
      tx({
        title: "Move to a public address",
        summary,
        details: [
          ["To", <AddressLink key="to" address={recipient!} full />],
          ["Visible on chain", "The amount and this address, not the notes they come from"],
          ["Fee", "Paid from your private balance"],
        ],
        fee: privateFee,
        operation: (c: TesseraxClient, key: Keypair) => unshield(c, key, recipient!, value),
        onDone: done,
      });
    }
  };

  return (
    <Page narrow>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">Private balance</h1>
      <div className="relative mb-5 overflow-hidden rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <div className="glow absolute inset-0" />
        <div className="relative">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-sm text-muted">
              <EyeOff size={16} /> Only you can see it
            </div>
            <Button variant="ghost" size="sm" busy={shielded.isFetching} onClick={() => void shielded.refetch()} aria-label="Read the chain again">
              <RefreshCw size={15} />
            </Button>
          </div>
          <div className="mt-2 flex flex-wrap items-baseline gap-x-2">
            {view ? (
              <>
                <span className="min-w-0 break-all text-[34px] font-bold leading-tight tracking-tight tabular sm:text-5xl">{formatTess(view.balance, 4)}</span>
                <span className="text-lg font-semibold text-muted">TESS</span>
              </>
            ) : shielded.error ? null : (
              <Skeleton className="h-12 w-56" />
            )}
          </div>
          {shielded.error ? (
            <div className="mt-3">
              <ErrorState error={shielded.error} />
            </div>
          ) : (
            <p className="mt-3 text-sm text-muted">
              {shielded.progress != null
                ? `Reading the chain, block #${shielded.progress.toLocaleString("en-US")}…`
                : view
                  ? `Up to date at block #${view.block.toLocaleString("en-US")}${view.pending > 0n ? ` · ${formatTess(view.pending, 4)} TESS waiting for a block` : ""}`
                  : "Reading the chain for your private notes…"}
            </p>
          )}
        </div>
      </div>

      <Card className="mb-5 p-5 sm:p-6">
        <div className="text-sm font-semibold">Your private address</div>
        <p className="mt-1 text-xs text-muted">Share it to receive TESS privately. It is long: copy it rather than typing it.</p>
        {view ? (
          <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
            <span className="min-w-0 flex-1 truncate font-mono text-xs">{short(view.address)}</span>
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void copyText(view.address).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              <Copy size={14} /> {copied ? "Copied" : "Copy"}
            </Button>
          </div>
        ) : (
          <Skeleton className="mt-3 h-11 w-full" />
        )}
      </Card>

      <Card className="space-y-5 p-5 sm:p-6">
        <Tabs<Action>
          tabs={[
            { id: "shield", label: <span className="inline-flex items-center gap-1.5"><ArrowDownToLine size={15} /> Move in</span> },
            { id: "send", label: <span className="inline-flex items-center gap-1.5"><SendIcon size={15} /> Send</span> },
            { id: "unshield", label: <span className="inline-flex items-center gap-1.5"><ArrowUpFromLine size={15} /> Move out</span> },
          ]}
          value={action}
          onChange={setAction}
        />
        <p className="text-sm text-muted">
          {action === "shield"
            ? "Move TESS of your account into your private balance. The chain shows your account and the amount, then loses track of them."
            : action === "send"
              ? "Send from your private balance to a private address. Nobody sees who sent, who received or how much."
              : "Move TESS of your private balance to a public address, yours or another."}
        </p>
        {action === "send" && (
          <TextArea label="Private address of the recipient" value={to} onChange={(e) => setTo(e.target.value)} placeholder="zte…" spellCheck={false} autoComplete="off" rows={3} mono error={submitted ? errors.to : null} />
        )}
        {action === "unshield" && <AddressInput label="To" value={to} onChange={setTo} error={submitted ? errors.to : null} />}
        <AmountInput
          label="Amount"
          value={amount}
          onChange={setAmount}
          max={max !== undefined ? new Amount(max) : undefined}
          error={submitted ? errors.amount : null}
          hint={action !== "shield" && fee.data !== undefined && max !== undefined ? <>Available {formatTess(max, 4)} TESS, after the fee of {formatTess(fee.data, 4)}</> : undefined}
        />
        <Button className="w-full" onClick={review} disabled={!view}>
          Review
        </Button>
      </Card>
    </Page>
  );
}
