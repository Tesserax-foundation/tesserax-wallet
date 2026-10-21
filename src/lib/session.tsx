/**
 * The wallet session. Accounts are stored encrypted; once the wallet is unlocked, the password
 * and the keys of the accounts used stay in memory only, until the wallet locks: on demand, or
 * after some minutes without activity. In the browser extension, whose popup closes with each
 * click elsewhere, they stay in its session storage instead, in memory too (see `platform.ts`).
 *
 * Every account of the wallet is encrypted under the same password, the wallet password.
 */

import { Keypair } from "@tesserax/sdk";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { decrypt, encrypt, KeystoreError, parseKeystore, validName, type KeystoreFile } from "./keystore";
import { isExtension, session, toBackground } from "./platform";
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
  // In the extension, the secrets decrypted, kept in its session storage across its pages.
  const secrets = useRef(new Map<string, string>());
  const touched = useRef(0);

  useEffect(() => {
    void (async () => {
      const [accounts, settings, unlockedSession] = await Promise.all([storage.listAccounts(), storage.loadSettings(), session.load()]);
      if (unlockedSession && accounts.length > 0) {
        password.current = unlockedSession.password;
        for (const [name, secret] of Object.entries(unlockedSession.secrets)) {
          secrets.current.set(name, secret);
          keys.current.set(name, Keypair.fromUri(secret));
        }
        setUnlocked(true);
      }
      setAccounts(accounts);
      setSettings(settings);
      setReady(true);
    })();
  }, []);

  const forget = useCallback(() => {
    password.current = null;
    keys.current.clear();
    secrets.current.clear();
    setUnlocked(false);
  }, []);

  const lock = useCallback(() => {
    forget();
    void session.clear();
  }, [forget]);

  // Another page of the extension, or its background after inactivity, locked the wallet.
  useEffect(() => session.onCleared(forget), [forget]);

  /** Keep the unlocked wallet for the other pages of the extension. */
  const persist = () => {
    if (!isExtension || password.current == null) return;
    touched.current = Date.now();
    void session.save({ password: password.current, secrets: Object.fromEntries(secrets.current), lastActive: touched.current });
  };

  const remember = (name: string, secret: string) => {
    const key = Keypair.fromUri(secret);
    keys.current.set(name, key);
    if (isExtension) {
      secrets.current.set(name, secret);
      persist();
    }
    return key;
  };

  // Lock after `autoLockMinutes` without activity.
  useEffect(() => {
    if (!unlocked) return;
    let timer: ReturnType<typeof setTimeout>;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(lock, settings.autoLockMinutes * 60_000);
      // The background locks the extension from the last activity it knows of.
      if (isExtension && Date.now() - touched.current > 15_000) persist();
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
      remember(name, secret);
      await updateSettings({ activeAccount: name });
      setUnlocked(true);
    },

    async unlock(candidate) {
      const account = active ?? accounts[0];
      if (!account) throw new Error("the wallet has no account");
      const secret = await decrypt(account.file, candidate);
      password.current = candidate;
      remember(account.name, secret);
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
      return remember(account.name, await decrypt(account.file, requirePassword()));
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
      const secret = secrets.current.get(name);
      if (secret) {
        secrets.current.delete(name);
        secrets.current.set(next, secret);
        persist();
      }
      if (settings.activeAccount === name) await updateSettings({ activeAccount: next });
      await refresh();
    },

    async removeAccount(name) {
      await storage.deleteAccount(name);
      keys.current.delete(name);
      if (secrets.current.delete(name)) persist();
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
      persist();
      await refresh();
    },

    async reset() {
      lock();
      await storage.wipe();
      if (isExtension) await toBackground({ type: "connections:clear" });
      setAccounts([]);
      setSettings(storage.defaultSettings());
    },
  };

  return <WalletContext.Provider value={wallet}>{children}</WalletContext.Provider>;
}
