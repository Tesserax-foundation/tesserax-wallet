import assert from "node:assert/strict";
import { test } from "node:test";
import { decimal, evmNetworksOf, hex, unhex, units } from "../src/lib/evm";
import { networks } from "../src/lib/networks";
import { decryptSecret, encryptSecret, salePaymentProblem, SALE_CLAIM_SECONDS } from "../src/lib/market";

test("prices are read and written in the smallest unit of their asset", () => {
  assert.equal(units("0.05", 6).value, 50_000n);
  assert.equal(units("1,000.5", 6).value, 1_000_500_000n);
  assert.equal(units(".1", 18).value, 10n ** 17n);
  assert.equal(units("0.0000001", 6).error, "At most 6 decimals");
  assert.equal(units("abc", 6).error, "Not a number");
  assert.equal(units("", 6).error, "Enter a number");
  assert.equal(decimal(50_000n, 6), "0.05");
  assert.equal(decimal(3n * 10n ** 15n, 18), "0.003");
  assert.equal(decimal(1_234_000_000n, 6), "1,234");
});

test("hexadecimal round trips", () => {
  const bytes = Uint8Array.from([0, 1, 254, 255]);
  assert.equal(hex(bytes), "0x0001feff");
  assert.deepEqual(unhex("0x0001FEFF"), bytes);
  assert.throws(() => unhex("0x123"));
});

test("the EVM chains follow the network", () => {
  assert.deepEqual(evmNetworksOf(networks.testnet).map((n) => n.chainId), [11_155_111, 84_532, 421_614]);
  assert.deepEqual(evmNetworksOf(networks.mainnet).map((n) => n.chainId), [1, 8_453, 42_161]);
  const local = evmNetworksOf({ ...networks.development, evmLocalUrl: "http://127.0.0.1:8545" });
  assert.ok(local.every((n) => n.chainId === 31_337 && n.rpcUrl === "http://127.0.0.1:8545"));
});

test("secrets of purchases are encrypted with a key of their account", () => {
  const seed = new Uint8Array(32).fill(7);
  const secret = crypto.getRandomValues(new Uint8Array(32));
  const { nonce, ciphertext } = encryptSecret(seed, secret);
  assert.notDeepEqual(ciphertext.slice(0, 32), secret);
  assert.deepEqual(decryptSecret(seed, nonce, ciphertext), secret);
  assert.throws(() => decryptSecret(new Uint8Array(32).fill(8), nonce, ciphertext));
});

test("the payment of a sale is claimed only if it fits", () => {
  const hash = new Uint8Array(32).fill(1);
  const payout = new Uint8Array(20).fill(2);
  const sale = { hash, payout, due: 50_000n, payment: { chain: "Base" as const, asset: "Usdc" as const } };
  const now = 1_000_000;
  const paid = { state: "Locked", hash, recipient: payout, amount: 50_000n, timelock: now + 6 * 3600 };
  assert.equal(salePaymentProblem(paid, sale, now), undefined);
  assert.equal(salePaymentProblem({ ...paid, amount: 60_000n }, sale, now), undefined);
  assert.equal(salePaymentProblem({ ...paid, state: "Refunded" }, sale, now), "the payment is already refunded");
  assert.equal(salePaymentProblem({ ...paid, hash: new Uint8Array(32) }, sale, now), "the payment is locked under another hash");
  assert.equal(salePaymentProblem({ ...paid, recipient: new Uint8Array(20) }, sale, now), "the payment goes to another address");
  assert.equal(salePaymentProblem({ ...paid, amount: undefined }, sale, now), "the payment is not in USDC");
  assert.equal(salePaymentProblem({ ...paid, amount: 49_999n }, sale, now), "the payment holds 0.049999 USDC instead of 0.05");
  assert.equal(salePaymentProblem({ ...paid, timelock: now + SALE_CLAIM_SECONDS - 1 }, sale, now), "the payment expires in less than an hour");
  const bitcoin = { ...sale, payout: new Uint8Array(33).fill(3), due: 1_000n, payment: { chain: "Bitcoin" as const, asset: "Native" as const } };
  assert.equal(salePaymentProblem({ ...paid, recipient: bitcoin.payout, amount: 1_000n, state: "Spent" }, bitcoin, now), "the payment is already spent");
  assert.equal(salePaymentProblem({ ...paid, recipient: new Uint8Array(33), amount: 1_000n }, bitcoin, now), "the payment is locked for another key");
});
