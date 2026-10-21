/**
 * The background of the extension: it receives the requests of web pages from the content
 * script, opens the approval window, keeps the connected sites, and locks the wallet after the
 * inactivity set in its settings.
 */

import * as storage from "../lib/storage";
import { extensionApi as api, SESSION_KEY, type UnlockedSession } from "../lib/platform";
import { Core } from "./core";
import { allowedOrigin, ERRORS, ProviderError, type Connection, type ExtensionMessage } from "./protocol";

const CONNECTIONS = "connections";
const AUTO_LOCK = "auto-lock";

const core = new Core({
  loadConnections: async () => ((await api.storage.local.get(CONNECTIONS))[CONNECTIONS] as Record<string, Connection> | undefined) ?? {},
  saveConnections: (connections) => api.storage.local.set({ [CONNECTIONS]: connections }),
  walletAccounts: async () => (await storage.listAccounts()).map((a) => ({ address: a.address, name: a.name })),
  openApproval: async (id) => {
    const window = await api.windows.create({ url: api.runtime.getURL(`index.html#/approve/${id}`), type: "popup", width: 400, height: 680, focused: true });
    return window?.id;
  },
  focusWindow: (windowId) => void api.windows.update(windowId, { focused: true }).catch(() => {}),
  closeWindow: (windowId) => void api.windows.remove(windowId).catch(() => {}),
  sendToTab: (tabId, event) => void api.tabs.sendMessage(tabId, event).catch(() => {}),
  newId: () => crypto.randomUUID(),
  now: () => Date.now(),
});

interface Sender {
  id?: string;
  url?: string;
  origin?: string;
  frameId?: number;
  tab?: { id?: number };
}

/** A page of the extension itself, as opposed to a content script in a web page. */
const fromExtension = (sender: Sender) => sender.id === api.runtime.id && Boolean(sender.url?.startsWith(api.runtime.getURL("")));

async function handle(message: ExtensionMessage, sender: Sender): Promise<unknown> {
  if (message?.type === "provider:request") {
    // Only the content script of a top-level page speaks for a site: its origin comes from the
    // browser, never from the page.
    if (sender.id !== api.runtime.id || fromExtension(sender) || sender.tab?.id === undefined || sender.frameId !== 0) {
      throw new ProviderError(ERRORS.unauthorized, "Requests come from top-level pages only");
    }
    const origin = allowedOrigin(sender.url);
    if (!origin) throw new ProviderError(ERRORS.unauthorized, "Only HTTPS sites can use the wallet");
    return core.request(origin, sender.tab.id, message.method, message.params);
  }
  if (!fromExtension(sender)) throw new ProviderError(ERRORS.unauthorized, "Unknown sender");
  switch (message?.type) {
    case "approval:get":
      return core.approval(message.id);
    case "approval:resolve":
      return core.resolve(message.id, message.result);
    case "approval:reject":
      return core.reject(message.id, message.error);
    case "approval:ping":
      return null;
    case "connections:list":
      return core.connections();
    case "connections:disconnect":
      return core.disconnect(message.origin);
    case "connections:clear":
      return core.disconnectAll();
    default:
      throw new ProviderError(ERRORS.unsupported, "Unknown message");
  }
}

api.runtime.onMessage.addListener((message: ExtensionMessage, sender: Sender, sendResponse: (response: unknown) => void) => {
  handle(message, sender).then(
    (result) => sendResponse({ result: result ?? null }),
    (error: unknown) =>
      sendResponse({ error: error instanceof ProviderError ? error.toJSON() : { code: ERRORS.internal, message: error instanceof Error ? error.message : String(error) } }),
  );
  // The answer comes later, once the user decided.
  return true;
});

api.windows.onRemoved.addListener((windowId: number) => core.windowClosed(windowId));
api.tabs.onRemoved.addListener((tabId: number) => core.tabClosed(tabId));

// The wallet is set up in a tab: the popup would close at the first click elsewhere.
api.runtime.onInstalled.addListener((details: { reason: string }) => {
  if (details.reason === "install") void api.tabs.create({ url: api.runtime.getURL("index.html#/welcome") });
});

// Lock after the inactivity of the settings, even with every page of the extension closed.
api.alarms.create(AUTO_LOCK, { periodInMinutes: 1 });
api.alarms.onAlarm.addListener(async (alarm: { name: string }) => {
  if (alarm.name !== AUTO_LOCK) return;
  const unlocked = (await api.storage.session.get(SESSION_KEY))[SESSION_KEY] as UnlockedSession | undefined;
  if (!unlocked) return;
  const { autoLockMinutes } = await storage.loadSettings();
  if (Date.now() - unlocked.lastActive > autoLockMinutes * 60_000) await api.storage.session.remove(SESSION_KEY);
});
