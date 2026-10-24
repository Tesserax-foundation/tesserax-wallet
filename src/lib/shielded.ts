/** Private transactions: the shielded account of each account of the wallet (`docs/privacy.md` of
 * the chain).
 *
 * The shielded key of an account derives from the seed of its ML-DSA key, so its recovery phrase
 * restores its private balance. The notes and the note tree of the chain are kept in this
 * browser, encrypted with a key derived from that seed. Proofs are generated here, by the
 * WebAssembly build of the shielded wallet of the chain.
 *
 * Synchronization reads the transactions of the pool from the explorer database when the build
 * has one, in one request, then checks the tree it builds against the latest root on chain;
 * without it, or if the check fails, it reads the blocks from the node. */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { getDynamicBuilder, getLookupFn } from "@polkadot-api/metadata-builders";
import { decAnyMetadata, unifyMetadata } from "@polkadot-api/substrate-bindings";
import { parseAddress, TransactionFailed, type Keypair, type TesseraxClient, type TxOutcome } from "@tesserax/sdk";
import { filter, firstValueFrom } from "rxjs";
import init, { callData, isShieldedAddress, ShieldedWallet, transactExtrinsic } from "../../vendor/tesserax-shielded/tesserax_shielded_wasm.js";
import wasmUrl from "../../vendor/tesserax-shielded/tesserax_shielded_wasm_bg.wasm?url";
import { clientNetwork, type Network } from "./networks";
import { getShielded, putShielded } from "./storage";

export { isShieldedAddress };

let loaded: Promise<unknown> | undefined;

/** Load the WebAssembly module, once. */
export const loadShielded = () => (loaded ??= init({ module_or_path: wasmUrl }));

const utf8 = new TextEncoder();
const toHex = (bytes: Uint8Array) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const fromHex = (hex: string) => {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from({ length: clean.length / 2 }, (_, i) => parseInt(clean.slice(2 * i, 2 * i + 2), 16));
};
const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};

/** The 32 bytes of a digest decoded by polkadot-api: four 64-bit limbs, little-endian. */
function digestBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (typeof value === "string") return fromHex(value);
  const bytes = new Uint8Array(32);
  const view = new DataView(bytes.buffer);
  (value as Array<bigint | number>).forEach((limb, i) => view.setBigUint64(i * 8, BigInt(limb), true));
  return bytes;
}

const bytesOf = (value: unknown): Uint8Array =>
  value instanceof Uint8Array ? value : typeof value === "string" ? fromHex(value) : (value as { asBytes(): Uint8Array }).asBytes();

/** A `Shielded.Transacted` event, as the wallet ingests it. */
interface Transacted {
  position: bigint;
  nullifiers: Uint8Array;
  commitments: Uint8Array;
  notes: [Uint8Array, Uint8Array];
}

function ingest(wallet: ShieldedWallet, event: Transacted): bigint {
  return wallet.ingest(event.position, event.nullifiers, event.commitments, event.notes[0], event.notes[1]);
}

// Storage, encrypted with a key derived from the seed of the account.

const stateKey = (seed: Uint8Array) => blake2b(concat(utf8.encode("tesserax-shielded-state"), seed), { dkLen: 32 });

interface Loaded {
  wallet: ShieldedWallet;
  /** Last block read from the node. */
  block: number;
}

async function load(chain: string, keypair: Keypair): Promise<Loaded> {
  await loadShielded();
  const seed = keypair.seed();
  const stored = await getShielded(chain, keypair.address);
  if (stored) {
    try {
      const state = chacha20poly1305(stateKey(seed), stored.nonce).decrypt(stored.ciphertext);
      return { wallet: new ShieldedWallet(seed, state), block: stored.block };
    } catch {
      // A state that cannot be read is read again from the chain.
    }
  }
  return { wallet: new ShieldedWallet(seed), block: -1 };
}

async function save(chain: string, keypair: Keypair, { wallet, block }: Loaded): Promise<void> {
  const nonce = randomBytes(12);
  const ciphertext = chacha20poly1305(stateKey(keypair.seed()), nonce).encrypt(wallet.state());
  await putShielded(chain, keypair.address, { nonce, ciphertext, block });
}

// Explorer database.

type Indexer = NonNullable<Network["indexer"]>;

interface IndexedRow {
  position: string | number;
  block_number: string | number;
  nullifiers: string[];
  commitments: string[];
  notes: string[];
}

/** The transactions of the pool from `position` on, from the explorer database. */
async function indexed({ url, key }: Indexer, position: bigint): Promise<{ events: Transacted[]; lastBlock: number }> {
  const events: Transacted[] = [];
  let lastBlock = -1;
  for (let from = position; ; ) {
    const response = await fetch(
      `${url}/rest/v1/shielded_transactions?select=position,block_number,nullifiers,commitments,notes&position=gte.${from}&order=position.asc&limit=500`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, referrerPolicy: "no-referrer", credentials: "omit" },
    );
    if (!response.ok) throw new Error(`explorer database unavailable (${response.status})`);
    const rows = (await response.json()) as IndexedRow[];
    for (const row of rows) {
      events.push({
        position: BigInt(row.position),
        nullifiers: concat(...row.nullifiers.map(fromHex)),
        commitments: concat(...row.commitments.map(fromHex)),
        notes: [fromHex(row.notes[0]), fromHex(row.notes[1])],
      });
      lastBlock = Math.max(lastBlock, Number(row.block_number));
    }
    if (rows.length < 500) break;
    from = events[events.length - 1].position + 2n;
  }
  return { events, lastBlock };
}

// Node.

/** What the wallet needs of the metadata of the runtime: the indices of the shielded calls, and
 * the storage of the events and of the roots of the note tree. */
interface Runtime {
  pallet: number;
  shield: number;
  transact: number;
  eventsKey: string;
  decodeEvents: (hex: string) => Array<{ event: { type: string; value: { type: string; value: any } } }>;
  rootsKey: string;
  decodeRoots: (hex: string) => unknown[];
}

// By chain: the wallet can switch from a chain to another.
const runtimes = new Map<string, Promise<Runtime>>();

async function runtimeOf(client: TesseraxClient): Promise<Runtime> {
  const chain = await chainOf(client);
  let runtime = runtimes.get(chain);
  if (runtime) return runtime;
  runtime = (async () => {
    const metadata = unifyMetadata(decAnyMetadata(await request<string>(client, "state_getMetadata", [])));
    const lookup = getLookupFn(metadata);
    const pallet = metadata.pallets.find((p) => p.name === "Shielded");
    if (!pallet?.calls) throw new Error("the chain has no shielded pool");
    const calls = lookup(pallet.calls.type);
    if (calls.type !== "enum") throw new Error("unexpected metadata of the shielded pool");
    const builder = getDynamicBuilder(lookup);
    const events = builder.buildStorage("System", "Events");
    const roots = builder.buildStorage("Shielded", "Roots");
    return {
      pallet: pallet.index,
      shield: calls.value.shield.idx,
      transact: calls.value.transact.idx,
      eventsKey: events.keys.enc(),
      decodeEvents: (hex: string) => events.value.dec(hex),
      rootsKey: roots.keys.enc(),
      decodeRoots: (hex: string) => roots.value.dec(hex),
    };
  })().catch((error) => {
    runtimes.delete(chain);
    throw error;
  });
  runtimes.set(chain, runtime);
  return runtime;
}

const connected = new WeakMap<TesseraxClient, Promise<{ genesisHash: string }>>();

/** The connection of `client`, once established, and the genesis hash of its chain. */
function connection(client: TesseraxClient): Promise<{ genesisHash: string }> {
  let ready = connected.get(client);
  if (!ready) {
    ready = client.client.getChainSpecData();
    connected.set(client, ready);
  }
  return ready;
}

/** The chain of `client`: its genesis hash. */
const chainOf = async (client: TesseraxClient) => (await connection(client)).genesisHash.toLowerCase();

/** A request of the legacy RPC, once the client is connected: it answers for any block an archive
 * node keeps, unlike the queries of polkadot-api, limited to the blocks it follows. */
async function request<T>(client: TesseraxClient, method: string, params: unknown[]): Promise<T> {
  await connection(client);
  return client.client._request<T>(method, params);
}

/** The storage value of `key` at the block `hash`. */
const storageAt = (client: TesseraxClient, key: string, hash: string) => request<string | null>(client, "state_getStorage", [key, hash]);

/** The `Shielded.Transacted` events of the block `hash`. */
async function eventsAt(client: TesseraxClient, hash: string): Promise<Transacted[]> {
  const codecs = await runtimeOf(client);
  const value = await storageAt(client, codecs.eventsKey, hash);
  if (!value) return [];
  return codecs
    .decodeEvents(value)
    .filter((r) => r.event.type === "Shielded" && r.event.value.type === "Transacted")
    .map(({ event }) => {
      const v = event.value.value;
      return {
        position: BigInt(v.position),
        nullifiers: concat(...v.nullifiers.map(digestBytes)),
        commitments: concat(...v.commitments.map(digestBytes)),
        notes: [bytesOf(v.notes[0]), bytesOf(v.notes[1])],
      };
    });
}

/** The latest root of the note tree at the block `hash`, if the pool was ever used. */
async function latestRoot(client: TesseraxClient, hash: string): Promise<string | undefined> {
  const codecs = await runtimeOf(client);
  const value = await storageAt(client, codecs.rootsKey, hash);
  const roots = value ? codecs.decodeRoots(value) : [];
  return roots.length ? toHex(digestBytes(roots[roots.length - 1])) : undefined;
}

/** Hash and number of the best block. */
async function bestBlock(client: TesseraxClient): Promise<{ hash: string; number: number }> {
  const hash = await request<string>(client, "chain_getBlockHash", []);
  const header = await request<{ number: string }>(client, "chain_getHeader", [hash]);
  return { hash, number: Number(header.number) };
}

/** Read the blocks `from` to `to` of the best chain into `wallet`. */
async function scan(client: TesseraxClient, wallet: ShieldedWallet, from: number, to: number, onProgress?: (block: number) => void) {
  for (let number = Math.max(from, 0); number <= to; number++) {
    const hash = await request<string | null>(client, "chain_getBlockHash", [number]);
    if (!hash) break;
    for (const event of await eventsAt(client, hash)) {
      // Events already read from the explorer database are skipped.
      if (event.position < wallet.position()) continue;
      ingest(wallet, event);
    }
    if (number % 50 === 0) onProgress?.(number);
  }
}

/** The shielded account of a key, as last synchronized. */
export interface ShieldedView {
  address: string;
  balance: bigint;
  pending: bigint;
  block: number;
}

const view = ({ wallet, block }: Loaded): ShieldedView => ({ address: wallet.address(), balance: wallet.balance(), pending: wallet.pending(), block });

// One synchronization at a time per account.
const running = new Map<string, Promise<Loaded>>();

async function synchronize(client: TesseraxClient, chain: string, keypair: Keypair, onProgress?: (block: number) => void): Promise<Loaded> {
  const loaded = await load(chain, keypair);
  const best = await bestBlock(client);
  const target = await latestRoot(client, best.hash);
  const synced = () => (target === undefined ? loaded.wallet.position() === 0n : toHex(loaded.wallet.root()) === target);

  // The explorer database of the network, if the node is on its chain. What it gives is checked
  // against the root of the chain anyway.
  const network = clientNetwork(client);
  const indexer = network && (!network.genesisHash || network.genesisHash === chain) ? network.indexer : undefined;
  if (!synced() && indexer) {
    try {
      const { events, lastBlock } = await indexed(indexer, loaded.wallet.position());
      for (const event of events) ingest(loaded.wallet, event);
      loaded.block = Math.max(loaded.block, lastBlock);
    } catch {
      // The node is read instead.
    }
  }
  if (!synced()) {
    try {
      await scan(client, loaded.wallet, loaded.block + 1, best.number, onProgress);
    } catch {
      // Out of order, after a reorganization: read again from the genesis.
    }
    if (!synced()) {
      loaded.wallet = new ShieldedWallet(keypair.seed());
      await scan(client, loaded.wallet, 0, best.number, onProgress);
    }
  }
  loaded.block = best.number;
  await save(chain, keypair, loaded);
  return loaded;
}

async function synchronized(client: TesseraxClient, keypair: Keypair, onProgress?: (block: number) => void): Promise<{ chain: string; loaded: Loaded }> {
  const chain = await chainOf(client);
  const id = `${chain}/${keypair.address}`;
  let task = running.get(id);
  if (!task) {
    task = synchronize(client, chain, keypair, onProgress).finally(() => running.delete(id));
    running.set(id, task);
  }
  return { chain, loaded: await task };
}

/** Synchronize the shielded account of `keypair` with the chain. */
export async function syncShielded(client: TesseraxClient, keypair: Keypair, onProgress?: (block: number) => void): Promise<ShieldedView> {
  return view((await synchronized(client, keypair, onProgress)).loaded);
}

/** The shielded address of `keypair`. */
export async function shieldedAddress(keypair: Keypair): Promise<string> {
  await loadShielded();
  return new ShieldedWallet(keypair.seed()).address();
}

/** The smallest fee of a private transaction, paid from the private balance. */
export const minimumFee = async (client: TesseraxClient): Promise<bigint> => BigInt(await client.api.constants.Shielded.MinimumFee());

// Submission.

/** Submit a private transaction, without signer, and wait until a block includes it. */
async function submitUnsigned(client: TesseraxClient, extrinsic: Uint8Array): Promise<TxOutcome> {
  try {
    const included = await firstValueFrom(
      client.client.submitAndWatch(extrinsic).pipe(filter((e) => e.type === "inBestBlock" || e.type === "finalized")),
    );
    if (included.type !== "inBestBlock" && included.type !== "finalized") throw new Error("not included");
    if (!included.ok) throw new TransactionFailed("transaction failed", "Shielded::Failed");
    return { blockHash: included.block.hash, blockNumber: included.block.number, txHash: included.txHash, events: included.events as unknown as TxOutcome["events"] };
  } catch (error) {
    if (error instanceof TransactionFailed) throw error;
    throw new TransactionFailed(`transaction refused: ${(error as Error).message}`);
  }
}

/** Move `value` planck of the account of `keypair` into its shielded balance. */
export async function shield(client: TesseraxClient, keypair: Keypair, value: bigint): Promise<TxOutcome> {
  const { loaded } = await synchronized(client, keypair);
  const { pallet, shield } = await runtimeOf(client);
  const transaction = loaded.wallet.shield(keypair.accountId, value);
  const tx = await client.api.txFromCallData(callData(pallet, shield, transaction));
  return client.submit(tx, keypair);
}

async function submitPrivate(client: TesseraxClient, keypair: Keypair, build: (wallet: ShieldedWallet, fee: bigint) => Uint8Array): Promise<TxOutcome> {
  const { chain, loaded } = await synchronized(client, keypair);
  const [{ pallet, transact }, fee] = await Promise.all([runtimeOf(client), minimumFee(client)]);
  const transaction = build(loaded.wallet, fee);
  const outcome = await submitUnsigned(client, transactExtrinsic(pallet, transact, transaction));
  loaded.wallet.markPending(transaction);
  await save(chain, keypair, loaded);
  return outcome;
}

/** Send `value` planck privately to the shielded address `to`. */
export const sendPrivately = (client: TesseraxClient, keypair: Keypair, to: string, value: bigint) =>
  submitPrivate(client, keypair, (wallet, fee) => wallet.send(to.trim(), value, fee));

/** Move `value` planck of the shielded balance to the transparent address `to`. */
export const unshield = (client: TesseraxClient, keypair: Keypair, to: string, value: bigint) =>
  submitPrivate(client, keypair, (wallet, fee) => wallet.unshield(parseAddress(to), value, fee));
