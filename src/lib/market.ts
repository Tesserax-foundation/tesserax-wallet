/** Rules of the market of the wallet, and the encryption of the secrets of purchases. */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { randomBytes } from "@noble/hashes/utils.js";

/** A payment stays locked 24 hours: the maker fills it, the taker claims, the maker collects. */
export const PAYMENT_LOCK_SECONDS = 24 * 3600;
/** A maker fills a payment with at least 12 hours left: 6 for the taker to claim the TESS, and six
 * more for the maker to collect the payment. */
export const MIN_REMAINING_SECONDS = 12 * 3600;
/** Seconds between two rounds of the claims and of the maker. */
export const ROUND_SECONDS = 15;
/** A lock not found this long after its purchase was never made. */
export const LOCK_SEARCH_SECONDS = 30 * 60;

const utf8 = new TextEncoder();
const secretKey = (seed: Uint8Array) => blake2b(new Uint8Array([...utf8.encode("tesserax-swap-secret"), ...seed]), { dkLen: 32 });

export function encryptSecret(seed: Uint8Array, secret: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = randomBytes(12);
  return { nonce, ciphertext: chacha20poly1305(secretKey(seed), nonce).encrypt(secret) };
}

export const decryptSecret = (seed: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) => chacha20poly1305(secretKey(seed), nonce).decrypt(ciphertext);
