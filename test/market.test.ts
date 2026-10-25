import assert from "node:assert/strict";
import { test } from "node:test";
import { decimal, evmNetworksOf, hex, unhex, units } from "../src/lib/evm";
import { networks } from "../src/lib/networks";
import { decryptSecret, encryptSecret } from "../src/lib/market";

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
