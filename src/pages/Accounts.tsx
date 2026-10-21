import { Keypair } from "@tesserax/sdk";
import { ArrowLeft, Bot, Check, Copy, Download, Eye, FileKey2, KeyRound, MoreHorizontal, Pencil, Plus, ShieldAlert, ShieldCheck, Sparkles, Trash2, Wallet } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Button, ErrorText, PasswordInput, TextInput } from "../components/forms";
import { Page } from "../components/Layout";
import { Identicon } from "../components/links";
import { Sheet } from "../components/Sheet";
import { Badge, Card, cx, PageHeader } from "../components/ui";
import { copyText } from "../lib/clipboard";
import { validName, KeystoreError } from "../lib/keystore";
import { useBalance } from "../lib/chain";
import { isPopup, openInTab } from "../lib/platform";
import { formatTess, shortAddress } from "../lib/format";
import { useWallet } from "../lib/session";
import type { StoredAccount } from "../lib/storage";
import { BackupPhrase, ImportSource } from "./Onboarding";

type Action = "rename" | "backup" | "reveal" | "remove";

export function Accounts() {
  const wallet = useWallet();
  const [action, setAction] = useState<{ kind: Action; account: StoredAccount } | null>(null);
  return (
    <Page>
      <PageHeader title="Accounts" icon={<Wallet size={20} />} subtitle="Every account is encrypted in this browser under the wallet password.">
        <Link to="/accounts/add" className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-accent px-4 text-sm font-semibold text-white shadow-[0_6px_20px_-8px_var(--accent)] hover:bg-accent-strong">
          <Plus size={16} /> Add an account
        </Link>
      </PageHeader>
      <Card>
        <ul className="divide-y divide-line">
          {wallet.accounts.map((a) => (
            <AccountRow key={a.name} account={a} onAction={(kind) => setAction({ kind, account: a })} />
          ))}
        </ul>
      </Card>
      {action?.kind === "rename" && <RenameSheet account={action.account} onClose={() => setAction(null)} />}
      {action?.kind === "backup" && <SecretSheet account={action.account} mode="backup" onClose={() => setAction(null)} />}
      {action?.kind === "reveal" && <SecretSheet account={action.account} mode="reveal" onClose={() => setAction(null)} />}
      {action?.kind === "remove" && <RemoveSheet account={action.account} onClose={() => setAction(null)} />}
    </Page>
  );
}

/** Save the encrypted keystore file of an account, as the command line wallet stores it. */
function downloadKeystore(account: StoredAccount) {
  const blob = new Blob([JSON.stringify(account.file, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${account.name}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function AccountRow({ account: a, onAction }: { account: StoredAccount; onAction: (action: Action) => void }) {
  const wallet = useWallet();
  const { data } = useBalance(a.address);
  const [menu, setMenu] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const isActive = wallet.active?.name === a.name;
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setMenu(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const item = (icon: ReactNode, label: string, onClick: () => void, danger?: boolean) => (
    <button
      onClick={() => {
        setMenu(false);
        onClick();
      }}
      className={cx("flex w-full items-center gap-2.5 rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2", danger && "text-danger")}
    >
      {icon} {label}
    </button>
  );
  return (
    <li className="flex items-center gap-3 px-4 py-4 sm:gap-4 sm:px-5">
      <Identicon address={a.address} size={40} className="rounded-xl" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold">{a.name}</span>
          {isActive && <Badge tone="accent">Active</Badge>}
          {!a.backedUp && (
            <button onClick={() => onAction("backup")}>
              <Badge tone="warning">
                <ShieldAlert size={11} /> Not backed up
              </Badge>
            </button>
          )}
        </div>
        <button
          onClick={() =>
            void copyText(a.address).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
          className="mt-0.5 flex max-w-full items-center gap-1.5 font-mono text-xs text-muted hover:text-fg"
          title="Copy the address"
        >
          <span className="truncate sm:hidden">{shortAddress(a.address, 8, 6)}</span>
          <span className="hidden truncate sm:inline">{a.address}</span>
          {copied ? <Check size={12} className="shrink-0 text-success" /> : <Copy size={12} className="shrink-0" />}
        </button>
      </div>
      <div className="hidden shrink-0 text-right sm:block">
        <div className="text-sm font-semibold tabular">{data ? formatTess(data.free.planck + data.reserved.planck, 4) : "—"}</div>
        <div className="text-xs text-muted">TESS</div>
      </div>
      {!isActive && (
        <Button variant="secondary" size="sm" className="hidden sm:inline-flex" onClick={() => void wallet.setActive(a.name)}>
          Use
        </Button>
      )}
      <div ref={ref} className="relative">
        <button onClick={() => setMenu(!menu)} aria-label={`Actions of ${a.name}`} aria-expanded={menu} className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-fg">
          <MoreHorizontal size={18} />
        </button>
        {menu && (
          <div className="absolute right-0 top-full z-30 mt-2 w-60 rounded-2xl border border-line bg-surface p-1.5 shadow-xl shadow-black/10">
            {!isActive && item(<Check size={15} />, "Use this account", () => void wallet.setActive(a.name))}
            {item(<Pencil size={15} />, "Rename", () => onAction("rename"))}
            {item(<Eye size={15} />, a.backedUp ? "Show the recovery phrase" : "Back up the recovery phrase", () => onAction(a.backedUp ? "reveal" : "backup"))}
            {item(<Download size={15} />, "Download the keystore file", () => downloadKeystore(a))}
            {wallet.accounts.length > 1 && item(<Trash2 size={15} />, "Remove from this wallet", () => onAction("remove"), true)}
          </div>
        )}
      </div>
    </li>
  );
}

function RenameSheet({ account, onClose }: { account: StoredAccount; onClose: () => void }) {
  const wallet = useWallet();
  const [name, setName] = useState(account.name);
  const [error, setError] = useState<string | null>(null);
  return (
    <Sheet title={`Rename ${account.name}`} icon={<Pencil size={18} />} onClose={onClose}>
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!validName(name)) return setError("Letters, digits, “-” and “_”, 64 at most");
          try {
            if (name !== account.name) await wallet.renameAccount(account.name, name);
            onClose();
          } catch (err) {
            setError((err as Error).message);
          }
        }}
      >
        <TextInput label="Name" value={name} onChange={(e) => { setName(e.target.value); setError(null); }} error={error} autoFocus />
        <Button type="submit" className="w-full">
          Save
        </Button>
      </form>
    </Sheet>
  );
}

/** The secret of an account, after the password: to back it up, or to read it again. */
function SecretSheet({ account, mode, onClose }: { account: StoredAccount; mode: "backup" | "reveal"; onClose: () => void }) {
  const wallet = useWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const isPhrase = secret !== null && /^[a-z]+( [a-z]+){23}$/.test(secret);
  return (
    <Sheet title={mode === "backup" ? "Back up the recovery phrase" : "Recovery phrase"} icon={<KeyRound size={18} />} onClose={onClose}>
      {!secret ? (
        <form
          className="space-y-5"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              setSecret(await wallet.revealSecret(account.name, password));
            } catch (err) {
              setError(err instanceof KeystoreError && err.kind === "wrong-password" ? "Wrong password" : (err as Error).message);
            }
          }}
        >
          <p className="text-sm text-muted">Enter the wallet password to show the recovery phrase of {account.name}.</p>
          <PasswordInput label="Wallet password" value={password} onChange={(v) => { setPassword(v); setError(null); }} error={error} autoFocus />
          <Button type="submit" className="w-full" disabled={!password}>
            Continue
          </Button>
        </form>
      ) : mode === "backup" && isPhrase ? (
        <BackupPhrase
          phrase={secret}
          confirmLabel="Done"
          onConfirmed={async () => {
            await wallet.markBackedUp(account.name);
            onClose();
          }}
        />
      ) : (
        <div className="space-y-4">
          <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">Anyone who reads this owns the account. Make sure nobody can see your screen.</div>
          {isPhrase ? (
            <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {secret.split(" ").map((word, i) => (
                <li key={i} className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-sm">
                  <span className="w-5 text-right text-xs text-faint tabular">{i + 1}</span>
                  {word}
                </li>
              ))}
            </ol>
          ) : (
            <pre className="whitespace-pre-wrap break-all rounded-xl border border-line bg-surface-2 p-3 font-mono text-sm">{secret}</pre>
          )}
          <div className="flex gap-3">
            <Button
              variant="secondary"
              className="flex-1"
              onClick={() =>
                void copyText(secret).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1500);
                })
              }
            >
              {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy"}
            </Button>
            <Button
              className="flex-1"
              onClick={async () => {
                if (!account.backedUp) await wallet.markBackedUp(account.name);
                setSecret(null);
                onClose();
              }}
            >
              {account.backedUp ? "Hide" : "I saved it"}
            </Button>
          </div>
        </div>
      )}
    </Sheet>
  );
}

function RemoveSheet({ account, onClose }: { account: StoredAccount; onClose: () => void }) {
  const wallet = useWallet();
  const { data } = useBalance(account.address);
  const [confirm, setConfirm] = useState("");
  const funded = data ? data.free.planck + data.reserved.planck > 0n : false;
  return (
    <Sheet title={`Remove ${account.name}`} icon={<Trash2 size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm text-muted">The account leaves this wallet. Its TESS stay on chain, reachable again by importing its recovery phrase or keystore file.</p>
        {(!account.backedUp || funded) && (
          <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            {!account.backedUp ? "Its recovery phrase is not backed up: " : ""}
            {funded ? `it holds ${formatTess(data!.free.planck + data!.reserved.planck, 4)} TESS. ` : ""}
            Without its phrase or keystore file, they are lost.
          </div>
        )}
        <TextInput label={<>Type <span className="font-mono">{account.name}</span> to confirm</>} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        <Button
          variant="danger"
          className="w-full"
          disabled={confirm !== account.name}
          onClick={async () => {
            await wallet.removeAccount(account.name);
            onClose();
          }}
        >
          Remove the account
        </Button>
      </div>
    </Sheet>
  );
}

// Adding an account.

type Source = "create" | "import" | "agent";

export function AddAccount() {
  const wallet = useWallet();
  const navigate = useNavigate();
  // File pickers and phrases to write down need a page that stays open.
  useEffect(() => {
    if (isPopup) openInTab("/accounts/add");
  }, []);
  const [source, setSource] = useState<Source | null>(null);
  const [name, setName] = useState("");
  const [nameError, setNameError] = useState<string | null>(null);
  const [step, setStep] = useState<"name" | "secret">("name");
  const [error, setError] = useState<string | null>(null);
  const phrase = useMemo(() => Keypair.generate().phrase, [source]);

  const checkName = () => {
    if (!validName(name)) return setNameError("Letters, digits, “-” and “_”, 64 at most"), false;
    if (wallet.accounts.some((a) => a.name === name)) return setNameError("An account already has this name"), false;
    return true;
  };

  const finish = async (add: () => Promise<StoredAccount>, then = "/", activate = true) => {
    try {
      const account = await add();
      if (activate) await wallet.setActive(account.name);
      navigate(then);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const options: Array<{ id: Source; icon: ReactNode; title: string; text: string }> = [
    { id: "create", icon: <Sparkles size={20} />, title: "Create an account", text: "A new account with its own 24-word recovery phrase" },
    { id: "import", icon: <FileKey2 size={20} />, title: "Import an account", text: "From a recovery phrase, or a file of the command line wallet" },
    { id: "agent", icon: <Bot size={20} />, title: "Create an AI agent key", text: "A key to give to an agent, then a budget for it to spend" },
  ];

  return (
    <Page narrow>
      <button onClick={() => (source ? (setSource(null), setStep("name"), setError(null)) : navigate("/accounts"))} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">
        <ArrowLeft size={16} /> Back
      </button>
      <h1 className="mb-6 text-2xl font-semibold tracking-tight">{source ? options.find((o) => o.id === source)!.title : "Add an account"}</h1>
      {!source ? (
        <div className="space-y-3">
          {options.map((o) => (
            <button key={o.id} onClick={() => { setSource(o.id); setName(o.id === "agent" ? "agent" : ""); }} className="flex w-full items-center gap-4 rounded-2xl border border-line bg-surface p-4 text-left hover:border-line-strong">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">{o.icon}</span>
              <span>
                <span className="block font-semibold">{o.title}</span>
                <span className="block text-sm text-muted">{o.text}</span>
              </span>
            </button>
          ))}
        </div>
      ) : (
        <Card className="p-5 sm:p-6">
          {step === "name" ? (
            <form
              className="space-y-5"
              onSubmit={(e) => {
                e.preventDefault();
                if (checkName()) setStep("secret");
              }}
            >
              {source === "agent" && (
                <p className="text-sm text-muted">
                  The agent signs with this key. Give its recovery phrase to the agent, as the <span className="font-mono">TESSERAX_KEY</span> of the SDKs, then authorize it with a budget from your main account.
                </p>
              )}
              <TextInput label="Account name" value={name} onChange={(e) => { setName(e.target.value); setNameError(null); }} error={nameError} autoFocus placeholder={source === "agent" ? "agent" : "savings"} />
              <Button type="submit" className="w-full">
                Continue
              </Button>
            </form>
          ) : source === "create" ? (
            <BackupPhrase phrase={phrase} confirmLabel="Add the account" onConfirmed={() => finish(() => wallet.addAccount(name, phrase, true))} />
          ) : source === "agent" ? (
            <AgentKey phrase={phrase} onDone={() => finish(() => wallet.addAccount(name, phrase, true), `/agents?authorize=${Keypair.fromUri(phrase).address}`, false)} />
          ) : (
            <ImportSource
              onSecret={(secret) => finish(() => wallet.addAccount(name, secret, true))}
              onFile={async (file, password) => {
                await finish(() => wallet.importKeystore(file, password, name));
              }}
            />
          )}
          <ErrorText>{error}</ErrorText>
        </Card>
      )}
    </Page>
  );
}

/** The phrase of a new agent key, to copy into the configuration of the agent. */
function AgentKey({ phrase, onDone }: { phrase: string; onDone: () => void }) {
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState(false);
  const address = useMemo(() => Keypair.fromUri(phrase).address, [phrase]);
  return (
    <div className="space-y-5">
      <div className="flex items-center gap-3 rounded-xl bg-surface-2 px-3 py-2.5">
        <Identicon address={address} size={28} />
        <span className="min-w-0 break-all font-mono text-xs">{address}</span>
      </div>
      <div className="relative">
        <pre className={cx("whitespace-pre-wrap break-words rounded-xl border border-line bg-surface-2 p-4 font-mono text-sm leading-relaxed", !revealed && "select-none blur-md")}>{phrase}</pre>
        {!revealed && (
          <button onClick={() => setRevealed(true)} className="absolute inset-0 flex items-center justify-center gap-2 text-sm font-semibold">
            <Eye size={18} className="text-accent" /> Reveal the agent's phrase
          </button>
        )}
      </div>
      <div className="rounded-xl border border-line px-4 py-3 text-xs leading-relaxed text-muted">
        <ShieldCheck size={14} className="mb-1 text-success" />
        The agent can only spend the budget you give it, and you can revoke it at any time. The key stays in this wallet too, to manage the agent's registry profile.
      </div>
      <div className="flex gap-3">
        <Button
          variant="secondary"
          className="flex-1"
          disabled={!revealed}
          onClick={() =>
            void copyText(phrase).then((ok) => {
              if (!ok) return;
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        >
          {copied ? <Check size={16} /> : <Copy size={16} />} {copied ? "Copied" : "Copy"}
        </Button>
        <Button className="flex-1" disabled={!revealed} onClick={onDone}>
          Add and set a budget
        </Button>
      </div>
    </div>
  );
}
