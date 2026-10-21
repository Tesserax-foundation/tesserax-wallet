import { TesseraxClient } from "@tesserax/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe, Info, KeyRound, Link2, Lock, Network, RotateCcw, Settings as SettingsIcon, ShieldCheck, TriangleAlert } from "lucide-react";
import { useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { Button, ErrorText, PasswordInput, Select, StrengthMeter, TextInput, Toggle, passwordStrength } from "../components/forms";
import { network, Page } from "../components/Layout";
import { Sheet } from "../components/Sheet";
import { Card, CardHeader, Field, Fields, PageHeader, Skeleton } from "../components/ui";
import { AddressLink } from "../components/links";
import type { Connection } from "../extension/protocol";
import { useNodeStatus } from "../lib/chain";
import { formatDate } from "../lib/format";
import { isExtension, toBackground } from "../lib/platform";
import { KeystoreError } from "../lib/keystore";
import { useWallet } from "../lib/session";
import { defaultSettings } from "../lib/storage";

const isNodeUrl = (url: string) => /^wss?:\/\/[^\s/]+(\/[^\s]*)?$/.test(url);

/** Chain information of the node at `url`, or why it cannot be reached. */
async function probe(url: string) {
  const client = new TesseraxClient(url);
  try {
    return await Promise.race([client.chainInfo(), new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the node does not answer")), 8000))]);
  } finally {
    client.destroy();
  }
}

function Section({ title, icon, children }: { title: string; icon: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} icon={icon} />
      <div className="space-y-5 p-4 sm:p-5">{children}</div>
    </Card>
  );
}

export function Settings() {
  const wallet = useWallet();
  const navigate = useNavigate();
  const status = useNodeStatus();
  const [nodeUrl, setNodeUrl] = useState(wallet.settings.nodeUrl);
  const [explorerUrl, setExplorerUrl] = useState(wallet.settings.explorerUrl);
  const [nodeState, setNodeState] = useState<{ busy?: boolean; error?: string; ok?: string }>({});
  const [explorerError, setExplorerError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [resetting, setResetting] = useState(false);
  const defaults = defaultSettings();

  const saveNode = async (url: string) => {
    if (!isNodeUrl(url)) return setNodeState({ error: "A WebSocket URL such as wss://node.example.com" });
    if (location.protocol === "https:" && url.startsWith("ws://") && !/^ws:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
      return setNodeState({ error: "This page is served over HTTPS: use a wss:// node" });
    }
    setNodeState({ busy: true });
    try {
      const info = await probe(url);
      await wallet.updateSettings({ nodeUrl: url });
      setNodeUrl(url);
      setNodeState({ ok: `Connected to ${info.chain}, block #${info.bestBlock.toLocaleString("en-US")}` });
    } catch (e) {
      setNodeState({ error: `Cannot connect: ${(e as Error).message}` });
    }
  };

  return (
    <Page narrow className="space-y-6">
      <PageHeader title="Settings" icon={<SettingsIcon size={20} />} />

      <Section title="Network" icon={<Network size={16} />}>
        <div>
          <TextInput
            label="Node"
            hint={network}
            value={nodeUrl}
            onChange={(e) => {
              setNodeUrl(e.target.value.trim());
              setNodeState({});
            }}
            spellCheck={false}
            mono
            error={nodeState.error}
          />
          {nodeState.ok && <p className="mt-1.5 text-sm text-success">{nodeState.ok}</p>}
          <p className="mt-1.5 text-xs text-muted">The node only sees signed transactions. A node you do not trust can hide or delay them, but never sign for you.</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button size="sm" busy={nodeState.busy} disabled={nodeUrl === wallet.settings.nodeUrl && !nodeState.error} onClick={() => saveNode(nodeUrl)}>
              Connect
            </Button>
            {wallet.settings.nodeUrl !== defaults.nodeUrl && (
              <Button variant="ghost" size="sm" onClick={() => saveNode(defaults.nodeUrl)}>
                <RotateCcw size={14} /> Default node
              </Button>
            )}
          </div>
        </div>
        <div>
          <TextInput
            label="Explorer"
            hint="for links"
            value={explorerUrl}
            onChange={(e) => {
              setExplorerUrl(e.target.value.trim());
              setExplorerError(null);
            }}
            placeholder="https://explorer.example.com"
            spellCheck={false}
            mono
            error={explorerError}
          />
          <Button
            variant="secondary"
            size="sm" className="mt-3"
            disabled={explorerUrl === wallet.settings.explorerUrl}
            onClick={async () => {
              if (explorerUrl && !/^https?:\/\/[^\s]+$/.test(explorerUrl)) return setExplorerError("A URL such as https://explorer.example.com");
              await wallet.updateSettings({ explorerUrl });
            }}
          >
            Save
          </Button>
        </div>
      </Section>

      <Section title="Security" icon={<ShieldCheck size={16} />}>
        <Select
          label="Lock automatically after"
          value={String(wallet.settings.autoLockMinutes)}
          onChange={(v) => void wallet.updateSettings({ autoLockMinutes: Number(v) })}
          options={[1, 5, 15, 30, 60, 240].map((m) => ({ value: String(m), label: m < 60 ? `${m} minute${m > 1 ? "s" : ""} without activity` : `${m / 60} hour${m > 60 ? "s" : ""} without activity` }))}
        />
        <Toggle
          checked={wallet.settings.confirmWithPassword}
          onChange={(v) => void wallet.updateSettings({ confirmWithPassword: v })}
          label="Ask for the password before every transaction"
          description="Someone using this unlocked browser cannot send without it."
        />
        <div className="flex flex-wrap gap-2 border-t border-line pt-5">
          <Button variant="secondary" onClick={() => setChanging(true)}>
            <KeyRound size={16} /> Change the password
          </Button>
          <Button variant="secondary" onClick={wallet.lock}>
            <Lock size={16} /> Lock now
          </Button>
        </div>
      </Section>

      {isExtension && <ConnectedSites />}

      <Section title="About" icon={<Info size={16} />}>
        <div className="-mx-4 -my-5 sm:-mx-5">
          <Fields>
            <Field label="Chain">{status.data ? status.data.chain : status.isLoading ? <Skeleton className="h-4 w-32" /> : "Unreachable"}</Field>
            <Field label="Best block">{status.data ? `#${status.data.bestBlock.toLocaleString("en-US")}` : "—"}</Field>
            <Field label="Runtime version">{status.data?.specVersion ?? "—"}</Field>
            <Field label="Address format">{status.data ? `SS58 prefix ${status.data.ss58Prefix}, addresses start with “te”` : "—"}</Field>
            <Field label="Cryptography">ML-DSA-87 signatures · Argon2id and ChaCha20-Poly1305 for the keystore</Field>
            <Field label="Storage">{wallet.accounts.length} encrypted account{wallet.accounts.length === 1 ? "" : "s"} in this browser</Field>
          </Fields>
        </div>
      </Section>

      <Card className="border-danger/30">
        <CardHeader title="Danger zone" icon={<TriangleAlert size={16} className="text-danger" />} />
        <div className="flex flex-wrap items-center justify-between gap-4 p-4 sm:p-5">
          <p className="max-w-md text-sm text-muted">Delete the wallet and every account from this browser. Their TESS stay on chain, reachable with their recovery phrases.</p>
          <Button variant="danger" onClick={() => setResetting(true)}>
            Delete the wallet
          </Button>
        </div>
      </Card>

      {changing && <ChangePasswordSheet onClose={() => setChanging(false)} />}
      {resetting && (
        <ResetSheet
          onClose={() => setResetting(false)}
          onDone={() => {
            navigate("/welcome");
          }}
        />
      )}
      <p className="pb-4 text-center text-xs text-faint">
        <Globe size={12} className="mr-1 inline" />
        Tesserax Wallet · keys are encrypted and used in this browser only
      </p>
    </Page>
  );
}

function ChangePasswordSheet({ onClose }: { onClose: () => void }) {
  const wallet = useWallet();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const errors = {
    next: passwordStrength(next).score < 2 ? "Choose a stronger password" : next === current ? "The new password is the current one" : null,
    confirm: confirm !== next ? "The passwords differ" : null,
  };
  return (
    <Sheet title="Change the password" icon={<KeyRound size={18} />} onClose={onClose}>
      <form
        className="space-y-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setSubmitted(true);
          if (errors.next || errors.confirm) return;
          setBusy(true);
          try {
            await wallet.changePassword(current, next);
            onClose();
          } catch (err) {
            setError(err instanceof KeystoreError && err.kind === "wrong-password" ? "Wrong current password" : (err as Error).message);
            setBusy(false);
          }
        }}
      >
        <PasswordInput label="Current password" value={current} onChange={(v) => { setCurrent(v); setError(null); }} error={error} autoFocus />
        <div>
          <PasswordInput label="New password" value={next} onChange={setNext} error={submitted ? errors.next : null} newPassword />
          <StrengthMeter password={next} />
        </div>
        <PasswordInput label="Repeat the new password" value={confirm} onChange={setConfirm} error={submitted ? errors.confirm : null} newPassword />
        <p className="text-xs text-muted">Every account is encrypted again. Keystore files downloaded before keep the previous password.</p>
        <Button type="submit" className="w-full" busy={busy}>
          {busy ? "Encrypting" : "Change the password"}
        </Button>
      </form>
    </Sheet>
  );
}

function ResetSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const wallet = useWallet();
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const unsafe = wallet.accounts.filter((a) => !a.backedUp);
  return (
    <Sheet title="Delete the wallet" icon={<TriangleAlert size={18} />} onClose={onClose}>
      <div className="space-y-5">
        {unsafe.length > 0 && (
          <div className="rounded-xl border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger">
            Not backed up: {unsafe.map((a) => a.name).join(", ")}. Back them up first in Accounts, or their TESS are lost.
          </div>
        )}
        <TextInput label={<>Type <span className="font-mono">DELETE</span> to confirm</>} value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        <ErrorText>{error}</ErrorText>
        <Button
          variant="danger"
          className="w-full"
          disabled={confirm !== "DELETE"}
          onClick={async () => {
            try {
              await wallet.reset();
              onDone();
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Delete the wallet
        </Button>
      </div>
    </Sheet>
  );
}

/** Sites connected to the extension, and the accounts each may use. */
function ConnectedSites() {
  const queries = useQueryClient();
  const { data } = useQuery({ queryKey: ["connections"], queryFn: () => toBackground<Record<string, Connection>>({ type: "connections:list" }) });
  const sites = Object.entries(data ?? {}).sort(([, a], [, b]) => b.connectedAt - a.connectedAt);
  return (
    <Section title="Connected sites" icon={<Link2 size={16} />}>
      {sites.length === 0 ? (
        <p className="text-sm text-muted">No site is connected. A site asks to connect through the wallet; you choose which accounts it sees.</p>
      ) : (
        <ul className="-my-2 divide-y divide-line">
          {sites.map(([origin, connection]) => (
            <li key={origin} className="flex items-start justify-between gap-3 py-3">
              <div className="min-w-0">
                <div className="truncate font-mono text-sm font-medium">{origin}</div>
                <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                  {connection.accounts.map((address) => (
                    <AddressLink key={address} address={address} />
                  ))}
                </div>
                <div className="mt-1 text-xs text-faint">Since {formatDate(new Date(connection.connectedAt))}</div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                className="shrink-0 text-danger"
                onClick={async () => {
                  await toBackground({ type: "connections:disconnect", origin });
                  await queries.invalidateQueries({ queryKey: ["connections"] });
                }}
              >
                Disconnect
              </Button>
            </li>
          ))}
        </ul>
      )}
    </Section>
  );
}
