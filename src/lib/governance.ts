/** Governance of the chain (`docs/governance.md` of the chain): what the wallet computes for
 * referenda, votes and convictions. */

/** Tracks of referenda, by id. */
export const TRACKS: Record<number, { name: string; description: string }> = {
  0: { name: "Root", description: "Anything, a runtime upgrade included" },
  1: { name: "Urgent", description: "A fix the technical committee whitelisted" },
  2: { name: "Cancellation", description: "Cancel or kill another referendum" },
};

/** Blocks of 18 seconds. */
export const BLOCKS_PER_DAY = 4_800;

/** Convictions: the multiplier of a vote and how long it stays locked after the referendum, in
 * conviction periods of a week. */
export const CONVICTIONS = [
  { value: 0, multiplier: "0.1x", weeks: 0 },
  { value: 1, multiplier: "1x", weeks: 1 },
  { value: 2, multiplier: "2x", weeks: 2 },
  { value: 3, multiplier: "3x", weeks: 4 },
  { value: 4, multiplier: "4x", weeks: 8 },
  { value: 5, multiplier: "5x", weeks: 16 },
  { value: 6, multiplier: "6x", weeks: 32 },
] as const;

/** The vote byte of the chain: the conviction, with the high bit set for aye. */
export const voteByte = (aye: boolean, conviction: number) => (aye ? 0x80 : 0) | conviction;

/** Aye and conviction of a vote byte. */
export const readVote = (byte: number) => ({ aye: (byte & 0x80) !== 0, conviction: byte & 0x7f });

/** Votes a balance gives with a conviction, as the chain counts them: a tenth without
 * conviction, `n` times with conviction `n`. */
export const votesOf = (balance: bigint, conviction: number) => (conviction === 0 ? balance / 10n : balance * BigInt(conviction));

/** A curve of a track, as polkadot-api decodes it, in billionths. */
export type Curve =
  | { type: "LinearDecreasing"; value: { length: number; floor: number; ceil: number } }
  | { type: string; value: unknown };

const BILLION = 1_000_000_000;

/** What `curve` requires at `elapsed` of `period` blocks of decision, from 0 to 1. */
export function required(curve: Curve, elapsed: number, period: number): number {
  if (curve.type !== "LinearDecreasing") return 0;
  const { length, floor, ceil } = (curve as Extract<Curve, { type: "LinearDecreasing" }>).value;
  const fraction = period > 0 ? Math.min(1, Math.max(0, elapsed / period)) : 1;
  const position = Math.min(1, fraction / Math.max(length / BILLION, 1e-9));
  return (ceil - (ceil - floor) * position) / BILLION;
}

/** A vesting schedule, as polkadot-api decodes it. */
export interface VestingSchedule {
  locked: bigint;
  per_block: bigint;
  starting_block: number;
}

/** TESS still vesting at block `now`: they do not vote. */
export function stillVesting(schedules: VestingSchedule[], now: number): bigint {
  return schedules.reduce((total, s) => {
    const vested = now > s.starting_block ? s.per_block * BigInt(now - s.starting_block) : 0n;
    return total + (vested >= s.locked ? 0n : s.locked - vested);
  }, 0n);
}

/** A fraction from 0 to 1 as a percentage with one decimal. */
export const percent = (fraction: number) => `${(Math.round(fraction * 1000) / 10).toLocaleString("en-US")}%`;

/** `blocks` as a duration in days or hours. */
export function duration(blocks: number): string {
  const hours = (blocks * 18) / 3600;
  if (hours >= 48) return `${Math.round(hours / 24)} days`;
  if (hours >= 1) return `${Math.round(hours)} hour${Math.round(hours) === 1 ? "" : "s"}`;
  return `${Math.max(1, Math.round(hours * 60))} min`;
}
