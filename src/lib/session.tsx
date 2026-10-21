/**
 * The wallet session. Accounts are stored encrypted; once the wallet is unlocked, the password
 * and the keys of the accounts used stay in memory only, until the wallet locks: on demand, or
 * after some minutes without activity.
 *
 * Every account of the wallet is encrypted under the same password, the wallet password.
 */

import { Keypair } from "@tesserax/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { decrypt, encrypt, KeystoreError, parseKeystore, validName, type KeystoreFile } from "./keystore";
import * as storage from "./storage";
import type { Settings, StoredAccount } from "./storage";

export interface Wallet {
  ready: boolean;
  accounts: StoredAccount[];
  settings: Settings;
  unlocked: boolean;
  active?: StoredAccount;
  /** Create the wallet with its first account. */
  create(password: string, name: string, secret: string, backedUp: boolean): Promise<void>;
  unlock(password: string): Promise<void>;
  lock(): void;
  /** Whether `password` is the wallet password. */
  checkPassword(password: string): Promise<boolean>;
  /** The key of an account, decrypted on first use. */
  keypair(name?: string): Promise<Keypair>;
  addAccount(name: string, secret: string, backedUp: boolean): Promise<StoredAccount>;
  /** Add the account of a keystore file of the command line wallet, encrypted under `filePassword`. */
  importKeystore(file: unknown, filePassword: string, name?: string): Promise<StoredAccount>;
  /** The recovery phrase (secret URI) of an account, after checking the password. */
  revealSecret(name: string, password: string): Promise<string>;
  renameAccount(name: string, next: string): Promise<void>;
  removeAccount(name: string): Promise<void>;
  markBackedUp(name: string): Promise<void>;
  setActive(name: string): Promise<void>;
  updateSettings(changes: Partial<Settings>): Promise<void>;
  changePassword(current: string, next: string): Promise<void>;
  /** Delete the wallet from this browser. */
  reset(): Promise<void>;
}

const WalletContext = createContext<Wallet | null>(null);

export function useWallet(): Wallet {
  const wallet = useContext(WalletContext);
  if (!wallet) throw new Error("useWallet outside of WalletProvider");
  return wallet;
}

const ACTIVITY_EVENTS = ["pointerdown", "keydown", "wheel", "touchstart"] as const;

export function WalletProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [accounts, setAccounts] = useState<StoredAccount[]>([]);
  const [settings, setSettings] = useState<Settings>(storage.defaultSettings());
  const [unlocked, setUnlocked] = useState(false);
  // Secrets live in refs, outside of React state and its developer tools.
  const password = useRef<string | null>(null);
  const keys = useRef(new Map<string, Keypair>());

  useEffect(() => {
    void Promise.all([storage.listAccounts(), storage.loadSettings()]).then(([accounts, settings]) => {
      setAccounts(accounts);
      setSettings(settings);
      setReady(true);
    });
  }, []);

  const lock = useCallback(() => {
    password.current = null;
    keys.current.clear();
    setUnlocked(false);
  }, []);

  // Lock after `autoLockMinutes` without activity.
  useEffect(() => {
    if (!unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, settings.autoLockMinutes * 60_000);
    };
    arm();
    for (const event of ACTIVITY_EVENTS) window.addEventListener(event, arm, { passive: true });
    return () => {
      clearTimeout(timer);
      for (const event of ACTIVITY_EVENTS) window.removeEventListener(event, arm);
    };
  }, [unlocked, settings.autoLockMinutes, lock]);

  const refresh = async () => setAccounts(await storage.listAccounts());

  const active = useMemo(
    () => accounts.find((a) => a.name === settings.activeAccount) ?? accounts[0],
    [accounts, settings.activeAccount],
  );

  const requirePassword = () => {
    if (password.current == null) throw new Error("the wallet is locked");
    return password.current;
  };

  const store = async (name: string, file: KeystoreFile, backedUp: boolean) => {
    if (!validName(name)) throw new Error("names use letters, digits, “-” and “_”, 64 at most");
    if (await storage.getAccount(name)) throw new Error(`an account named ${name} already exists`);
    if (accounts.some((a) => a.address === file.address)) throw new Error("this account is already in the wallet");
    const account: StoredAccount = { name, address: file.address, file: { ...file, name }, createdAt: Date.now(), backedUp };
    await storage.putAccount(account);
    await refresh();
    return account;
  };

  const updateSettings = async (changes: Partial<Settings>) => {
    const next = { ...settings, ...changes };
    await storage.saveSettings(next);
    setSettings(next);
  };

  const wallet: Wallet = {
    ready,
    accounts,
    settings,
    unlocked,
    active,

    async create(newPassword, name, secret, backedUp) {
      if (accounts.length > 0) throw new Error("the wallet already exists");
      const file = await encrypt(name, secret, newPassword);
      await store(name, file, backedUp);
      password.current = newPassword;
      await updateSettings({ activeAccount: name });
      setUnlocked(true);
    },

    async unlock(candidate) {
      const account = active ?? accounts[0];
      if (!account) throw new Error("the wallet has no account");
      const secret = await decrypt(account.file, candidate);
      password.current = candidate;
      keys.current.set(account.name, Keypair.fromUri(secret));
      setUnlocked(true);
    },

    lock,

    async checkPassword(candidate) {
      const account = active ?? accounts[0];
      if (!account) return false;
      try {
        await decrypt(account.file, candidate);
        return true;
      } catch (error) {
        if (error instanceof KeystoreError && error.kind === "wrong-password") return false;
        throw error;
      }
    },

    async keypair(name) {
      const account = name ? accounts.find((a) => a.name === name) : active;
      if (!account) throw new Error(`no account named ${name}`);
      const cached = keys.current.get(account.name);
      if (cached) return cached;
      const key = Keypair.fromUri(await decrypt(account.file, requirePassword()));
      keys.current.set(account.name, key);
      return key;
    },

    async addAccount(name, secret, backedUp) {
      const file = await encrypt(name, secret, requirePassword());
      return store(name, file, backedUp);
    },

    async importKeystore(value, filePassword, name) {
      const file = parseKeystore(value);
      const secret = await decrypt(file, filePassword);
      const reencrypted = await encrypt(name ?? file.name, secret, requirePassword());
      // A phrase the command line wallet showed is assumed written down.
      return store(name ?? file.name, reencrypted, true);
    },

    async revealSecret(name, candidate) {
      const account = accounts.find((a) => a.name === name);
      if (!account) throw new Error(`no account named ${name}`);
      return decrypt(account.file, candidate);
    },

    async renameAccount(name, next) {
      if (!validName(next)) throw new Error("names use letters, digits, “-” and “_”, 64 at most");
      if (accounts.some((a) => a.name === next)) throw new Error(`an account named ${next} already exists`);
      const renamed = accounts.map((a) => (a.name === name ? { ...a, name: next, file: { ...a.file, name: next } } : a));
      await storage.replaceAccounts(renamed);
      const key = keys.current.get(name);
      if (key) {
        keys.current.delete(name);
        keys.current.set(next, key);
      }
      if (settings.activeAccount === name) await updateSettings({ activeAccount: next });
      await refresh();
    },

    async removeAccount(name) {
      await storage.deleteAccount(name);
      keys.current.delete(name);
      const remaining = accounts.filter((a) => a.name !== name);
      if (settings.activeAccount === name) await updateSettings({ activeAccount: remaining[0]?.name });
      await refresh();
      if (remaining.length === 0) lock();
    },

    async markBackedUp(name) {
      const account = accounts.find((a) => a.name === name);
      if (account) await storage.putAccount({ ...account, backedUp: true });
      await refresh();
    },

    async setActive(name) {
      await updateSettings({ activeAccount: name });
    },

    updateSettings,

    async changePassword(current, next) {
      const reencrypted: StoredAccount[] = [];
      for (const account of accounts) {
        const secret = await decrypt(account.file, current);
        reencrypted.push({ ...account, file: await encrypt(account.name, secret, next) });
      }
      // All accounts or none: a failure leaves the previous password.
      await storage.replaceAccounts(reencrypted);
      password.current = next;
      await refresh();
    },

    async reset() {
      lock();
      await storage.wipe();
      setAccounts([]);
      setSettings(storage.defaultSettings());
    },
  };

  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}
