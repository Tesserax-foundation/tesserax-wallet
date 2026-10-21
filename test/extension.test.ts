// The background logic of the extension: connections, approvals and the checks of requests.

import assert from "node:assert/strict";
import test from "node:test";
import { Core, type CoreDeps } from "../src/extension/core";
import { allowedOrigin, ERRORS, validateParams, type Connection, type ProviderEvent } from "../src/extension/protocol";

const ALICE = "teqhTi5xkMrt7j8tAhU8wndjgz7rn4DfmY97Qbww7ar5KA1b5";
const BOB = "teqfdXpWfythyKEXBkC9z9LrcJ5TCv1PhLq4aCrDutGx4APgK";
const SITE = "https://app.example.com";

function setup() {
  let connections: Record<string, Connection> = {};
  const windows: string[] = [];
  const closed: number[] = [];
  const events: Array<[number, ProviderEvent]> = [];
  let ids = 0;
  const deps: CoreDeps = {
    loadConnections: async () => structuredClone(connections),
    saveConnections: async (value) => {
      connections = structuredClone(value);
    },
    walletAccounts: async () => [
      { address: ALICE, name: "alice" },
      { address: BOB, name: "bob" },
    ],
    openApproval: async (id) => {
      windows.push(id);
      return 100 + windows.length;
    },
    focusWindow: () => {},
    closeWindow: (id) => void closed.push(id),
    sendToTab: (tabId, event) => void events.push([tabId, event]),
    newId: () => `request-${++ids}`,
    now: () => 1_000,
  };
  return { core: new Core(deps), windows, closed, events, connections: () => connections };
}

/** Let the approval window open. */
const tick = () => new Promise((resolve) => setImmediate(resolve));

const rejectsWith = (promise: Promise<unknown>, code: number) => assert.rejects(promise, (error: { code: number }) => error.code === code);

async function connect(core: Core, windows: string[], tabId = 1) {
  const request = core.request(SITE, tabId, "tesserax_requestAccounts", undefined);
  await tick();
  await core.resolve(windows.at(-1)!, [ALICE]);
  return request;
}

test("parameters are checked against their method", () => {
  assert.deepEqual(validateParams("tesserax_transfer", { from: ALICE, to: BOB, amount: "1.5" }), { from: ALICE, to: BOB, amount: "1.5" });
  assert.throws(() => validateParams("tesserax_transfer", { from: ALICE, to: BOB, amount: "0" }), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_transfer", { from: ALICE, to: BOB, amount: "1.0000000000001" }), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_transfer", { from: ALICE, to: "0xdead", amount: "1" }), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_transfer", { from: ALICE, amount: "1" }), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_transfer", { from: ALICE, to: BOB, amount: "1", memo: "x" }), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_transfer", [ALICE]), { code: ERRORS.invalidParams });
  assert.throws(() => validateParams("tesserax_signMessage", { from: ALICE, message: "x".repeat(4097) }), { code: ERRORS.invalidParams });
});

test("sites connect over HTTPS, or over HTTP on this computer", () => {
  assert.equal(allowedOrigin("https://app.example.com/path?q=1"), "https://app.example.com");
  assert.equal(allowedOrigin("http://localhost:5173/"), "http://localhost:5173");
  assert.equal(allowedOrigin("http://127.0.0.1:8080/"), "http://127.0.0.1:8080");
  assert.equal(allowedOrigin("http://example.com/"), null);
  assert.equal(allowedOrigin("file:///etc/passwd"), null);
  assert.equal(allowedOrigin(undefined), null);
});

test("a site sees no account before the user connects it", async () => {
  const { core } = setup();
  assert.deepEqual(await core.request(SITE, 1, "tesserax_accounts", undefined), []);
  await rejectsWith(core.request(SITE, 1, "tesserax_transfer", { from: ALICE, to: BOB, amount: "1" }), ERRORS.unauthorized);
  await rejectsWith(core.request(SITE, 1, "eth_sendTransaction", {}), ERRORS.unsupported);
});

test("the user connects the accounts chosen, once", async () => {
  const { core, windows, connections } = setup();
  assert.deepEqual(await connect(core, windows), [{ address: ALICE, name: "alice" }]);
  assert.deepEqual(connections()[SITE], { accounts: [ALICE], connectedAt: 1_000 });
  // Connected: no window this time.
  assert.deepEqual(await core.request(SITE, 1, "tesserax_requestAccounts", undefined), [{ address: ALICE, name: "alice" }]);
  assert.equal(windows.length, 1);
  assert.deepEqual(await core.request("https://other.example", 2, "tesserax_accounts", undefined), []);
});

test("a connection only takes accounts of the wallet", async () => {
  const { core, windows, connections } = setup();
  const request = core.request(SITE, 1, "tesserax_requestAccounts", undefined);
  await tick();
  await core.resolve(windows[0], [ALICE, "te-not-in-the-wallet"]);
  await rejectsWith(request, ERRORS.invalidParams);
  assert.equal(connections()[SITE], undefined);
});

test("signatures need the account connected, and the user's approval", async () => {
  const { core, windows } = setup();
  await connect(core, windows);
  await rejectsWith(core.request(SITE, 1, "tesserax_transfer", { from: BOB, to: ALICE, amount: "1" }), ERRORS.unauthorized);

  const transfer = core.request(SITE, 1, "tesserax_transfer", { from: ALICE, to: BOB, amount: "1.5" });
  await tick();
  assert.deepEqual(core.approval(windows[1]), { id: windows[1], origin: SITE, method: "tesserax_transfer", params: { from: ALICE, to: BOB, amount: "1.5" } });
  await core.resolve(windows[1], { txHash: "0x01", blockNumber: 7 });
  assert.deepEqual(await transfer, { txHash: "0x01", blockNumber: 7 });
  assert.equal(core.approval(windows[1]), null);
});

test("one request per site waits at a time; closing its window rejects it", async () => {
  const { core, windows } = setup();
  await connect(core, windows);
  const first = core.request(SITE, 1, "tesserax_signMessage", { from: ALICE, message: "hello" });
  await tick();
  await rejectsWith(core.request(SITE, 1, "tesserax_signMessage", { from: ALICE, message: "again" }), ERRORS.pending);
  core.windowClosed(102);
  await rejectsWith(first, ERRORS.rejected);
});

test("the user rejects; a closed tab drops its request and window", async () => {
  const { core, windows, closed } = setup();
  await connect(core, windows);
  const rejected = core.request(SITE, 1, "tesserax_payAgent", { from: ALICE, agent: BOB, amount: "2" });
  await tick();
  core.reject(windows[1]);
  await rejectsWith(rejected, ERRORS.rejected);

  const dropped = core.request(SITE, 1, "tesserax_signVoucher", { from: ALICE, channel: "3", amount: "0.5" });
  await tick();
  core.tabClosed(1);
  await rejectsWith(dropped, ERRORS.rejected);
  assert.deepEqual(closed, [103]);
});

test("disconnecting tells the other tabs of the site", async () => {
  const { core, windows, events } = setup();
  await connect(core, windows, 1);
  await core.request(SITE, 2, "tesserax_accounts", undefined);
  await core.disconnect(SITE);
  assert.deepEqual(await core.request(SITE, 1, "tesserax_accounts", undefined), []);
  assert.deepEqual(
    events.map(([tab, event]) => [tab, event.data]),
    [
      [1, []],
      [2, []],
    ],
  );
});
