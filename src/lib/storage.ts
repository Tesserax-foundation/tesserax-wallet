/** Persistent storage of the wallet in IndexedDB: encrypted accounts and settings. Nothing in
 * it is secret without the password. */

import type { KeystoreFile } from "./keystore";

export interface StoredAccount {
  name: string;
  address: string;
  file: KeystoreFile;
  createdAt: number;
  /** Whether the user confirmed the backup of the recovery phrase. */
  backedUp: boolean;
}

export interface Settings {
  nodeUrl: string;
  explorerUrl: string;
  /** Minutes without activity before the wallet locks. */
  autoLockMinutes: number;
  /** Ask for the password before every transaction. */
  confirmWithPassword: boolean;
  activeAccount?: string;
}

export const defaultSettings = (): Settings => ({
  nodeUrl: (import.meta.env.VITE_NODE_URL as string | undefined) ?? "ws://127.0.0.1:9944",
  explorerUrl: (import.meta.env.VITE_EXPLORER_URL as string | undefined) ?? "",
  autoLockMinutes: 15,
  confirmWithPassword: false,
});

const DATABASE = "tesserax-wallet";
const ACCOUNTS = "accounts";
const SETTINGS = "settings";

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(ACCOUNTS, { keyPath: "name" });
      request.result.createObjectStore(SETTINGS);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("cannot open the wallet storage"));
  });
  return database;
}

async function run<T>(store: string, mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(store, mode);
    const request = action(transaction.objectStore(store));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onerror = () => reject(transaction.error ?? request.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("storage transaction aborted"));
  });
}

export const listAccounts = async () =>
  (await run<StoredAccount[]>(ACCOUNTS, "readonly", (s) => s.getAll())).sort((a, b) => a.createdAt - b.createdAt);

export const getAccount = (name: string) => run<StoredAccount | undefined>(ACCOUNTS, "readonly", (s) => s.get(name));

export const putAccount = (account: StoredAccount) => run(ACCOUNTS, "readwrite", (s) => s.put(account));

export const deleteAccount = (name: string) => run(ACCOUNTS, "readwrite", (s) => s.delete(name));

/** Replace every account at once (password change, rename): all or nothing. */
export async function replaceAccounts(accounts: StoredAccount[]): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(ACCOUNTS, "readwrite");
    const store = transaction.objectStore(ACCOUNTS);
    store.clear();
    for (const account of accounts) store.put(account);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error ?? new Error("storage transaction aborted"));
  });
}

export async function loadSettings(): Promise<Settings> {
  const saved = await run<Partial<Settings> | undefined>(SETTINGS, "readonly", (s) => s.get("settings"));
  return { ...defaultSettings(), ...saved };
}

export const saveSettings = (settings: Settings) => run(SETTINGS, "readwrite", (s) => s.put(settings, "settings"));

/** Delete the whole wallet from this browser. */
export async function wipe(): Promise<void> {
  const db = await open();
  db.close();
  database = undefined;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(DATABASE);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error);
    request.onblocked = () => resolve();
  });
}
