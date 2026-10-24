import assert from "node:assert/strict";
import { test } from "node:test";
import { isAvailable, networkOf, networks, wrongChain } from "../src/lib/networks";

const testnet = networks.testnet;

test("the testnet is built in, with its genesis and faucet", () => {
  assert.equal(testnet.genesisHash, "0xc2f9cb03897c5ad30fff2f93debaa8b4a6e08f37a12270e107c71eb1ad39e5d1");
  assert.ok(testnet.nodeUrl.startsWith("wss://"));
  assert.ok(testnet.faucetUrl);
  assert.equal(testnet.test, true);
});

test("the mainnet is unavailable until its genesis is known", () => {
  assert.equal(networks.mainnet.genesisHash, undefined);
  assert.equal(isAvailable(networks.mainnet), false);
  assert.equal(networks.mainnet.faucetUrl, undefined);
  // A saved choice of the mainnet falls back to the default network.
  assert.notEqual(networkOf("mainnet").id, "mainnet");
  assert.equal(isAvailable({ ...networks.mainnet, genesisHash: "0x" + "ab".repeat(32) }), true);
});

test("saved choices are read, and unknown ones fall back", () => {
  assert.equal(networkOf("testnet").id, "testnet");
  assert.equal(networkOf("development").id, "development");
  assert.equal(networkOf("elsewhere").id, networkOf(undefined).id);
});

test("a node of another chain is refused", () => {
  assert.equal(wrongChain(testnet, testnet.genesisHash!), null);
  assert.equal(wrongChain(testnet, testnet.genesisHash!.toUpperCase().replace("0X", "0x")), null);
  assert.match(wrongChain(testnet, "0x" + "00".repeat(32)) ?? "", /another chain than the testnet/);
  // Any chain serves the development network.
  assert.equal(wrongChain(networks.development, "0x" + "00".repeat(32)), null);
});
