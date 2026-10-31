/** Rules of the market of the wallet, and the encryption of the secrets of purchases and sales. */

import { chacha20poly1305 } from "@noble/ciphers/chacha.js";
import { blake2b } from "@noble/hashes/blake2.js";
import { randomBytes } from "@noble/hashes/utils.js";
import { paymentDecimals, paymentSymbol, type Payment } from "@tesserax/sdk";
import { decimal, hex } from "./evm";

/** A payment stays locked 24 hours: the maker fills it, the taker claims, the maker collects. */
export const PAYMENT_LOCK_SECONDS = 24 * 3600;
/** A maker fills a payment with at least 12 hours left: 6 for the taker to claim the TESS, and six
 * more for the maker to collect the payment. */
export const MIN_REMAINING_SECONDS = 12 * 3600;
/** Seconds between two rounds of the claims and of the maker. */
export const ROUND_SECONDS = 15;
/** A lock not found this long after its purchase was never made. */
export const LOCK_SEARCH_SECONDS = 30 * 60;

/** The payment of a sale is claimed with at least an hour left before its buyer can take it
 * back: the claim reveals the secret, which must not come too late. */
export const SALE_CLAIM_SECONDS = 3600;

/** A payment locked for a sale, as read on its chain. */
export interface SalePayment {
  /** "Locked" while it can be claimed; "Claimed", "Refunded" or "Spent" otherwise. */
  state: string;
  hash: Uint8Array;
  /** The EVM address or the Bitcoin key it pays. */
  recipient: Uint8Array;
  /** What it pays in the asset of the sale; undefined in another asset. */
  amount: bigint | undefined;
  /** Unix time from which its buyer can take it back, on its chain. */
  timelock: number;
}

/** Why the payment `paid` of a sale must not be claimed, if so. Its claim reveals the secret,
 * which hands the TESS to the buyer: only a payment that fits is claimed. `now` is the time of the
 * chain of the payment. */
export function salePaymentProblem(paid: SalePayment, sale: { hash: Uint8Array; payout: Uint8Array; due: bigint; payment: Payment }, now: number): string | undefined {
  const symbol = paymentSymbol(sale.payment);
  if (paid.state !== "Locked") return `the payment is already ${paid.state.toLowerCase()}`;
  if (hex(paid.hash) !== hex(sale.hash)) return "the payment is locked under another hash";
  if (hex(paid.recipient).toLowerCase() !== hex(sale.payout).toLowerCase()) return sale.payment.chain === "Bitcoin" ? "the payment is locked for another key" : "the payment goes to another address";
  if (paid.amount === undefined) return `the payment is not in ${symbol}`;
  if (paid.amount < sale.due) {
    const decimals = paymentDecimals(sale.payment);
    return `the payment holds ${decimal(paid.amount, decimals)} ${symbol} instead of ${decimal(sale.due, decimals)}`;
  }
  if (paid.timelock < now + SALE_CLAIM_SECONDS) return "the payment expires in less than an hour";
  return undefined;
}

const utf8 = new TextEncoder();
const secretKey = (seed: Uint8Array) => blake2b(new Uint8Array([...utf8.encode("tesserax-swap-secret"), ...seed]), { dkLen: 32 });

export function encryptSecret(seed: Uint8Array, secret: Uint8Array): { nonce: Uint8Array; ciphertext: Uint8Array } {
  const nonce = randomBytes(12);
  return { nonce, ciphertext: chacha20poly1305(secretKey(seed), nonce).encrypt(secret) };
}

export const decryptSecret = (seed: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array) => chacha20poly1305(secretKey(seed), nonce).decrypt(ciphertext);
