import { Amount, formatAddress, parseAddress, type Keypair, type TesseraxClient } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { Landmark, LockOpen, ShieldCheck, ThumbsDown, ThumbsUp, Vote } from "lucide-react";
import { useState, type ReactNode } from "react";
import { AmountInput, Button, parseAmount, Select } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink, BlockLink } from "../components/links";
import { Sheet } from "../components/Sheet";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, cx, EmptyState, ErrorState, PageHeader, SkeletonRows } from "../components/ui";
import { useBestBlock, useChain } from "../lib/chain";
import { formatTess } from "../lib/format";
import {
  CONVICTIONS,
  duration,
  percent,
  readVote,
  required,
  stillVesting,
  TRACKS,
  voteByte,
  votesOf,
  type Curve,
} from "../lib/governance";
import { useWallet } from "../lib/session";

interface TrackInfo {
  id: number;
  decisionDeposit: bigint;
  preparePeriod: number;
  decisionPeriod: number;
  confirmPeriod: number;
  minApproval: Curve;
  minSupport: Curve;
}

interface Ongoing {
  index: number;
  track: number;
  proposal: { hash: string; len?: number } | null;
  submitted: number;
  decisionDeposit: boolean;
  deciding: { since: number; confirming?: number } | null;
  ayes: bigint;
  nays: bigint;
  support: bigint;
}

interface Ended {
  index: number;
  outcome: string;
  at: number;
}

const hexOf = (value: unknown): string =>
  typeof value === "string" ? value : value && typeof (value as { asHex?: () => string }).asHex === "function" ? (value as { asHex(): string }).asHex() : "0x" + Array.from(value as Uint8Array, (b) => b.toString(16).padStart(2, "0")).join("");

async function tracksOf(client: TesseraxClient): Promise<TrackInfo[]> {
  const tracks = (await client.api.constants.Referenda.Tracks()) as Array<[number, any]>;
  return tracks.map(([id, t]) => ({
    id,
    decisionDeposit: BigInt(t.decision_deposit),
    preparePeriod: Number(t.prepare_period),
    decisionPeriod: Number(t.decision_period),
    confirmPeriod: Number(t.confirm_period),
    minApproval: t.min_approval,
    minSupport: t.min_support,
  }));
}

async function referendaOf(client: TesseraxClient): Promise<{ ongoing: Ongoing[]; ended: Ended[] }> {
  const entries = (await client.api.query.Referenda.ReferendumInfoFor.getEntries({ at: "best" })) as Array<{ keyArgs: [number]; value: { type: string; value: any } }>;
  const ongoing: Ongoing[] = [];
  const ended: Ended[] = [];
  for (const { keyArgs, value } of entries) {
    const index = Number(keyArgs[0]);
    if (value.type === "Ongoing") {
      const status = value.value;
      const proposal = status.proposal;
      ongoing.push({
        index,
        track: Number(status.track),
        proposal:
          proposal.type === "Lookup"
            ? { hash: hexOf(proposal.value.hash), len: Number(proposal.value.len) }
            : proposal.type === "Legacy"
              ? { hash: hexOf(proposal.value.hash) }
              : null,
        submitted: Number(status.submitted),
        decisionDeposit: Boolean(status.decision_deposit),
        deciding: status.deciding ? { since: Number(status.deciding.since), confirming: status.deciding.confirming === undefined ? undefined : Number(status.deciding.confirming) } : null,
        ayes: BigInt(status.tally.ayes),
        nays: BigInt(status.tally.nays),
        support: BigInt(status.tally.support),
      });
    } else {
      const at = Array.isArray(value.value) ? Number(value.value[0]) : Number(value.value);
      ended.push({ index, outcome: value.type, at });
    }
  }
  ongoing.sort((a, b) => b.index - a.index);
  ended.sort((a, b) => b.index - a.index);
  return { ongoing, ended };
}

/** TESS of `address` still vesting at the best block: they do not vote. */
async function vestingOf(client: TesseraxClient, address: string, now: number): Promise<bigint> {
  const schedules = (await client.api.query.Vesting.Vesting.getValue(address, { at: "best" })) as Array<any> | undefined;
  return stillVesting((schedules ?? []).map((s) => ({ locked: BigInt(s.locked), per_block: BigInt(s.per_block), starting_block: Number(s.starting_block) })), now);
}

/** The TESS that may vote: the issuance without what the genesis allocations still vest. */
async function votableIssuance(client: TesseraxClient, now: number): Promise<bigint> {
  const issuance = BigInt(await client.api.query.Balances.TotalIssuance.getValue({ at: "best" }));
  const allocations = (await client.api.query.Allocations.Allocations.getEntries({ at: "best" })) as Array<{ keyArgs: [string] }>;
  let vesting = 0n;
  for (const { keyArgs } of allocations) vesting += await vestingOf(client, keyArgs[0], now);
  return issuance > vesting ? issuance - vesting : 0n;
}

/** What the call of a referendum does, from its preimage. */
async function describe(client: TesseraxClient, proposal: Ongoing["proposal"]): Promise<string> {
  if (!proposal) return "Call stored inline";
  if (proposal.len === undefined) return `Call ${proposal.hash.slice(0, 18)}…`;
  const bytes = await client.api.query.Preimage.PreimageFor.getValue([proposal.hash, proposal.len], { at: "best" });
  if (!bytes) return `Call ${proposal.hash.slice(0, 18)}… (preimage not stored)`;
  try {
    const tx = await client.api.txFromCallData(bytes);
    const call = tx.decodedCall as { type: string; value: { type: string; value: any } };
    if (call.type === "System" && call.value.type === "set_code") return `Runtime upgrade, ${(proposal.len / 1024).toFixed(0)} KiB`;
    if (call.type === "Whitelist" && call.value.type === "dispatch_whitelisted_call_with_preimage") {
      const inner = call.value.value.call as { type: string; value: { type: string } };
      return `Whitelisted ${inner.type}.${inner.value.type}`;
    }
    if (call.type === "Referenda" && (call.value.type === "cancel" || call.value.type === "kill")) return `${call.value.type === "kill" ? "Kill" : "Cancel"} referendum #${call.value.value.index}`;
    return `${call.type}.${call.value.type}`;
  } catch {
    return `Call ${proposal.hash.slice(0, 18)}…`;
  }
}

/** The votes of `address` on every track: by referendum, and the locks they leave. */
async function votesOfAccount(client: TesseraxClient, address: string) {
  const votes: Array<{ index: number; track: number; aye: boolean; conviction: number; balance: bigint }> = [];
  let delegating: Array<{ track: number; target: string; balance: bigint }> = [];
  for (const track of Object.keys(TRACKS).map(Number)) {
    const voting = (await client.api.query.ConvictionVoting.VotingFor.getValue(address, track, { at: "best" })) as { type: string; value: any } | undefined;
    if (voting?.type === "Casting") {
      for (const [index, vote] of voting.value.votes as Array<[number, { type: string; value: any }]>) {
        if (vote.type === "Standard") {
          const { aye, conviction } = readVote(Number(vote.value.vote));
          votes.push({ index: Number(index), track, aye, conviction, balance: BigInt(vote.value.balance) });
        }
      }
    } else if (voting?.type === "Delegating") {
      delegating = [...delegating, { track, target: formatAddress(parseAddress(voting.value.target)), balance: BigInt(voting.value.balance) }];
    }
  }
  const locks = (await client.api.query.ConvictionVoting.ClassLocksFor.getValue(address, { at: "best" })) as Array<[number, bigint]>;
  return { votes, delegating, locks: locks.map(([track, amount]) => ({ track: Number(track), amount: BigInt(amount) })) };
}

function useGovernance() {
  const { client, url } = useChain();
  const best = useBestBlock();
  const now = best.data ?? 0;
  const tracks = useQuery({ queryKey: ["tracks", url], queryFn: () => tracksOf(client), staleTime: Infinity });
  const referenda = useQuery({ queryKey: ["referenda", url], queryFn: () => referendaOf(client), refetchInterval: 18_000 });
  const votable = useQuery({ queryKey: ["votable", url, Math.floor(now / 200)], queryFn: () => votableIssuance(client, now), enabled: now > 0 });
  return { tracks, referenda, votable, now };
}

function Bar({ value, needed, label }: { value: number; needed: number; label: string }) {
  const ok = value >= needed;
  return (
    <div>
      <div className="flex flex-wrap justify-between gap-x-3 text-xs">
        <span className="text-muted">{label}</span>
        <span className={cx("tabular", ok ? "text-success" : "text-muted")}>
          {percent(value)} <span className="text-faint">/ {percent(needed)} needed</span>
        </span>
      </div>
      <div className="relative mt-1 h-1.5 overflow-hidden rounded-full bg-surface-3">
        <div className={cx("absolute inset-y-0 left-0 rounded-full", ok ? "bg-success" : "bg-accent")} style={{ width: `${Math.min(100, value * 100)}%` }} />
        <div className="absolute inset-y-0 w-0.5 bg-fg/60" style={{ left: `${Math.min(100, needed * 100)}%` }} />
      </div>
    </div>
  );
}

function ReferendumCard({ r, track, votable, now, onVote }: { r: Ongoing; track?: TrackInfo; votable?: bigint; now: number; onVote: () => void }) {
  const { client, url } = useChain();
  const description = useQuery({ queryKey: ["proposal", url, r.proposal?.hash], queryFn: () => describe(client, r.proposal), staleTime: Infinity });
  const total = r.ayes + r.nays;
  const approval = total > 0n ? Number((r.ayes * 1_000_000n) / total) / 1_000_000 : 0;
  const support = votable && votable > 0n ? Number((r.support * 1_000_000n) / votable) / 1_000_000 : 0;
  const elapsed = r.deciding ? now - r.deciding.since : 0;
  const neededApproval = track ? required(track.minApproval, elapsed, track.decisionPeriod) : 0.5;
  const neededSupport = track ? required(track.minSupport, elapsed, track.decisionPeriod) : 0;

  let status: ReactNode;
  if (!r.decisionDeposit) status = <Badge tone="warning">Waiting for its decision deposit</Badge>;
  else if (!r.deciding) status = <Badge>Preparing{track ? `, voting in ${duration(Math.max(0, r.submitted + track.preparePeriod - now))}` : ""}</Badge>;
  else if (r.deciding.confirming !== undefined) status = <Badge tone="success">Passing, confirmed in {duration(Math.max(0, r.deciding.confirming - now))}</Badge>;
  else status = <Badge tone="accent">Voting{track ? `, ${duration(Math.max(0, r.deciding.since + track.decisionPeriod - now))} left` : ""}</Badge>;

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-muted">
            <span className="font-semibold text-fg">#{r.index}</span>
            <span>{TRACKS[r.track]?.name ?? `Track ${r.track}`}</span>
          </div>
          <div className="mt-1 font-semibold">{description.data ?? "…"}</div>
        </div>
        {status}
      </div>
      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <Bar label="Approval" value={approval} needed={neededApproval} />
        <Bar label="Support" value={support} needed={neededSupport} />
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-xs text-muted">
        <span className="tabular">
          Aye {formatTess(r.ayes, 2)} · Nay {formatTess(r.nays, 2)} votes · {formatTess(r.support, 2)} TESS for it
        </span>
        <Button size="sm" onClick={onVote}>
          <Vote size={14} /> Vote
        </Button>
      </div>
    </Card>
  );
}

function VoteSheet({ r, votable, onClose }: { r: Ongoing; votable?: bigint; onClose: () => void }) {
  const tx = useTransaction();
  const [aye, setAye] = useState(true);
  const [amount, setAmount] = useState("");
  const [conviction, setConviction] = useState("1");
  const [submitted, setSubmitted] = useState(false);
  const parsed = parseAmount(amount, { max: votable });
  const error = !amount ? "Enter an amount" : parsed.error ?? null;
  const n = Number(conviction);
  const chosen = CONVICTIONS[n];

  const review = () => {
    setSubmitted(true);
    if (error || !parsed.amount) return;
    const balance = parsed.amount.planck;
    tx({
      title: `Vote on referendum #${r.index}`,
      summary: (
        <>
          {aye ? "Aye" : "Nay"} · {formatTess(balance, 4)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["Conviction", `${chosen.multiplier}, ${formatTess(votesOf(balance, n), 2)} votes`],
        ["Lock", chosen.weeks ? `These TESS stay locked ${chosen.weeks} week${chosen.weeks > 1 ? "s" : ""} after the referendum, if it ends your way` : "Locked until the referendum ends only"],
      ],
      operation: (c: TesseraxClient, key: Keypair) =>
        c.submit(c.api.tx.ConvictionVoting.vote({ poll_index: r.index, vote: { type: "Standard", value: { vote: voteByte(aye, n), balance } } }), key),
      onDone: onClose,
    });
  };

  return (
    <Sheet title={`Vote on #${r.index}`} icon={<Vote size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-2">
          {[true, false].map((choice) => (
            <button
              key={String(choice)}
              onClick={() => setAye(choice)}
              aria-pressed={aye === choice}
              className={cx(
                "flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold",
                aye === choice ? (choice ? "border-success bg-success-soft text-success" : "border-danger bg-danger-soft text-danger") : "border-line bg-surface text-muted hover:border-line-strong",
              )}
            >
              {choice ? <ThumbsUp size={16} /> : <ThumbsDown size={16} />} {choice ? "Aye" : "Nay"}
            </button>
          ))}
        </div>
        <AmountInput
          label="TESS voting"
          value={amount}
          onChange={setAmount}
          max={votable !== undefined ? new Amount(votable) : undefined}
          error={submitted ? error : null}
          hint={votable !== undefined ? <>You may vote with {formatTess(votable, 4)} TESS: TESS still vesting do not vote</> : undefined}
        />
        <Select
          label="Conviction"
          value={conviction}
          onChange={setConviction}
          options={CONVICTIONS.map((c) => ({
            value: String(c.value),
            label: c.value === 0 ? "0.1x, no lock after the referendum" : `${c.multiplier}, locked ${c.weeks} week${c.weeks > 1 ? "s" : ""} after it`,
          }))}
        />
        <p className="text-xs text-muted">The TESS stay in your account: a vote locks them, it never spends them. Remove the vote, then unlock them once the lock is over.</p>
        <Button className="w-full" onClick={review}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

function MyVotes({ votable, ended }: { votable?: bigint; ended: Set<number> }) {
  const { client, url } = useChain();
  const { active } = useWallet();
  const tx = useTransaction();
  const mine = useQuery({ queryKey: ["my-votes", url, active?.address], queryFn: () => votesOfAccount(client, active!.address), enabled: Boolean(active), refetchInterval: 18_000 });
  const locked = (mine.data?.locks ?? []).reduce((max, l) => (l.amount > max ? l.amount : max), 0n);

  return (
    <Card>
      <CardHeader title="Your votes" icon={<Vote size={16} />} />
      <div className="space-y-4 p-4 sm:p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-muted">May vote</div>
            <div className="mt-0.5 font-semibold tabular">{votable !== undefined ? `${formatTess(votable, 4)} TESS` : "…"}</div>
          </div>
          <div className="rounded-xl bg-surface-2 p-3">
            <div className="text-xs text-muted">Locked by votes</div>
            <div className="mt-0.5 font-semibold tabular">{formatTess(locked, 4)} TESS</div>
          </div>
        </div>
        {mine.error ? (
          <ErrorState error={mine.error} />
        ) : !mine.data ? (
          <SkeletonRows rows={2} />
        ) : mine.data.votes.length === 0 && mine.data.delegating.length === 0 ? (
          <p className="text-sm text-muted">No vote yet.</p>
        ) : (
          <ul className="divide-y divide-line">
            {mine.data.votes.map((v) => (
              <li key={`${v.track}-${v.index}`} className="flex items-center justify-between gap-3 py-2.5 text-sm">
                <span>
                  #{v.index} · <span className={v.aye ? "text-success" : "text-danger"}>{v.aye ? "Aye" : "Nay"}</span> · {formatTess(v.balance, 2)} TESS · {CONVICTIONS[v.conviction]?.multiplier}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    tx({
                      title: `Remove the vote on #${v.index}`,
                      details: [["Lock", ended.has(v.index) ? "If the referendum ended your way, the lock remains until its conviction period is over" : "The vote no longer counts"]],
                      operation: (c: TesseraxClient, key: Keypair) => c.submit(c.api.tx.ConvictionVoting.remove_vote({ class: v.track, index: v.index }), key),
                    })
                  }
                >
                  Remove
                </Button>
              </li>
            ))}
            {mine.data.delegating.map((d) => (
              <li key={`d-${d.track}`} className="py-2.5 text-sm">
                {TRACKS[d.track]?.name}: {formatTess(d.balance, 2)} TESS delegated to <AddressLink address={d.target} />
              </li>
            ))}
          </ul>
        )}
        {(mine.data?.locks.length ?? 0) > 0 && (
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              tx({
                title: "Unlock TESS",
                details: [["What", "Releases the TESS whose vote locks are over, on every track"]],
                operation: async (c: TesseraxClient, key: Keypair) => {
                  let last: unknown;
                  for (const { track } of mine.data!.locks) {
                    last = await c.submit(c.api.tx.ConvictionVoting.unlock({ class: track, target: { type: "Id", value: key.address } }), key);
                  }
                  return last;
                },
              })
            }
          >
            <LockOpen size={14} /> Unlock expired locks
          </Button>
        )}
      </div>
    </Card>
  );
}

function Committee() {
  const { client, url } = useChain();
  const members = useQuery({
    queryKey: ["committee", url],
    queryFn: async () => ((await client.api.query.TechnicalCommittee.Members.getValue({ at: "best" })) as string[]).map((m) => formatAddress(parseAddress(m))),
    staleTime: 600_000,
  });
  return (
    <Card>
      <CardHeader title="Technical committee" icon={<ShieldCheck size={16} />} />
      <div className="space-y-3 p-4 sm:p-5">
        <p className="text-sm text-muted">Two of these three whitelist an urgent fix, which still needs a referendum of the urgent track. They can do nothing else, and they never change.</p>
        <ul className="space-y-1.5">
          {(members.data ?? []).map((m) => (
            <li key={m}>
              <AddressLink address={m} />
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}

export function Governance() {
  const { tracks, referenda, votable, now } = useGovernance();
  const { client, url } = useChain();
  const { active } = useWallet();
  const [voting, setVoting] = useState<Ongoing | null>(null);
  const mine = useQuery({
    queryKey: ["votable-of", url, active?.address, Math.floor(now / 200)],
    queryFn: async () => {
      const balance = await client.balance(active!.address);
      const total = balance.free.planck + balance.reserved.planck;
      const vesting = await vestingOf(client, active!.address, now);
      return total > vesting ? total - vesting : 0n;
    },
    enabled: Boolean(active) && now > 0,
  });
  const ended = new Set((referenda.data?.ended ?? []).map((e) => e.index));

  return (
    <Page>
      <PageHeader title="Governance" icon={<Landmark size={20} />} subtitle="There is no sudo key: referenda decide, and TESS vote with conviction." />
      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="space-y-4">
          {referenda.error ? (
            <ErrorState error={referenda.error} />
          ) : !referenda.data ? (
            <SkeletonRows rows={3} />
          ) : referenda.data.ongoing.length === 0 ? (
            <Card>
              <EmptyState title="No referendum ongoing">
                Proposals are submitted with the command line wallet: <span className="font-mono">tesserax-wallet governance propose-upgrade</span>.
              </EmptyState>
            </Card>
          ) : (
            referenda.data.ongoing.map((r) => (
              <ReferendumCard key={r.index} r={r} track={tracks.data?.find((t) => t.id === r.track)} votable={votable.data} now={now} onVote={() => setVoting(r)} />
            ))
          )}
          {(referenda.data?.ended.length ?? 0) > 0 && (
            <Card>
              <CardHeader title="Ended" icon={<Landmark size={16} />} />
              <ul className="divide-y divide-line">
                {referenda.data!.ended.slice(0, 20).map((e) => (
                  <li key={e.index} className="flex items-center justify-between px-4 py-2.5 text-sm sm:px-5">
                    <span>#{e.index}</span>
                    <span className="flex items-center gap-2">
                      <Badge tone={e.outcome === "Approved" ? "success" : e.outcome === "Rejected" || e.outcome === "Killed" ? "danger" : "neutral"}>{e.outcome}</Badge>
                      {e.at > 0 && (
                        <span className="text-xs text-muted">
                          block <BlockLink number={e.at} />
                        </span>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
        <div className="space-y-4">
          <MyVotes votable={mine.data} ended={ended} />
          <Committee />
        </div>
      </div>
      {voting && <VoteSheet r={voting} votable={mine.data} onClose={() => setVoting(null)} />}
    </Page>
  );
}
