import assert from "node:assert/strict";
import { test } from "node:test";
import { Keypair, toH160 } from "@tesserax/sdk";
import { argument, argumentsOf, contractAddress, display, outputs, parseAbi, signature, isRead, isWrite } from "../src/lib/contracts";

const ABI = JSON.stringify([
  { type: "constructor", inputs: [{ name: "name_", type: "string" }, { name: "supply", type: "uint256" }], stateMutability: "nonpayable" },
  { type: "function", name: "balanceOf", inputs: [{ name: "", type: "address" }], outputs: [{ name: "", type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "transfer", inputs: [{ name: "to", type: "address" }, { name: "value", type: "uint256" }], outputs: [{ name: "", type: "bool" }], stateMutability: "nonpayable" },
  { type: "event", name: "Transfer", inputs: [] },
]);

test("ABIs are read from JSON or from compiler output", () => {
  const abi = parseAbi(ABI);
  assert.equal(abi.length, 4);
  assert.deepEqual(parseAbi(JSON.stringify({ abi: JSON.parse(ABI) })), abi);
  assert.deepEqual(abi.filter(isRead).map(signature), ["balanceOf(address)"]);
  assert.deepEqual(abi.filter(isWrite).map(signature), ["transfer(address,uint256)"]);
  assert.throws(() => parseAbi("not json"), /Not JSON/);
  assert.throws(() => parseAbi('{"a":1}'), /Not an ABI/);
});

test("addresses take 0x addresses and Tesserax addresses", () => {
  const alice = Keypair.fromUri("//Alice");
  assert.equal(contractAddress(alice.address), toH160(alice.address));
  const lower = toH160(alice.address).toLowerCase();
  assert.equal(contractAddress(lower), toH160(alice.address));
  assert.equal(contractAddress("0x123"), null);
  assert.equal(contractAddress("te123"), null);
  assert.equal(argument({ type: "address" }, alice.address), toH160(alice.address));
});

test("integers are checked against their type", () => {
  assert.equal(argument({ type: "uint256" }, "1_000_000"), 1_000_000n);
  assert.equal(argument({ type: "uint8" }, "0xff"), 255n);
  assert.throws(() => argument({ type: "uint8" }, "256"), /out of the range/);
  assert.throws(() => argument({ type: "uint256" }, "-1"), /out of the range/);
  assert.equal(argument({ type: "int8" }, "-128"), -128n);
  assert.throws(() => argument({ type: "uint256" }, "1.5"), /an integer/);
});

test("bytes, booleans, arrays and tuples", () => {
  assert.equal(argument({ type: "bool" }, " TRUE "), true);
  assert.throws(() => argument({ type: "bool" }, "yes"));
  assert.equal(argument({ type: "bytes" }, "0xabcd"), "0xabcd");
  assert.throws(() => argument({ type: "bytes2" }, "0xab"), /2 bytes/);
  assert.deepEqual(argument({ type: "uint256[]" }, '["1", 2]'), [1n, 2n]);
  assert.throws(() => argument({ type: "uint256[2]" }, '["1"]'), /2 elements/);
  const tuple = { type: "tuple", components: [{ name: "a", type: "uint8" }, { name: "b", type: "string" }] };
  assert.deepEqual(argument(tuple, '{"a": "7", "b": "x"}'), [7n, "x"]);
  assert.deepEqual(argument(tuple, '["7", "x"]'), [7n, "x"]);
});

test("forms give values or the error of each field", () => {
  const inputs = [{ name: "to", type: "address" }, { name: "value", type: "uint256" }];
  assert.deepEqual(argumentsOf(inputs, ["nope", "12"]).errors.map(Boolean), [true, false]);
  assert.equal(argumentsOf(inputs, ["nope", "12"]).values, undefined);
  const alice = Keypair.fromUri("//Alice");
  assert.deepEqual(argumentsOf(inputs, [alice.address, "12"]).values, [toH160(alice.address), 12n]);
});

test("results are shown by name", () => {
  assert.equal(display(10n ** 30n), "1000000000000000000000000000000");
  assert.deepEqual(outputs({ type: "function", outputs: [{ name: "", type: "uint256" }] }, 5n), [["uint256", "5"]]);
  assert.deepEqual(
    outputs({ type: "function", outputs: [{ name: "x", type: "uint8" }, { name: "y", type: "bool" }] }, [1n, true]),
    [["x", "1"], ["y", "true"]],
  );
});
