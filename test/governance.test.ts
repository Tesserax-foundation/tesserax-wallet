import assert from "node:assert/strict";
import { test } from "node:test";
import { duration, percent, readVote, required, stillVesting, voteByte, votesOf } from "../src/lib/governance";

test("votes encode their conviction and direction as the chain does", () => {
  assert.equal(voteByte(true, 3), 0x83);
  assert.equal(voteByte(false, 0), 0x00);
  assert.deepEqual(readVote(0x86), { aye: true, conviction: 6 });
  assert.deepEqual(readVote(0x02), { aye: false, conviction: 2 });
  // Without conviction a vote counts a tenth; with conviction n, n times.
  assert.equal(votesOf(1000n, 0), 100n);
  assert.equal(votesOf(1000n, 6), 6000n);
});

test("thresholds decrease over the decision period", () => {
  const approval = { type: "LinearDecreasing", value: { length: 1_000_000_000, floor: 500_000_000, ceil: 1_000_000_000 } };
  assert.equal(required(approval, 0, 100), 1);
  assert.equal(required(approval, 50, 100), 0.75);
  assert.equal(required(approval, 100, 100), 0.5);
  assert.equal(required(approval, 500, 100), 0.5);
  const support = { type: "LinearDecreasing", value: { length: 1_000_000_000, floor: 10_000_000, ceil: 200_000_000 } };
  assert.ok(Math.abs(required(support, 0, 100) - 0.2) < 1e-9);
  assert.ok(Math.abs(required(support, 100, 100) - 0.01) < 1e-9);
});

test("vesting TESS are counted until released", () => {
  const schedules = [{ locked: 1000n, per_block: 10n, starting_block: 100 }];
  assert.equal(stillVesting(schedules, 50), 1000n);
  assert.equal(stillVesting(schedules, 150), 500n);
  assert.equal(stillVesting(schedules, 250), 0n);
  assert.equal(stillVesting([], 1), 0n);
});

test("durations and percentages read well", () => {
  assert.equal(duration(14 * 4800), "14 days");
  assert.equal(duration(200), "1 hour");
  assert.equal(duration(33), "10 min");
  assert.equal(percent(0.139), "13.9%");
});
