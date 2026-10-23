import { Keypair } from "@tesserax/sdk";
import { ArrowLeft, Download, Eye, FileKey2, KeyRound, Lock, ShieldCheck, Sparkles, TriangleAlert, Upload } from "lucide-react";
import { useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "react-router";
import { Button, ErrorText, PasswordInput, StrengthMeter, TextArea, TextInput, passwordStrength } from "../components/forms";
import { Identicon } from "../components/links";
import { cx } from "../components/ui";
import { decrypt, KeystoreError, parseKeystore, validName } from "../lib/keystore";
import { cleanSecret, phraseProblem } from "../lib/phrase";
import { useWallet } from "../lib/session";

/** Full-screen frame of the pages shown before the wallet opens. */
export function Frame({ children, back }: { children: ReactNode; back?: string }) {
  return (
    <div className="relative min-h-dvh overflow-hidden">
      <div className="glow absolute inset-0" />
      <div className="relative mx-auto flex min-h-dvh max-w-lg flex-col px-4 py-8 sm:py-14">
        <div className="mb-8 flex items-center justify-between">
          {back ? (
            <Link to={back} className="inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">
              <ArrowLeft size={16} /> Back
            </Link>
          ) : (
            <span />
          )}
          <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted">
            <ShieldCheck size={14} className="text-success" /> Keys never leave this browser
          </span>
        </div>
        {children}
      </div>
    </div>
  );
}

function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("rounded-3xl border border-line bg-surface p-5 shadow-xl shadow-black/5 sm:p-7", className)}>{children}</div>;
}

export function Welcome() {
  return (
    <Frame>
      <div className="flex flex-1 flex-col justify-center">
        <img src="/logo.png" alt="Tesserax" className="mx-auto size-24 drop-shadow-[0_8px_30px_rgba(77,134,255,0.35)]" />
        <h1 className="mt-6 text-center text-3xl font-bold tracking-tight sm:text-4xl">Tesserax Wallet</h1>
        <p className="mx-auto mt-3 max-w-md text-center text-muted">
          Post-quantum accounts for people and AI agents: send TESS, give agents a budget, pay services and order work.
        </p>
        <div className="mt-10 space-y-3">
          <Link to="/create" className="flex items-center gap-4 rounded-2xl border border-accent/40 bg-accent-soft p-4 hover:border-accent">
            <span className="flex size-11 items-center justify-center rounded-xl bg-accent text-white">
              <Sparkles size={20} />
            </span>
            <span>
              <span className="block font-semibold">Create a new wallet</span>
              <span className="block text-sm text-muted">A new account and its 24-word recovery phrase</span>
            </span>
          </Link>
          <Link to="/import" className="flex items-center gap-4 rounded-2xl border border-line bg-surface p-4 hover:border-line-strong">
            <span className="flex size-11 items-center justify-center rounded-xl bg-surface-3 text-accent">
              <Download size={20} />
            </span>
            <span>
              <span className="block font-semibold">Import an account</span>
              <span className="block text-sm text-muted">From a recovery phrase, or a file of the command line wallet</span>
            </span>
          </Link>
        </div>
        <p className="mt-8 text-center text-xs text-faint">ML-DSA-87 signatures (FIPS 204) · Argon2id and ChaCha20-Poly1305 encryption</p>
      </div>
    </Frame>
  );
}

/** The wallet password, chosen twice, strong enough. */
function NewPassword({ onDone, submitLabel, initialName = "main", askName = true }: { onDone: (password: string, name: string) => void; submitLabel: string; initialName?: string; askName?: boolean }) {
  const [name, setName] = useState(initialName);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const strength = passwordStrength(password);
  const errors = {
    name: !validName(name) ? "Letters, digits, “-” and “_”" : null,
    password: strength.score < 2 ? "Choose a stronger password" : null,
    confirm: confirm !== password ? "The passwords differ" : null,
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSubmitted(true);
    if (!errors.name && !errors.password && !errors.confirm) onDone(password, name);
  };
  return (
    <form onSubmit={submit} className="space-y-4">
      {askName && <TextInput label="Account name" value={name} onChange={(e) => setName(e.target.value)} error={submitted ? errors.name : null} />}
      <div>
        <PasswordInput label="Wallet password" value={password} onChange={setPassword} error={submitted ? errors.password : null} autoFocus newPassword hint="Encrypts every account in this browser" />
        <StrengthMeter password={password} />
      </div>
      <PasswordInput label="Repeat the password" value={confirm} onChange={setConfirm} error={submitted ? errors.confirm : null} newPassword />
      <p className="text-xs text-muted">Nobody can recover this password. If you forget it, restore the wallet from its recovery phrase.</p>
      <Button type="submit" className="w-full">
        {submitLabel}
      </Button>
    </form>
  );
}

/** The phrase, hidden until revealed, then three words to check it was written down. */
export function BackupPhrase({ phrase, onConfirmed, confirmLabel = "Continue" }: { phrase: string; onConfirmed: () => void; confirmLabel?: string }) {
  const words = phrase.split(" ");
  const [revealed, setRevealed] = useState(false);
  const [written, setWritten] = useState(false);
  const [checking, setChecking] = useState(false);
  // Three distinct random positions.
  const positions = useMemo(() => {
    const picked = new Set<number>();
    const random = crypto.getRandomValues(new Uint32Array(16));
    for (const r of random) {
      picked.add(r % words.length);
      if (picked.size === 3) break;
    }
    return [...picked].sort((a, b) => a - b);
  }, [phrase]);
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [error, setError] = useState<string | null>(null);

  if (checking) {
    return (
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (positions.every((p, i) => answers[i].trim().toLowerCase() === words[p])) onConfirmed();
          else setError("These words do not match your phrase. Check what you wrote down.");
        }}
        className="space-y-4"
      >
        <p className="text-sm text-muted">Enter these words of your recovery phrase.</p>
        {positions.map((p, i) => (
          <TextInput
            key={p}
            label={`Word #${p + 1}`}
            value={answers[i]}
            autoFocus={i === 0}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              const next = [...answers];
              next[i] = e.target.value;
              setAnswers(next);
              setError(null);
            }}
          />
        ))}
        <ErrorText>{error}</ErrorText>
        <div className="flex gap-3">
          <Button variant="secondary" className="flex-1" onClick={() => setChecking(false)}>
            See the phrase
          </Button>
          <Button type="submit" className="flex-1">
            {confirmLabel}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="space-y-5">
      <div className="rounded-xl border border-warning/30 bg-warning-soft px-4 py-3 text-sm text-warning">
        <div className="flex gap-2">
          <TriangleAlert size={16} className="mt-0.5 shrink-0" />
          <span>
            These 24 words are the only way to recover the account. Write them on paper, in order, and keep them offline. Anyone who has them owns the account.
          </span>
        </div>
      </div>
      <div className="relative">
        <ol className={cx("grid grid-cols-2 gap-2 sm:grid-cols-3", !revealed && "select-none blur-md")} aria-hidden={!revealed}>
          {words.map((word, i) => (
            <li key={i} className="flex items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 font-mono text-sm">
              <span className="w-5 text-right text-xs text-faint tabular">{i + 1}</span>
              {revealed ? word : "•••••"}
            </li>
          ))}
        </ol>
        {!revealed && (
          <button onClick={() => setRevealed(true)} className="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-xl text-sm font-semibold">
            <Eye size={22} className="text-accent" />
            Reveal the phrase
            <span className="text-xs font-normal text-muted">Make sure nobody can see your screen</span>
          </button>
        )}
      </div>
      <label className="flex cursor-pointer items-start gap-3 text-sm">
        <input type="checkbox" checked={written} onChange={(e) => setWritten(e.target.checked)} className="mt-0.5 size-4 accent-[var(--accent)]" />
        I wrote the 24 words down, in order, and keep them somewhere safe.
      </label>
      <Button className="w-full" disabled={!revealed || !written} onClick={() => setChecking(true)}>
        Check my backup
      </Button>
    </div>
  );
}

export function CreateWallet() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [step, setStep] = useState<"password" | "phrase">("password");
  const [credentials, setCredentials] = useState<{ password: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Generated once; held in this page only.
  const phrase = useMemo(() => Keypair.generate().phrase, []);
  return (
    <Frame back="/welcome">
      <h1 className="text-2xl font-bold tracking-tight">{step === "password" ? "Create your wallet" : "Back up your recovery phrase"}</h1>
      <p className="mb-6 mt-1 text-sm text-muted">Step {step === "password" ? 1 : 2} of 2</p>
      <Panel>
        {step === "password" ? (
          <NewPassword
            submitLabel="Continue"
            onDone={(password, name) => {
              setCredentials({ password, name });
              setStep("phrase");
            }}
          />
        ) : busy ? (
          <div className="py-10 text-center text-sm text-muted">Encrypting the account…</div>
        ) : (
          <>
            <BackupPhrase
              phrase={phrase}
              confirmLabel="Create the wallet"
              onConfirmed={async () => {
                setBusy(true);
                try {
                  await wallet.create(credentials!.password, credentials!.name, phrase, true);
                  navigate("/");
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            />
            <ErrorText>{error}</ErrorText>
          </>
        )}
      </Panel>
    </Frame>
  );
}

/** A phrase or a keystore file, and what it unlocks: shared by the first import and by adding
 * an account later. */
export function ImportSource({ onSecret, onFile }: { onSecret: (secret: string) => void; onFile: (file: unknown, password: string) => Promise<void> }) {
  const [mode, setMode] = useState<"phrase" | "file">("phrase");
  const [phrase, setPhrase] = useState("");
  const [file, setFile] = useState<{ name: string; content: unknown } | null>(null);
  const [filePassword, setFilePassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => {
    try {
      return phrase.trim() ? Keypair.fromUri(cleanSecret(phrase)).address : null;
    } catch {
      return null;
    }
  }, [phrase]);
  // Once the phrase looks complete, say what is wrong with it.
  const problem = !preview && cleanSecret(phrase).split(" ").length >= 12 ? phraseProblem(phrase) : null;
  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-3 p-1">
        {(["phrase", "file"] as const).map((m) => (
          <button key={m} onClick={() => { setMode(m); setError(null); }} className={cx("flex items-center justify-center gap-2 rounded-lg py-2 text-sm font-medium", mode === m ? "bg-surface text-fg shadow-sm" : "text-muted")}>
            {m === "phrase" ? <KeyRound size={15} /> : <FileKey2 size={15} />}
            {m === "phrase" ? "Recovery phrase" : "Keystore file"}
          </button>
        ))}
      </div>
      {mode === "phrase" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (!preview) setError(phraseProblem(phrase) ?? "Not a valid recovery phrase");
            else onSecret(cleanSecret(phrase));
          }}
          className="space-y-4"
        >
          <TextArea label="Recovery phrase" value={phrase} onChange={(e) => { setPhrase(e.target.value); setError(null); }} placeholder="24 words separated by spaces" spellCheck={false} autoComplete="off" autoFocus error={error ?? problem} rows={4} />
          {preview && (
            <div className="flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
              <Identicon address={preview} size={20} />
              <span className="min-w-0 truncate font-mono text-xs">{preview}</span>
            </div>
          )}
          <Button type="submit" className="w-full" disabled={!phrase.trim()}>
            Continue
          </Button>
        </form>
      ) : (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            if (!file) return;
            setBusy(true);
            try {
              await onFile(file.content, filePassword);
            } catch (err) {
              setError(err instanceof KeystoreError && err.kind === "wrong-password" ? "Wrong password for this file" : (err as Error).message);
            } finally {
              setBusy(false);
            }
          }}
          className="space-y-4"
        >
          <input
            ref={input}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={async (e) => {
              const picked = e.target.files?.[0];
              if (!picked) return;
              setError(null);
              if (picked.size > 64 * 1024) return setError("This file is too large to be a keystore file");
              try {
                const content = JSON.parse(await picked.text());
                parseKeystore(content);
                setFile({ name: picked.name, content });
              } catch {
                setFile(null);
                setError("Not a Tesserax keystore file");
              }
            }}
          />
          <button type="button" onClick={() => input.current?.click()} className="flex w-full flex-col items-center gap-2 rounded-2xl border border-dashed border-line-strong bg-surface-2 px-4 py-8 text-sm hover:border-accent">
            <Upload size={22} className="text-accent" />
            {file ? <span className="font-medium">{file.name}</span> : <span className="font-medium">Choose a .json file</span>}
            <span className="text-xs text-muted">From ~/.tesserax/wallet, made by tesserax-wallet account</span>
          </button>
          {file && <PasswordInput label="Password of this file" value={filePassword} onChange={setFilePassword} autoFocus />}
          <ErrorText>{error}</ErrorText>
          <Button type="submit" className="w-full" disabled={!file || !filePassword} busy={busy}>
            {busy ? "Decrypting" : "Continue"}
          </Button>
        </form>
      )}
    </div>
  );
}

export function ImportWallet() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [secret, setSecret] = useState<{ value: string; name?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Frame back="/welcome">
      <h1 className="text-2xl font-bold tracking-tight">Import an account</h1>
      <p className="mb-6 mt-1 text-sm text-muted">Step {secret ? 2 : 1} of 2</p>
      <Panel>
        {!secret ? (
          <ImportSource
            onSecret={(value) => setSecret({ value })}
            onFile={async (content, password) => {
              const file = parseKeystore(content);
              setSecret({ value: await decrypt(file, password), name: file.name });
            }}
          />
        ) : busy ? (
          <div className="py-10 text-center text-sm text-muted">Encrypting the account…</div>
        ) : (
          <>
            <NewPassword
              submitLabel="Import"
              initialName={secret.name ?? "main"}
              onDone={async (password, name) => {
                setBusy(true);
                try {
                  await wallet.create(password, name, secret.value, true);
                  navigate("/");
                } catch (e) {
                  setError((e as Error).message);
                  setBusy(false);
                }
              }}
            />
            <ErrorText>{error}</ErrorText>
          </>
        )}
      </Panel>
    </Frame>
  );
}

export function Unlock() {
  const wallet = useWallet();
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const account = wallet.active;
  return (
    <Frame>
      <div className="flex flex-1 flex-col justify-center">
        <img src="/logo.png" alt="Tesserax" className="mx-auto size-20 drop-shadow-[0_8px_30px_rgba(77,134,255,0.35)]" />
        <h1 className="mt-5 text-center text-2xl font-bold tracking-tight">Welcome back</h1>
        {account && (
          <div className="mx-auto mt-3 flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1.5 text-sm">
            <Identicon address={account.address} size={18} />
            <span className="font-medium">{account.name}</span>
          </div>
        )}
        <Panel className="mt-8">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              setBusy(true);
              setError(null);
              try {
                await wallet.unlock(password);
              } catch (err) {
                setError(err instanceof KeystoreError && err.kind === "wrong-password" ? "Wrong password" : (err as Error).message);
                setBusy(false);
              }
            }}
            className="space-y-4"
          >
            <PasswordInput label="Wallet password" value={password} onChange={(v) => { setPassword(v); setError(null); }} error={error} autoFocus />
            <Button type="submit" className="w-full" busy={busy} disabled={!password}>
              <Lock size={16} /> {busy ? "Unlocking" : "Unlock"}
            </Button>
          </form>
        </Panel>
        <p className="mt-6 text-center text-sm text-muted">
          Forgot the password? <Link to="/restore" className="font-medium text-accent">Restore from your recovery phrase</Link>
        </p>
      </div>
    </Frame>
  );
}

/** Forgotten password: delete the wallet from this browser, then import again. */
export function Restore() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState("");
  return (
    <Frame back="/">
      <h1 className="text-2xl font-bold tracking-tight">Restore the wallet</h1>
      <Panel className="mt-6 space-y-4">
        <p className="text-sm text-muted">
          The wallet will be deleted from this browser, with its {wallet.accounts.length} account{wallet.accounts.length === 1 ? "" : "s"}. You will then import each account again from its recovery phrase. Accounts whose phrase you do not have are lost.
        </p>
        <TextInput label={<>Type <span className="font-mono">DELETE</span> to confirm</>} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        <Button
          variant="danger"
          className="w-full"
          disabled={confirm !== "DELETE"}
          onClick={async () => {
            await wallet.reset();
            navigate("/import");
          }}
        >
          Delete and restore
        </Button>
      </Panel>
    </Frame>
  );
}
