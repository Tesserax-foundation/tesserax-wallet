/**
 * Every transaction goes through this dialog: it shows what will be signed and its exact fee,
 * asks for the password if the settings say so, signs, submits, and follows the transaction until
 * a block includes it.
 */

import type { Amount, Keypair, TesseraxClient, TxOutcome } from "@tesserax/sdk";
import { useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Loader2, ShieldCheck, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { estimateFee, useChain } from "../lib/chain";
import { formatTess, humanize } from "../lib/format";
import { useWallet } from "../lib/session";
import { AddressLink, BlockLink, ExplorerLink } from "./links";
import { Button, PasswordInput } from "./forms";
import { cx } from "./ui";

export interface TxRequest {
  /** "Send TESS". */
  title: string;
  /** The main line, such as the amount. */
  summary?: ReactNode;
  details: Array<[string, ReactNode]>;
  /** Something the user must know before signing. */
  warning?: ReactNode;
  /** Account signing; the active account by default. */
  account?: string;
  operation: (client: TesseraxClient, key: Keypair) => Promise<unknown>;
  /** The fee, for a transaction whose fee is not the one of a signed transaction, such as a
   * private transfer paid from the private balance. */
  fee?: (client: TesseraxClient) => Promise<Amount>;
  /** Called with the result of `operation` and its inclusion, once included. */
  onDone?: (result: unknown, outcome?: TxOutcome) => void;
}

/** How a transaction panel was closed: after its inclusion, or before, after a failure or not. */
export interface TxClosed {
  done: boolean;
  error?: string;
}

type Phase =
  | { step: "review" }
  | { step: "submitting" }
  | { step: "done"; blockNumber?: number; txHash?: string }
  | { step: "failed"; error: string };

const TxContext = createContext<(request: TxRequest) => void>(() => {});

/** Open the transaction dialog for `request`. */
export const useTransaction = () => useContext(TxContext);

/** "transaction failed: Agents::BudgetExceeded" → "Budget exceeded (Agents)". */
export function explainError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const named = /([A-Z][A-Za-z]+)::([A-Z][A-Za-z]+)/.exec(message);
  if (named) {
    const known: Record<string, string> = {
      "Balances::InsufficientBalance": "Not enough TESS for this amount and its fee.",
      "Token::FundsUnavailable": "Not enough transferable TESS for this amount and its fee.",
      "Token::BelowMinimum": "The recipient would hold less than the existential deposit (0.001 TESS).",
      "Agents::BudgetExceeded": "The agent's budget for this period is spent.",
      "Agents::CallLimitExceeded": "The amount is above the agent's limit per call.",
      "Agents::NoDelegation": "This account has no delegation from that owner.",
      "Agents::Expired": "The delegation has expired.",
      "Agents::TargetNotAllowed": "The delegation does not allow this recipient.",
    };
    return known[named[0]] ?? `${humanize(named[2])} (${named[1]}).`;
  }
  if (/Invalid|Payment|1010/.test(message)) return "The node refused the transaction: the account cannot pay its fee.";
  return message.replace(/^transaction (failed|refused): /, "");
}

export function TransactionProvider({ children }: { children: ReactNode }) {
  // Each request gets its own dialog, kept across renders of the pages behind it.
  const [current, setCurrent] = useState<{ id: number; request: TxRequest } | null>(null);
  const count = useRef(0);
  const open = useCallback((request: TxRequest) => setCurrent({ id: ++count.current, request }), []);
  const close = useCallback(() => setCurrent(null), []);
  return (
    <TxContext.Provider value={open}>
      {children}
      {current && <TransactionPanel key={current.id} request={current.request} onClose={close} />}
    </TxContext.Provider>
  );
}

/**
 * The review of a transaction, then its progress: a dialog over the page, or `inline` in a page
 * of its own, such as the approval window of the extension.
 */
export function TransactionPanel({ request, onClose: close, inline }: { request: TxRequest; onClose: (closed: TxClosed) => void; inline?: boolean }) {
  const wallet = useWallet();
  const chain = useChain();
  const queries = useQueryClient();
  const [phase, setPhase] = useState<Phase>({ step: "review" });
  const [fee, setFee] = useState<{ planck?: string; error?: string }>({});
  // Guards against a second click while the first signature is checked.
  const signing = useRef(false);
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const account = wallet.accounts.find((a) => a.name === (request.account ?? wallet.active?.name));
  const dialog = useRef<HTMLDivElement>(null);
  const onClose = () => close({ done: phase.step === "done", error: phase.step === "failed" ? phase.error : undefined });

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const key = await wallet.keypair(account?.name);
        const fee = request.fee ? await request.fee(chain.client) : await estimateFee(chain.client, (c) => request.operation(c, key), key);
        if (!cancelled) setFee({ planck: fee.planck.toString() });
      } catch (error) {
        if (!cancelled) setFee({ error: explainError(error) });
      }
    })();
    dialog.current?.focus();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && phase.step !== "submitting" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sign = async () => {
    if (signing.current) return;
    signing.current = true;
    if (wallet.settings.confirmWithPassword && !(await wallet.checkPassword(password))) {
      setPasswordError("Wrong password");
      signing.current = false;
      return;
    }
    setPhase({ step: "submitting" });
    try {
      const key = await wallet.keypair(account?.name);
      // Operations such as opening a channel return an id: their inclusion is read from the
      // submission itself.
      let outcome: TxOutcome | undefined;
      const recording: TesseraxClient = Object.create(chain.client);
      recording.submit = async (tx, signer) => (outcome = await chain.client.submit(tx, signer));
      const result = await request.operation(recording, key);
      // Transactions submitted without signer return their inclusion.
      if (!outcome && result && typeof result === "object" && "blockNumber" in result) outcome = result as TxOutcome;
      setPhase({ step: "done", blockNumber: outcome?.blockNumber, txHash: outcome?.txHash });
      void queries.invalidateQueries();
      request.onDone?.(result, outcome);
    } catch (error) {
      setPhase({ step: "failed", error: explainError(error) });
    } finally {
      signing.current = false;
    }
  };

  const panel = (
    <div
      ref={dialog}
      tabIndex={-1}
      role={inline ? "region" : "dialog"}
      aria-modal={inline ? undefined : true}
      aria-label={request.title}
      className={cx(
        "w-full overflow-y-auto border border-line bg-surface outline-none",
        inline ? "rounded-3xl" : "relative max-h-[92dvh] max-w-lg rounded-t-3xl shadow-2xl sm:rounded-3xl",
      )}
    >
      <div className="flex items-center justify-between border-b border-line px-5 py-4">
        <div className="flex items-center gap-2 font-semibold">
          <ShieldCheck size={18} className="text-accent" />
          {request.title}
        </div>
        {phase.step !== "submitting" && (
          <button onClick={onClose} aria-label="Close" className="flex size-8 items-center justify-center rounded-lg text-muted hover:bg-surface-2 hover:text-fg">
            <X size={18} />
          </button>
        )}
      </div>

      {phase.step === "review" && (
        <div className="space-y-5 p-5">
          {request.summary && <div className="text-center text-3xl font-semibold tracking-tight tabular">{request.summary}</div>}
          <dl className="divide-y divide-line rounded-2xl border border-line bg-surface-2">
            <Row label="From">{account ? <AddressLink address={account.address} label={account.name} /> : "—"}</Row>
            {request.details.map(([label, value], i) => (
              <Row key={i} label={label}>
                {value}
              </Row>
            ))}
            <Row label="Network fee">
              {fee.planck != null ? (
                <span className="tabular">{formatTess(fee.planck, 6)} TESS</span>
              ) : fee.error ? (
                <span className="text-danger">{fee.error}</span>
              ) : (
                <span className="inline-flex items-center gap-2 text-muted">
                  <Loader2 size={14} className="animate-spin" /> Estimating
                </span>
              )}
            </Row>
          </dl>
          {request.warning && <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">{request.warning}</div>}
          {wallet.settings.confirmWithPassword && (
            <PasswordInput
              label="Wallet password"
              value={password}
              onChange={(v) => {
                setPassword(v);
                setPasswordError(null);
              }}
              error={passwordError}
              autoFocus
            />
          )}
          <div className="flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Cancel
            </Button>
            <Button className="flex-1" onClick={sign}>
              Sign and send
            </Button>
          </div>
          <p className="text-center text-xs text-muted">Signed in this browser with ML-DSA-87. Your key never leaves it.</p>
        </div>
      )}

      {phase.step === "submitting" && (
        <Status icon={<Loader2 size={40} className="animate-spin text-accent" />} title="Sending">
          Waiting for a block to include the transaction, about 18 seconds.
        </Status>
      )}

      {phase.step === "done" && (
        <Status icon={<CircleCheck size={44} className="text-success" />} title="Done">
          {phase.blockNumber !== undefined && (
            <span className="block">
              Included in block <BlockLink number={phase.blockNumber} />.
            </span>
          )}
          {phase.txHash && (
            <ExplorerLink path={`/extrinsic/${phase.txHash}`} className="mt-1 inline-block text-sm">
              View the transaction
            </ExplorerLink>
          )}
          <Button className="mt-6 w-full" onClick={onClose}>
            Close
          </Button>
        </Status>
      )}

      {phase.step === "failed" && (
        <Status icon={<CircleX size={44} className="text-danger" />} title="The transaction failed">
          <span className="block text-danger">{phase.error}</span>
          <div className="mt-6 flex gap-3">
            <Button variant="secondary" className="flex-1" onClick={onClose}>
              Close
            </Button>
            <Button className="flex-1" onClick={() => setPhase({ step: "review" })}>
              Back
            </Button>
          </div>
        </Status>
      )}
    </div>
  );
  if (inline) return panel;
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
      <div className="absolute inset-0 bg-black/50 backdrop-blur-sm" onClick={() => phase.step !== "submitting" && onClose()} />
      {panel}
    </div>
  );
}

export function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-4 px-4 py-3 text-sm">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 break-words text-right">{children}</dd>
    </div>
  );
}

export function Status({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
  return (
    <div className={cx("flex flex-col items-center px-6 py-10 text-center")}>
      {icon}
      <h3 className="mt-4 text-lg font-semibold">{title}</h3>
      <div className="mt-2 w-full text-sm text-muted">{children}</div>
    </div>
  );
}
