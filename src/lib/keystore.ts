/**
 * Encrypted accounts, in the keystore format of the Tesserax command line wallet: a file made by
 * `tesserax-wallet account` opens here, and an account exported from here opens in the command
 * line wallet.
 *
 * The secret URI of an account (its 24-word phrase) is encrypted with ChaCha20-Poly1305 under a
 * 256-bit key derived from the password with Argon2id (64 MiB, 3 passes). The address is the
 * associated data of the encryption, and is checked against the decrypted key: a file cannot be
 * edited to show another address. 256-bit symmetric encryption stays secure against quantum
 * computers.
 */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { argon2id } from "@noble/hashes/argon2.js";
import { Keypair } from "@tesserax/sdk";

export const MEMORY_KIB = 64 * 1024;
export const ITERATIONS = 3;
export const PARALLELISM = 1;

/** Limits on the parameters of an imported file, which could otherwise exhaust the browser. */
const MAX_MEMORY_KIB = 512 * 1024;
const MAX_ITERATIONS = 16;

export interface KeystoreFile {
  version: 1;
  name: string;
  address: string;
  kdf: { algorithm: "argon2id"; memory_kib: number; iterations: number; parallelism: number; salt: string };
  cipher: { algorithm: "chacha20poly1305"; nonce: string; ciphertext: string };
}

export class KeystoreError extends Error {
  override name = "KeystoreError";
  constructor(
    readonly kind: "wrong-password" | "corrupted" | "invalid",
    message: string,
  ) {
    super(message);
  }
}

const utf8 = new TextEncoder();

export const toBase64 = (bytes: Uint8Array) => {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
};

export const fromBase64 = (text: string): Uint8Array => {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
};

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** Argon2id in a worker when the environment has workers (browsers), inline otherwise (tests). */
export async function deriveKey(password: string, salt: Uint8Array, memoryKib = MEMORY_KIB, iterations = ITERATIONS, parallelism = PARALLELISM): Promise<Uint8Array> {
  if (typeof Worker === "undefined") {
    return argon2id(password, salt, { m: memoryKib, t: iterations, p: parallelism, dkLen: 32 });
  }
  const worker = new Worker(new URL("./kdf.worker.ts", import.meta.url), { type: "module" });
  try {
    return await new Promise<Uint8Array>((resolve, reject) => {
      worker.onmessage = (event: MessageEvent<{ key?: Uint8Array; error?: string }>) =>
        event.data.key ? resolve(event.data.key) : reject(new Error(event.data.error ?? "key derivation failed"));
      worker.onerror = (event) => reject(new Error(event.message || "key derivation failed"));
      worker.postMessage({ password, salt, memoryKib, iterations, parallelism });
    });
  } finally {
    worker.terminate();
  }
}

/** Encrypt the secret URI `secret` under `password`, as the account `name`. */
export async function encrypt(name: string, secret: string, password: string): Promise<KeystoreFile> {
  const trimmed = secret.trim();
  let address: string;
  try {
    address = Keypair.fromUri(trimmed).address;
  } catch (error) {
    throw new KeystoreError("invalid", (error as Error).message);
  }
  const salt = random(16);
  const nonce = random(12);
  const key = await deriveKey(password, salt);
  const ciphertext = chacha20poly1305(key, nonce, utf8.encode(address)).encrypt(utf8.encode(trimmed));
  key.fill(0);
  return {
    version: 1,
    name,
    address,
    kdf: { algorithm: "argon2id", memory_kib: MEMORY_KIB, iterations: ITERATIONS, parallelism: PARALLELISM, salt: toBase64(salt) },
    cipher: { algorithm: "chacha20poly1305", nonce: toBase64(nonce), ciphertext: toBase64(ciphertext) },
  };
}

/** Check that `value` is a keystore file this wallet can open. */
export function parseKeystore(value: unknown): KeystoreFile {
  const file = value as KeystoreFile;
  const ok =
    file &&
    file.version === 1 &&
    typeof file.name === "string" &&
    typeof file.address === "string" &&
    file.kdf?.algorithm === "argon2id" &&
    file.cipher?.algorithm === "chacha20poly1305" &&
    Number.isInteger(file.kdf.memory_kib) &&
    file.kdf.memory_kib >= 8 &&
    file.kdf.memory_kib <= MAX_MEMORY_KIB &&
    Number.isInteger(file.kdf.iterations) &&
    file.kdf.iterations >= 1 &&
    file.kdf.iterations <= MAX_ITERATIONS &&
    Number.isInteger(file.kdf.parallelism) &&
    file.kdf.parallelism >= 1 &&
    file.kdf.parallelism <= 16;
  if (!ok) throw new KeystoreError("invalid", "not a Tesserax keystore file");
  return file;
}

/** The secret URI of `file`. */
export async function decrypt(file: KeystoreFile, password: string): Promise<string> {
  parseKeystore(file);
  let salt: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array;
  try {
    salt = fromBase64(file.kdf.salt);
    nonce = fromBase64(file.cipher.nonce);
    ciphertext = fromBase64(file.cipher.ciphertext);
  } catch {
    throw new KeystoreError("corrupted", "the keystore file is corrupted");
  }
  if (nonce.length !== 12) throw new KeystoreError("corrupted", "the keystore file is corrupted");
  const key = await deriveKey(password, salt, file.kdf.memory_kib, file.kdf.iterations, file.kdf.parallelism);
  let plain: Uint8Array;
  try {
    plain = chacha20poly1305(key, nonce, utf8.encode(file.address)).decrypt(ciphertext);
  } catch {
    throw new KeystoreError("wrong-password", "wrong password");
  } finally {
    key.fill(0);
  }
  const secret = new TextDecoder().decode(plain);
  plain.fill(0);
  let address: string;
  try {
    address = Keypair.fromUri(secret).address;
  } catch {
    throw new KeystoreError("corrupted", "the keystore file is corrupted");
  }
  if (address !== file.address) throw new KeystoreError("corrupted", "the keystore file is corrupted");
  return secret;
}

/** Account names, as in the command line wallet: letters, digits, "-" and "_". */
export const validName = (name: string) => /^[A-Za-z0-9_-]{1,64}$/.test(name);
