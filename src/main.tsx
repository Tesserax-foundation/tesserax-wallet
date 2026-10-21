import "@fontsource-variable/inter";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { createBrowserRouter, Navigate, Outlet, RouterProvider, useLocation } from "react-router";
import { Layout } from "./components/Layout";
import { TransactionProvider } from "./components/Transaction";
import "./index.css";
import { ChainProvider } from "./lib/chain";
import { useWallet, WalletProvider } from "./lib/session";
import { Accounts, AddAccount } from "./pages/Accounts";
import { Agents } from "./pages/Agents";
import { Channels } from "./pages/Channels";
import { Home, Receive, Send } from "./pages/Home";
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

/** Pages before the wallet exists: once it does, they lead home. */
function Onboarding() {
  const wallet = useWallet();
  if (!wallet.ready) return <Splash />;
  if (wallet.accounts.length > 0 && wallet.unlocked) return <Navigate to="/" replace />;
  if (wallet.accounts.length > 0) return <Navigate to="/" replace />;
  return <Outlet />;
}

/** The wallet itself: created and unlocked. */
function Unlocked() {
  const wallet = useWallet();
  const location = useLocation();
  if (!wallet.ready) return <Splash />;
  if (wallet.accounts.length === 0) return <Navigate to="/welcome" replace />;
  if (!wallet.unlocked) return location.pathname === "/restore" ? <Restore /> : <Unlock />;
  if (location.pathname === "/restore") return <Navigate to="/" replace />;
  return (
    <ChainProvider>
      <TransactionProvider>
        <Layout />
      </TransactionProvider>
    </ChainProvider>
  );
}

function NotFound() {
  return <Navigate to="/" replace />;
}

const router = createBrowserRouter([
  {
    element: <Onboarding />,
    children: [
      { path: "/welcome", element: <Welcome /> },
      { path: "/create", element: <CreateWallet /> },
      { path: "/import", element: <ImportWallet /> },
    ],
  },
  {
    element: <Unlocked />,
    children: [
      { path: "/", element: <Home /> },
      { path: "/send", element: <Send /> },
      { path: "/receive", element: <Receive /> },
      { path: "/agents", element: <Agents /> },
      { path: "/channels", element: <Channels /> },
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

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queries}>
      <WalletProvider>
        <RouterProvider router={router} />
      </WalletProvider>
    </QueryClientProvider>
  </StrictMode>,
);
