import { ArrowDownLeft, ArrowUpRight, Bot, Check, ChevronDown, EyeOff, Home, Lock, Maximize2, Menu, Moon, Plus, Settings, Sun, Users, Wallet, X, Zap } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router";
import { useChain, useNodeStatus, WrongChain } from "../lib/chain";
import { shortAddress } from "../lib/format";
import { useTheme } from "../lib/hooks";
import { isPopup, openInTab } from "../lib/platform";
import { useWallet } from "../lib/session";
import { CopyButton, Identicon } from "./links";
import { cx } from "./ui";

const nav = [
  { to: "/", label: "Home", icon: Home, end: true },
  { to: "/send", label: "Send", icon: ArrowUpRight },
  { to: "/receive", label: "Receive", icon: ArrowDownLeft },
  { to: "/private", label: "Private", icon: EyeOff },
  { to: "/agents", label: "AI agents", icon: Bot },
  { to: "/tasks", label: "Task market", icon: Users },
  { to: "/channels", label: "Payment channels", icon: Zap },
  { to: "/accounts", label: "Accounts", icon: Wallet },
  { to: "/settings", label: "Settings", icon: Settings },
];

/** Tabs of the mobile bar; the rest is in the menu. */
const tabs = [nav[0], nav[1], nav[3], nav[4]];

export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex shrink-0 items-center gap-2.5" aria-label="Tesserax Wallet home">
      <img src="/logo.png" alt="" width={34} height={34} className="size-[34px] drop-shadow-[0_0_10px_rgba(77,134,255,0.35)]" />
      {!compact && (
        <span className="leading-tight">
          <span className="block text-[17px] font-bold tracking-tight">Tesserax</span>
          <span className="block text-[11px] font-medium uppercase tracking-[0.18em] text-muted">Wallet</span>
        </span>
      )}
    </Link>
  );
}

function NodeStatus() {
  const { network } = useChain();
  const { data, error, isLoading } = useNodeStatus();
  const ok = Boolean(data) && !error;
  return (
    <Link
      to="/settings"
      title={error ? (error as Error).message : data ? `Block #${data.bestBlock.toLocaleString("en-US")}` : "Connecting"}
      className={cx("inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium", network.test ? "border-warning/40 bg-warning-soft text-warning" : "border-line bg-surface text-muted")}
    >
      <span className={cx("size-1.5 rounded-full", isLoading ? "animate-pulse bg-warning" : ok ? "bg-success shadow-[0_0_6px_var(--success)]" : "bg-danger")} />
      {network.name}
      {data && <span className="hidden tabular text-faint sm:inline">#{data.bestBlock.toLocaleString("en-US")}</span>}
    </Link>
  );
}

/** The node serves another chain than the network chosen: what it shows is not of that network. */
function WrongChainBanner() {
  const { network } = useChain();
  const { error } = useNodeStatus();
  if (!(error instanceof WrongChain)) return null;
  return (
    <div className="border-b border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger sm:px-6">
      The node is not on the {network.name.toLowerCase()}: balances and transactions shown here are of another chain.{" "}
      <Link to="/settings" className="font-semibold underline">
        Change the node
      </Link>
    </div>
  );
}

function ThemeButton() {
  const [theme, toggle] = useTheme();
  return (
    <button onClick={toggle} aria-label={theme === "dark" ? "Light theme" : "Dark theme"} className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-fg">
      {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );
}

/** The active account, and a menu to switch to another. */
function AccountSwitcher({ className }: { className?: string }) {
  const wallet = useWallet();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, []);
  const active = wallet.active;
  if (!active) return null;
  return (
    <div ref={ref} className={cx("relative", className)}>
      <button onClick={() => setOpen(!open)} aria-expanded={open} className="flex w-full items-center gap-3 rounded-2xl border border-line bg-surface p-2.5 text-left hover:border-line-strong">
        <Identicon address={active.address} size={36} className="rounded-xl" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-semibold">{active.name}</span>
          <span className="block truncate font-mono text-xs text-muted">{shortAddress(active.address, 8, 6)}</span>
        </span>
        <ChevronDown size={16} className={cx("shrink-0 text-faint transition-transform", open && "rotate-180")} />
      </button>
      {open && (
        <div className="absolute left-0 right-0 top-full z-50 mt-2 rounded-2xl border border-line bg-surface p-1.5 shadow-xl shadow-black/10">
          {wallet.accounts.map((a) => (
            <button
              key={a.name}
              onClick={() => {
                void wallet.setActive(a.name);
                setOpen(false);
              }}
              className="flex w-full items-center gap-3 rounded-xl px-2.5 py-2 text-left hover:bg-surface-2"
            >
              <Identicon address={a.address} size={28} className="rounded-lg" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium">{a.name}</span>
                <span className="block truncate font-mono text-xs text-muted">{shortAddress(a.address)}</span>
              </span>
              {a.name === active.name && <Check size={16} className="text-accent" />}
            </button>
          ))}
          <button
            onClick={() => {
              setOpen(false);
              navigate("/accounts/add");
            }}
            className="mt-1 flex w-full items-center gap-2 rounded-xl border-t border-line px-2.5 py-2.5 text-sm font-medium text-accent hover:bg-surface-2"
          >
            <Plus size={16} /> Add an account
          </button>
        </div>
      )}
    </div>
  );
}

function SideNav({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <nav className="space-y-0.5">
      {nav.map(({ to, label, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          end={end}
          onClick={onNavigate}
          className={({ isActive }) => cx("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors", isActive ? "bg-accent-soft text-accent" : "text-muted hover:bg-surface-2 hover:text-fg")}
        >
          <Icon size={18} />
          {label}
        </NavLink>
      ))}
    </nav>
  );
}

export function Layout() {
  const wallet = useWallet();
  const [menu, setMenu] = useState(false);
  const location = useLocation();
  useEffect(() => setMenu(false), [location.pathname]);
  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[280px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col border-r border-line bg-surface/60 p-5 lg:flex">
        <Logo />
        <AccountSwitcher className="mt-6" />
        <div className="mt-5 flex-1 overflow-y-auto">
          <SideNav />
        </div>
        <button onClick={wallet.lock} className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-surface-2 hover:text-fg">
          <Lock size={18} /> Lock the wallet
        </button>
      </aside>

      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-40 border-b border-line bg-bg/80 backdrop-blur-xl">
          <div className="flex h-16 items-center gap-3 px-4 sm:px-6">
            <div className="lg:hidden">
              <Logo compact />
            </div>
            {wallet.active && (
              <div className="flex min-w-0 items-center gap-1 lg:hidden">
                <span className="truncate text-sm font-semibold">{wallet.active.name}</span>
                <CopyButton value={wallet.active.address} />
              </div>
            )}
            <div className="ml-auto flex items-center gap-2">
              <NodeStatus />
              <ThemeButton />
              <button onClick={wallet.lock} aria-label="Lock the wallet" title="Lock the wallet" className="hidden size-9 items-center justify-center rounded-lg border border-line bg-surface text-muted hover:text-fg sm:flex lg:hidden">
                <Lock size={16} />
              </button>
              <button onClick={() => setMenu(true)} aria-label="Open the menu" className="flex size-9 items-center justify-center rounded-lg border border-line bg-surface lg:hidden">
                <Menu size={18} />
              </button>
            </div>
          </div>
        </header>
        <main className="flex-1 pb-24 lg:pb-0">
          <WrongChainBanner />
          <Outlet />
        </main>
      </div>

      {/* Mobile tabs. */}
      <nav className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-4 border-t border-line bg-bg/90 pb-[env(safe-area-inset-bottom)] backdrop-blur-xl lg:hidden">
        {tabs.map(({ to, label, icon: Icon, end }) => (
          <NavLink key={to} to={to} end={end} className={({ isActive }) => cx("flex flex-col items-center gap-1 py-2.5 text-[11px] font-medium", isActive ? "text-accent" : "text-muted")}>
            <Icon size={20} />
            {label === "Task market" ? "Tasks" : label === "AI agents" ? "Agents" : label}
          </NavLink>
        ))}
      </nav>

      {menu && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={() => setMenu(false)} />
          <div className="absolute right-0 top-0 flex h-full w-[min(88vw,340px)] flex-col overflow-y-auto border-l border-line bg-surface p-4">
            <div className="mb-4 flex items-center justify-between">
              <Logo />
              <button onClick={() => setMenu(false)} aria-label="Close the menu" className="flex size-9 items-center justify-center rounded-lg border border-line">
                <X size={18} />
              </button>
            </div>
            <AccountSwitcher className="mb-4" />
            <SideNav onNavigate={() => setMenu(false)} />
            {isPopup && (
              <button onClick={() => openInTab(location.pathname)} className="mt-4 flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-surface-2">
                <Maximize2 size={18} /> Open in a tab
              </button>
            )}
            <button onClick={wallet.lock} className={cx("flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium text-muted hover:bg-surface-2", !isPopup && "mt-4")}>
              <Lock size={18} /> Lock the wallet
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Page width and padding. */
export function Page({ children, className, narrow }: { children: ReactNode; className?: string; narrow?: boolean }) {
  return <div className={cx("mx-auto w-full px-4 py-6 sm:px-6 sm:py-8", narrow ? "max-w-2xl" : "max-w-5xl", className)}>{children}</div>;
}
