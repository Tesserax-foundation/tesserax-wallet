/**
 * What differs between the web wallet and the browser extension.
 *
 * In the extension, the popup closes whenever it loses focus: the unlocked session lives in the
 * session storage of the extension, which the browser keeps in memory only, never on disk, and
 * clears when it quits. Only the pages of the extension and its background read it; web pages and
 * content scripts cannot.
 */

/** The WebExtensions API: `browser` in Firefox, `chrome` in Chromium browsers. */
export const extensionApi: any = (globalThis as any).browser ?? (globalThis as any).chrome;

export const isExtension = import.meta.env.VITE_TARGET === "extension";

/** The page is the popup of the toolbar button, 360 by 600 pixels. */
export const isPopup = isExtension && typeof location !== "undefined" && new URLSearchParams(location.search).has("popup");

/** The unlocked wallet: its password, and the secrets of the accounts decrypted since. */
export interface UnlockedSession {
  password: string;
  secrets: Record<string, string>;
  /** Last activity in a page of the extension, for the automatic lock. */
  lastActive: number;
}

export const SESSION_KEY = "session";

export const session = {
  async load(): Promise<UnlockedSession | null> {
    if (!isExtension) return null;
    const stored = await extensionApi.storage.session.get(SESSION_KEY);
    return (stored?.[SESSION_KEY] as UnlockedSession | undefined) ?? null;
  },
  async save(value: UnlockedSession): Promise<void> {
    if (isExtension) await extensionApi.storage.session.set({ [SESSION_KEY]: value });
  },
  async clear(): Promise<void> {
    if (isExtension) await extensionApi.storage.session.remove(SESSION_KEY);
  },
  /** Call `listener` when another page or the background locks the wallet. */
  onCleared(listener: () => void): () => void {
    if (!isExtension) return () => {};
    const onChanged = (changes: Record<string, { newValue?: unknown }>, area: string) => {
      if (area === "session" && SESSION_KEY in changes && !changes[SESSION_KEY].newValue) listener();
    };
    extensionApi.storage.onChanged.addListener(onChanged);
    return () => extensionApi.storage.onChanged.removeListener(onChanged);
  },
};

/** Open `path` of the wallet in a tab of its own; the popup closes. */
export function openInTab(path = "/") {
  void extensionApi.tabs.create({ url: extensionApi.runtime.getURL(`index.html#${path}`) });
  if (isPopup) window.close();
}

/** A message to the background of the extension; it answers `{ result }` or `{ error }`. */
export async function toBackground<T = unknown>(message: Record<string, unknown>): Promise<T> {
  const response = (await extensionApi.runtime.sendMessage(message)) as { result?: T; error?: { message: string } } | undefined;
  if (!response) throw new Error("the wallet background does not answer");
  if (response.error) throw new Error(response.error.message);
  return response.result as T;
}
