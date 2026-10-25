import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, createHashRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { TransactionProvider } from "./components/Transaction";
import "./index.css";
import { ChainProvider } from "./lib/chain";
import { MarketProvider } from "./lib/swaps";
import { isDesktop, isExtension, isPopup, openExternal, openInTab } from "./lib/platform";
import { useWallet, WalletProvider } from "./lib/session";
import { Accounts, AddAccount } from "./pages/Accounts";
import { Agents } from "./pages/Agents";
import { Approve } from "./pages/Approve";
import { Channels } from "./pages/Channels";
import { ContractDetail, Contracts } from "./pages/Contracts";
import { Governance } from "./pages/Governance";
import { Market } from "./pages/Market";
import { Home, Receive, Send } from "./pages/Home";
import { Private } from "./pages/Private";
import { CreateWallet, ImportWallet, Restore, Unlock, Welcome } from "./pages/Onboarding";
import { Settings } from "./pages/Settings";
import { TaskDetail, Tasks } from "./pages/Tasks";

const queries = new QueryClient({
  defaultOptions: { queries: { staleTime: 5_000, retry: 1, refetchOnWindowFocus: true } },
});

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center">
      <img src="/logo.png" alt="" className="size-16 animate-pulse" />
    </div>
  );
}

/** The popup closes at the first click elsewhere: setting up a wallet happens in a tab. */
function ContinueInTab({ path }: { path: string }) {
  return (
    <div className="flex min-h-dvh flex-col items-center justify-center gap-4 px-6 text-center">
      <img src="/logo.png" alt="" className="size-16" />
      <p className="text-sm text-muted">Set up Tesserax Wallet in a tab of its own, where it stays open while you write down your recovery phrase.</p>
      <button onClick={() => openInTab(path)} className="h-11 w-full rounded-xl bg-accent text-sm font-semibold text-white">
        Open Tesserax Wallet
      </button>
    </div>
  );
}

/** Pages before the wallet exists: once it does, they lead home. */
function Onboarding() {
  const wallet = useWallet();
  const location = useLocation();
  if (!wallet.ready) return <Splash />;
  if (isPopup && wallet.accounts.length === 0) return <ContinueInTab path={location.pathname} />;
  if (wallet.accounts.length > 0 && wallet.unlocked) return <Navigate to="/" replace />;
  if (wallet.accounts.length > 0) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** The wallet itself, created and unlocked: the pages of the wallet, or an approval window. */
function Unlocked({ children }: { children: ReactNode }) {
  const wallet = useWallet();
  const location = useLocation();
  if (!wallet.ready) return <Splash />;
  if (wallet.accounts.length === 0) return <Navigate to="/welcome" replace />;
  if (!wallet.unlocked) return location.pathname === "/restore" ? <Restore /> : <Unlock />;
  if (location.pathname === "/restore") return <Navigate to="/" replace />;
  return (
    <ChainProvider>
      <TransactionProvider>
        <MarketProvider>{children}</MarketProvider>
      </TransactionProvider>
    </ChainProvider>
  );
}

function NotFound() {
  return <Navigate to="/" replace />;
}

// Pages of the extension and of the desktop application are files: their routes live in the hash.
const router = (isExtension || isDesktop ? createHashRouter : createBrowserRouter)([
  {
    element: <Onboarding />,
    children: [
      { path: "/welcome", element: <Welcome /> },
      { path: "/create", element: <CreateWallet /> },
      { path: "/import", element: <ImportWallet /> },
    ],
  },
  ...(isExtension
    ? [
        {
          element: (
            <Unlocked>
              <Outlet />
            </Unlocked>
          ),
          children: [{ path: "/approve/:id", element: <Approve /> }],
        },
      ]
    : []),
  {
    element: (
      <Unlocked>
        <Layout />
      </Unlocked>
    ),
    children: [
      { path: "/", element: <Home /> },
      { path: "/send", element: <Send /> },
      { path: "/receive", element: <Receive /> },
      { path: "/private", element: <Private /> },
      { path: "/agents", element: <Agents /> },
      { path: "/channels", element: <Channels /> },
      { path: "/contracts", element: <Contracts /> },
      { path: "/contracts/:address", element: <ContractDetail /> },
      { path: "/governance", element: <Governance /> },
      { path: "/market", element: <Market /> },
      { path: "/tasks", element: <Tasks /> },
      { path: "/tasks/:id", element: <TaskDetail /> },
      { path: "/accounts", element: <Accounts /> },
      { path: "/accounts/add", element: <AddAccount /> },
      { path: "/settings", element: <Settings /> },
      { path: "/restore", element: null },
      { path: "*", element: <NotFound /> },
    ],
  },
]);

// The desktop window shows the wallet only: links out, such as to the explorer, open in the browser.
if (isDesktop) {
  document.addEventListener("click", (event) => {
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
    if (link && /^https?:/.test(link.href) && new URL(link.href).origin !== location.origin) {
      event.preventDefault();
      void openExternal(link.href);
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <WalletProvider>
        <RouterProvider router={router} />
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
);
