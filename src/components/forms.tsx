import { Amount } from "@tesserax/sdk";
import { Eye, EyeOff, Loader2 } from "lucide-react";
import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type TextareaHTMLAttributes } from "react";
import { normalizeAddress } from "../lib/chain";
import { formatTess } from "../lib/format";
import { useWallet } from "../lib/session";
import { Identicon } from "./links";
import { cx } from "./ui";

type Variant = "primary" | "secondary" | "danger" | "ghost";

const variants: Record<Variant, string> = {
  primary: "bg-accent text-white hover:bg-accent-strong shadow-[0_6px_20px_-8px_var(--accent)]",
  secondary: "border border-line bg-surface text-fg hover:border-line-strong",
  danger: "bg-danger text-white hover:opacity-90",
  ghost: "text-muted hover:bg-surface-2 hover:text-fg",
};

const sizes = { md: "h-11 px-4", sm: "h-9 px-3.5" };

export function Button({ variant = "primary", size = "md", busy, className, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: keyof typeof sizes; busy?: boolean }) {
  return (
    <button
      type="button"
      {...props}
      disabled={props.disabled || busy}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-xl text-sm font-semibold transition-colors disabled:pointer-events-none disabled:opacity-50",
        sizes[size],
        variants[variant],
        className,
      )}
    >
      {busy && <Loader2 size={16} className="animate-spin" />}
      {children}
    </button>
  );
}

export function Label({ htmlFor, children, hint }: { htmlFor?: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="mb-1.5 flex items-baseline justify-between gap-2">
      <label htmlFor={htmlFor} className="text-sm font-medium">
        {children}
      </label>
      {hint && <span className="text-xs text-muted">{hint}</span>}
    </div>
  );
}

const inputClass = (error?: string | null) =>
  cx(
    "h-11 w-full rounded-xl border bg-surface px-3.5 text-[15px] text-fg placeholder:text-faint outline-none transition-shadow focus:ring-4",
    error ? "border-danger focus:ring-danger-soft" : "border-line focus:border-accent focus:ring-accent-soft",
  );

export function ErrorText({ children }: { children?: ReactNode }) {
  return children ? <p className="mt-1.5 text-sm text-danger">{children}</p> : null;
}

/** `mono` sets the field, not its label, in the monospace font: for URLs, addresses and data. */
export function TextInput({ label, hint, error, className, mono, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null; mono?: boolean }) {
  const id = useId();
  return (
    <div className={className}>
      {label && <Label htmlFor={id} hint={hint}>{label}</Label>}
      <input id={id} {...props} className={cx(inputClass(error), mono && "font-mono text-[13px]")} aria-invalid={Boolean(error)} />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

export function TextArea({ label, hint, error, className, mono, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label?: ReactNode; hint?: ReactNode; error?: string | null; mono?: boolean }) {
  const id = useId();
  return (
    <div className={className}>
      {label && <Label htmlFor={id} hint={hint}>{label}</Label>}
      <textarea id={id} {...props} className={cx(inputClass(error), "h-auto min-h-24 py-3 leading-relaxed", mono && "font-mono text-[13px]")} aria-invalid={Boolean(error)} />
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** A password field with a visibility toggle. */
export function PasswordInput({ label, value, onChange, error, autoFocus, placeholder, hint, newPassword }: { label: ReactNode; value: string; onChange: (value: string) => void; error?: string | null; autoFocus?: boolean; placeholder?: string; hint?: ReactNode; newPassword?: boolean }) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <div>
      <Label htmlFor={id} hint={hint}>{label}</Label>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          placeholder={placeholder}
          autoComplete={newPassword ? "new-password" : "current-password"}
          spellCheck={false}
          className={cx(inputClass(error), "pr-11")}
          aria-invalid={Boolean(error)}
        />
        <button type="button" onClick={() => setVisible(!visible)} aria-label={visible ? "Hide the password" : "Show the password"} className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-faint hover:text-fg">
          {visible ? <EyeOff size={16} /> : <Eye size={16} />}
        </button>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** A rough strength estimate: length and variety of characters. */
export function passwordStrength(password: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let pool = 0;
  if (/[a-z]/.test(password)) pool += 26;
  if (/[A-Z]/.test(password)) pool += 26;
  if (/[0-9]/.test(password)) pool += 10;
  if (/[^A-Za-z0-9]/.test(password)) pool += 33;
  const bits = password.length * Math.log2(Math.max(pool, 1));
  const score = bits < 40 ? 0 : bits < 60 ? 1 : bits < 80 ? 2 : bits < 100 ? 3 : 4;
  return { score: password.length < 10 ? 0 : (score as 0 | 1 | 2 | 3 | 4), label: ["Too weak", "Weak", "Fair", "Strong", "Very strong"][password.length < 10 ? 0 : score] };
}

export function StrengthMeter({ password }: { password: string }) {
  const { score, label } = passwordStrength(password);
  const colors = ["bg-danger", "bg-warning", "bg-warning", "bg-success", "bg-success"];
  return (
    <div className="mt-2">
      <div className="flex gap-1">
        {[0, 1, 2, 3].map((i) => (
          <span key={i} className={cx("h-1.5 flex-1 rounded-full", password && i < Math.max(1, score) ? colors[score] : "bg-surface-3")} />
        ))}
      </div>
      {password && <p className="mt-1 text-xs text-muted">{label}{score < 2 ? " · use 12 characters or more, or a passphrase of several words" : ""}</p>}
    </div>
  );
}

/** An address, or the name of an account of the wallet. */
export function AddressInput({ label, value, onChange, error, exclude, placeholder = "te…" }: { label: ReactNode; value: string; onChange: (value: string) => void; error?: string | null; exclude?: string; placeholder?: string }) {
  const id = useId();
  const { accounts } = useWallet();
  const own = accounts.filter((a) => a.address !== exclude);
  const valid = value ? normalizeAddress(value) : null;
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <div className="relative">
        {valid && <Identicon address={valid} size={22} className="absolute left-3 top-1/2 -translate-y-1/2" />}
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={cx(inputClass(error ?? (value && !valid ? "x" : null)), "font-mono text-[13px]", valid && "pl-11")}
        />
      </div>
      <ErrorText>{error ?? (value && !valid ? (value.startsWith("te") ? "Not a valid address: check that it is complete" : "Not a Tesserax address: they start with “te”.") : null)}</ErrorText>
      {own.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {own.slice(0, 6).map((a) => (
            <button key={a.name} type="button" onClick={() => onChange(a.address)} className="inline-flex items-center gap-1.5 rounded-full border border-line bg-surface px-2.5 py-1 text-xs font-medium text-muted hover:text-fg">
              <Identicon address={a.address} size={14} /> {a.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** An amount in TESS; `max` fills the field. */
export function AmountInput({ label, value, onChange, error, max, hint }: { label: ReactNode; value: string; onChange: (value: string) => void; error?: string | null; max?: Amount; hint?: ReactNode }) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id} hint={hint ?? (max ? <>Available {formatTess(max.planck, 4)} TESS</> : undefined)}>{label}</Label>
      <div className="relative">
        <input
          id={id}
          value={value}
          onChange={(e) => onChange(e.target.value.replace(",", ".").replace(/[^0-9.]/g, ""))}
          inputMode="decimal"
          placeholder="0.0"
          autoComplete="off"
          className={cx(inputClass(error), "pr-24 text-lg font-semibold tabular")}
        />
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1.5">
          {max && (
            <button type="button" onClick={() => onChange(formatTess(max.planck, 12).replace(/,/g, ""))} className="rounded-md bg-accent-soft px-2 py-1 text-xs font-semibold text-accent">
              MAX
            </button>
          )}
          <span className="text-sm font-medium text-muted">TESS</span>
        </div>
      </div>
      <ErrorText>{error}</ErrorText>
    </div>
  );
}

/** `text` as an amount, or the reason it is not one. */
export function parseAmount(text: string, { min, max }: { min?: bigint; max?: bigint } = {}): { amount?: Amount; error?: string } {
  if (!text) return {};
  let amount: Amount;
  try {
    amount = Amount.fromTess(text);
  } catch {
    return { error: "Enter an amount with at most 12 decimals" };
  }
  if (amount.planck === 0n) return { error: "Enter an amount above zero" };
  if (min != null && amount.planck < min) return { error: `At least ${formatTess(min, 12)} TESS` };
  if (max != null && amount.planck > max) return { error: "More than available" };
  return { amount };
}

export function Toggle({ checked, onChange, label, description }: { checked: boolean; onChange: (checked: boolean) => void; label: ReactNode; description?: ReactNode }) {
  const id = useId();
  return (
    <label className="flex cursor-pointer items-start justify-between gap-4">
      <span>
        <span id={id} className="block text-sm font-medium">{label}</span>
        {description && <span className="mt-0.5 block text-xs text-muted">{description}</span>}
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        onClick={() => onChange(!checked)}
        className={cx("relative mt-0.5 h-6 w-11 shrink-0 rounded-full transition-colors", checked ? "bg-accent" : "bg-surface-3")}
      >
        <span className={cx("absolute top-0.5 size-5 rounded-full bg-white shadow transition-transform", checked ? "translate-x-5.5" : "translate-x-0.5")} />
      </button>
    </label>
  );
}

export function Select<T extends string>({ label, value, onChange, options }: { label: ReactNode; value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string }> }) {
  const id = useId();
  return (
    <div>
      <Label htmlFor={id}>{label}</Label>
      <select id={id} value={value} onChange={(e) => onChange(e.target.value as T)} className={cx(inputClass(), "appearance-none")}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}
