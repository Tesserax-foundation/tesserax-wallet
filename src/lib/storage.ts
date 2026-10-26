/** Persistent storage of the wallet in IndexedDB: encrypted accounts and settings. Nothing in
 * it is secret without the password: the secrets of swaps are encrypted with a key of their
 * account. */

import type { SwapAsset, SwapChain } from "@tesserax/sdk";
import type { KeystoreFile } from "./keystore";
import { defaultNetworkId, networkOf, networks, type Network, type NetworkId } from "./networks";

export interface StoredAccount {
  name: string;
  address: string;
  file: KeystoreFile;
  createdAt: number;
  /** Whether the user confirmed the backup of the recovery phrase. */
  backedUp: boolean;
}

export interface Settings {
  network: NetworkId;
  /** Node and explorer chosen for a network, instead of its own. */
  nodes: Partial<Record<NetworkId, string>>;
  explorers: Partial<Record<NetworkId, string>>;
  /** Minutes without activity before the wallet locks. */
  autoLockMinutes: number;
  /** Ask for the password before every transaction. */
  confirmWithPassword: boolean;
  activeAccount?: string;
}

export const defaultSettings = (): Settings => ({
  network: defaultNetworkId,
  nodes: {},
  explorers: {},
  autoLockMinutes: 15,
  confirmWithPassword: false,
});

/** The network of `settings`, with the node and the explorer chosen for it. */
export function activeNetwork(settings: Settings): Network {
  const network = networkOf(settings.network);
  return { ...network, nodeUrl: settings.nodes[network.id] ?? network.nodeUrl, explorerUrl: settings.explorers[network.id] ?? network.explorerUrl };
}

const DATABASE = "tesserax-wallet";
const ACCOUNTS = "accounts";
const SETTINGS = "settings";
/** Shielded accounts: their notes and the note tree, encrypted with a key of the account. */
const SHIELDED = "shielded";
/** Contracts the user follows, by network. */
const CONTRACTS = "contracts";

export interface StoredContract {
  /** `<network>/<address>`. */
  id: string;
  network: NetworkId;
  /** `0x` and 40 digits, checksummed. */
  address: string;
  name: string;
  /** Its ABI, as `solc` or `resolc` write it. */
  abi: unknown[];
  addedAt: number;
}

/** Purchases of TESS on the market, by chain: `<genesis>/<hash>`. */
const PURCHASES = "purchases";
/** What a maker has read and has to collect, by chain and account: `<genesis>/<address>`. */
const MAKERS = "makers";

export type PurchaseStatus = "locking" | "locked" | "claiming" | "claimed" | "refundable" | "refunded" | "failed";

export interface StoredPurchase {
  /** `<genesis>/<hash>`. */
  id: string;
  genesis: string;
  /** Account receiving the TESS: its name, and its address. */
  account: string;
  taker: string;
  offer: number;
  chain: SwapChain;
  asset: SwapAsset;
  /** TESS bought, in planck, and the payment, in the smallest unit of the asset. */
  amount: string;
  payment: string;
  /** EVM address paid, and the one paying. */
  recipient: string;
  sender: string;
  /** SHA-256 hash of the secret, hexadecimal; the secret, encrypted with a key of the account. */
  hash: string;
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** First EVM block the lock can be in, to find it again if the wallet closed before its
   * receipt. */
  fromBlock: string;
  /** The lock, once known, and the unix time of the EVM chain from which it can be taken back;
   * `deadline` is that time on the clock of this computer. */
  lock?: string;
  timelock: number;
  deadline: number;
  trade?: number;
  /** A payment in BTC: the keys of its script, the wallet and address paying, and its output. */
  bitcoin?: { maker: string; refund: string; wallet: string; payer: string; txid: string; vout: number };
  status: PurchaseStatus;
  /** Why it failed, or what the user must know. */
  note?: string;
  createdAt: number;
}

export interface StoredMaker {
  /** Last EVM block read on each chain, as a decimal string. */
  evmBlocks: Partial<Record<SwapChain, string>>;
  /** Last Tesserax block read. */
  tesseraxBlock: number;
  /** Trades filled and not claimed yet: the chain and the lock of their payment. */
  trades: Record<string, { chain: SwapChain; lock: string; timelock: number }>;
  /** Payments to collect: their secret, revealed by the claim, and when their lock expires on the
   * clock of this computer, once read. */
  collect: Record<string, { chain: SwapChain; lock: string; timelock: number; secret: string; deadline?: number }>;
}

export interface StoredShielded {
  nonce: Uint8Array;
  ciphertext: Uint8Array;
  /** Last block read from the node. */
  block: number;
}

let database: Promise<IDBDatabase> | undefined;

function open(): Promise<IDBDatabase> {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 4);
    request.onupgradeneeded = (event) => {
      if (event.oldVersion < 1) {
        request.result.createObjectStore(ACCOUNTS, { keyPath: "name" });
        request.result.createObjectStore(SETTINGS);
      }
      if (event.oldVersion < 2) request.result.createObjectStore(SHIELDED);
      if (event.oldVersion < 3) request.result.createObjectStore(CONTRACTS, { keyPath: "id" }).createIndex("network", "network");
      if (event.oldVersion < 4) {
        request.result.createObjectStore(PURCHASES, { keyPath: "id" }).createIndex("genesis", "genesis");
        request.result.createObjectStore(MAKERS);
      }
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

/** Shielded accounts are stored by chain, `genesisHash`, and address: the same key has other notes
 * on another chain. */
export const getShielded = (genesisHash: string, address: string) =>
  run<StoredShielded | undefined>(SHIELDED, "readonly", (s) => s.get(`${genesisHash}/${address}`));

export const putShielded = (genesisHash: string, address: string, state: StoredShielded) =>
  run(SHIELDED, "readwrite", (s) => s.put(state, `${genesisHash}/${address}`));

/** Settings saved before the choice of the network: one node and one explorer. */
interface SavedBefore {
  nodeUrl?: string;
  explorerUrl?: string;
}

export const listContracts = async (network: NetworkId) =>
  (await run<StoredContract[]>(CONTRACTS, "readonly", (s) => s.index("network").getAll(network))).sort((a, b) => a.addedAt - b.addedAt);

export const getContract = (network: NetworkId, address: string) =>
  run<StoredContract | undefined>(CONTRACTS, "readonly", (s) => s.get(`${network}/${address}`));

export const putContract = (contract: Omit<StoredContract, "id">) =>
  run(CONTRACTS, "readwrite", (s) => s.put({ ...contract, id: `${contract.network}/${contract.address}` }));

export const deleteContract = (network: NetworkId, address: string) => run(CONTRACTS, "readwrite", (s) => s.delete(`${network}/${address}`));

export const listPurchases = async (genesis: string) =>
  (await run<StoredPurchase[]>(PURCHASES, "readonly", (s) => s.index("genesis").getAll(genesis))).sort((a, b) => b.createdAt - a.createdAt);

export const putPurchase = (purchase: StoredPurchase) => run(PURCHASES, "readwrite", (s) => s.put(purchase));

export const getMaker = (genesis: string, address: string) => run<StoredMaker | undefined>(MAKERS, "readonly", (s) => s.get(`${genesis}/${address}`));

export const putMaker = (genesis: string, address: string, maker: StoredMaker) => run(MAKERS, "readwrite", (s) => s.put(maker, `${genesis}/${address}`));

export async function loadSettings(): Promise<Settings> {
  const saved = await run<(Partial<Settings> & SavedBefore) | undefined>(SETTINGS, "readonly", (s) => s.get("settings"));
  const { nodeUrl, explorerUrl, ...rest } = saved ?? {};
  const settings: Settings = { ...defaultSettings(), ...rest };
  settings.network = networkOf(settings.network).id;
  if (!rest.network) {
    // They were those of the network of the build.
    const network = networks[defaultNetworkId];
    if (nodeUrl && nodeUrl !== network.nodeUrl) settings.nodes = { [network.id]: nodeUrl };
    if (explorerUrl !== undefined && explorerUrl !== network.explorerUrl) settings.explorers = { [network.id]: explorerUrl };
  }
  return settings;
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
