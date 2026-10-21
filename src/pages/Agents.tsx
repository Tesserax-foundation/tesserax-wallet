import { Amount, type AgentRecord, type Delegation, type Keypair, type Policy, type Profile, type TesseraxClient } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { BadgeCheck, Bot, Coins, Pencil, Plus, Power, Search, ShieldOff, Star, ThumbsDown, ThumbsUp, Trash2, UserCheck, Wallet } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { AddressInput, AmountInput, Button, parseAmount, TextArea, TextInput, Toggle } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink, ExplorerLink } from "../components/links";
import { PayWith } from "../components/PayWith";
import { Sheet } from "../components/Sheet";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, EmptyState, ErrorState, Field, Fields, PageHeader, SkeletonRows, StatCard, Tabs } from "../components/ui";
import { BLOCKS_PER_HOUR, deregisterAgent, normalizeAddress, setOwner, useAgentRecord, useBestBlock, useChain, useGivenDelegations, useReceivedDelegations } from "../lib/chain";
import { blocksDuration, formatTess, plural } from "../lib/format";
import { useWallet } from "../lib/session";

type Tab = "given" | "received" | "mine" | "discover";

export function Agents() {
  const [params, setParams] = useSearchParams();
  const tab = (["given", "received", "mine", "discover"].includes(params.get("tab") ?? "") ? params.get("tab") : "given") as Tab;
  const { active } = useWallet();
  const given = useGivenDelegations(active?.address);
  const received = useReceivedDelegations(active?.address);
  return (
    <Page>
      <PageHeader title="AI agents" icon={<Bot size={20} />} subtitle="Give agents a spending budget, run your own agent, and find agents to pay." />
      <Card>
        <div className="border-b border-line">
          <Tabs<Tab>
            value={tab}
            onChange={(id) => setParams(id === "given" ? {} : { tab: id }, { replace: true })}
            tabs={[
              { id: "given", label: "Budgets given", count: given.data?.length },
              { id: "received", label: "Budgets received", count: received.data?.length },
              { id: "mine", label: "My agent" },
              { id: "discover", label: "Discover" },
            ]}
          />
        </div>
        {tab === "given" && <Given />}
        {tab === "received" && <Received />}
        {tab === "mine" && <MyAgent />}
        {tab === "discover" && <Discover />}
      </Card>
    </Page>
  );
}

// Delegations.

function Meter({ used, total }: { used: bigint; total: bigint }) {
  const share = total === 0n ? 0 : Number((used * 1000n) / total) / 10;
  return (
    <div className="h-2 overflow-hidden rounded-full bg-surface-3">
      <div className={share >= 90 ? "h-full rounded-full bg-warning" : "h-full rounded-full bg-accent"} style={{ width: `${Math.min(100, share)}%` }} />
    </div>
  );
}

function AgentName({ address }: { address: string }) {
  const { data } = useAgentRecord(address);
  return data ? <Badge tone="accent">{data.profile.name}</Badge> : null;
}

function PolicyFields({ d }: { d: Delegation }) {
  const best = useBestBlock();
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-4">
      <Detail label="Per call">{formatTess(d.policy.maxPerCall.planck, 4)} TESS</Detail>
      <Detail label="Period">{blocksDuration(d.policy.periodBlocks)}</Detail>
      <Detail label="Expires">
        {d.policy.expiresAt === undefined ? "Never" : d.expired ? "Expired" : best.data ? `in ${blocksDuration(d.policy.expiresAt - best.data)}` : `block ${d.policy.expiresAt}`}
      </Detail>
      <Detail label="Allows">{[d.policy.transfers && "transfers", d.policy.contracts && "contracts"].filter(Boolean).join(", ") || "nothing"}</Detail>
      {d.policy.targets.length > 0 && (
        <div className="col-span-full">
          <div className="text-xs text-muted">Only to</div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {d.policy.targets.map((t) => (
              <AddressLink key={t} address={t} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 truncate font-medium tabular">{children}</div>
    </div>
  );
}

function DelegationCard({ d, side, actions }: { d: Delegation; side: "agent" | "owner"; actions: ReactNode }) {
  const counterpart = side === "agent" ? d.agent : d.owner;
  const used = d.expired ? d.policy.budget.planck : d.policy.budget.planck - d.remaining.planck;
  return (
    <li className="space-y-4 px-4 py-5 sm:px-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="text-sm text-muted">{side === "agent" ? "Agent" : "Owner"}</span>
          <AddressLink address={counterpart} copy />
          {side === "agent" && <AgentName address={d.agent} />}
          {d.expired && <Badge tone="danger">Expired</Badge>}
        </div>
        <div className="flex gap-2">{actions}</div>
      </div>
      <div>
        <div className="mb-1.5 flex items-baseline justify-between gap-3 text-sm">
          <span>
            <span className="font-semibold tabular">{formatTess(d.remaining.planck, 4)}</span> <span className="text-muted">of {formatTess(d.policy.budget.planck, 4)} TESS left this period</span>
          </span>
        </div>
        <Meter used={used} total={d.policy.budget.planck} />
      </div>
      <PolicyFields d={d} />
    </li>
  );
}

function Given() {
  const { active } = useWallet();
  const tx = useTransaction();
  const { data, error, isLoading } = useGivenDelegations(active?.address);
  const [params] = useSearchParams();
  // A new agent key from the accounts page arrives here to get its budget.
  const [editing, setEditing] = useState<Delegation | "new" | null>(params.get("authorize") ? "new" : null);
  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
        <p className="max-w-xl text-sm text-muted">An agent key spends from this account within the budget you set, renewed every period. Revoke it at any time.</p>
        <Button onClick={() => setEditing("new")}>
          <Plus size={16} /> Authorize an agent
        </Button>
      </div>
      {error ? (
        <ErrorState error={error} />
      ) : isLoading ? (
        <SkeletonRows rows={3} />
      ) : !data?.length ? (
        <EmptyState title="No agent has a budget">Authorize the key of an AI agent to let it pay for you, within limits.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((d) => (
            <DelegationCard
              key={d.agent}
              d={d}
              side="agent"
              actions={
                <>
                  <Button variant="secondary" size="sm" onClick={() => setEditing(d)}>
                    <Pencil size={14} /> Edit
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm" className="text-danger"
                    onClick={() =>
                      tx({
                        title: "Revoke the delegation",
                        details: [["Agent", <AddressLink key="a" address={d.agent} full />]],
                        warning: "The agent can no longer spend for this account, starting with the next block.",
                        operation: (c: TesseraxClient, k: Keypair) => c.revokeAgent(k, d.agent),
                      })
                    }
                  >
                    <ShieldOff size={14} /> Revoke
                  </Button>
                </>
              }
            />
          ))}
        </ul>
      )}
      {editing && <AuthorizeSheet current={editing === "new" ? undefined : editing} initialAgent={params.get("authorize") ?? ""} onClose={() => setEditing(null)} />}
    </>
  );
}

function AuthorizeSheet({ current, initialAgent = "", onClose }: { current?: Delegation; initialAgent?: string; onClose: () => void }) {
  const { active } = useWallet();
  const tx = useTransaction();
  const best = useBestBlock();
  const p = current?.policy;
  const [agent, setAgent] = useState(current?.agent ?? initialAgent);
  const [budget, setBudget] = useState(p ? p.budget.toString() : "");
  const [perCall, setPerCall] = useState(p ? p.maxPerCall.toString() : "");
  const [hours, setHours] = useState(p ? String(Math.max(1, Math.round(p.periodBlocks / BLOCKS_PER_HOUR))) : "24");
  const [expires, setExpires] = useState(p?.expiresAt && best.data ? String(Math.max(1, Math.ceil((p.expiresAt - best.data) / BLOCKS_PER_HOUR))) : "");
  const [transfers, setTransfers] = useState(p?.transfers ?? true);
  const [contracts, setContracts] = useState(p?.contracts ?? false);
  const [targets, setTargets] = useState(p?.targets.join("\n") ?? "");
  const [submitted, setSubmitted] = useState(false);

  const agentAddress = normalizeAddress(agent);
  const budgetAmount = parseAmount(budget);
  const perCallAmount = parseAmount(perCall, { max: budgetAmount.amount?.planck });
  const targetList = targets.split(/[\s,]+/).filter(Boolean);
  const badTarget = targetList.find((t) => !normalizeAddress(t));
  const errors = {
    agent: !agent ? "Enter the address of the agent key" : !agentAddress ? "Not a Tesserax address" : agentAddress === active?.address ? "An account cannot be its own agent" : null,
    budget: !budget ? "Enter a budget" : budgetAmount.error,
    perCall: !perCall ? "Enter a limit per call" : perCallAmount.error === "More than available" ? "Above the budget" : perCallAmount.error,
    hours: !/^\d+$/.test(hours) || Number(hours) < 1 || Number(hours) > 8760 ? "From 1 hour to a year" : null,
    expires: expires && (!/^\d+$/.test(expires) || Number(expires) < 1) ? "A number of hours, or empty" : null,
    targets: badTarget ? `Not an address: ${badTarget.slice(0, 16)}` : targetList.length > 32 ? "At most 32 recipients" : null,
  };
  const valid = !Object.values(errors).some(Boolean);

  const submit = async () => {
    setSubmitted(true);
    if (!valid || !agentAddress) return;
    const policy: Policy = {
      budget: budgetAmount.amount!,
      maxPerCall: perCallAmount.amount!,
      periodBlocks: Number(hours) * BLOCKS_PER_HOUR,
      transfers,
      contracts,
      targets: targetList.map((t) => normalizeAddress(t)!),
    };
    tx({
      title: current ? "Change the delegation" : "Authorize an agent",
      summary: (
        <>
          {formatTess(policy.budget.planck, 6)} <span className="text-xl text-muted">TESS / {plural(Number(hours), "hour")}</span>
        </>
      ),
      details: [
        ["Agent", <AddressLink key="a" address={agentAddress} full />],
        ["Per call", `${formatTess(policy.maxPerCall.planck, 6)} TESS`],
        ["Expires", expires ? `in ${plural(Number(expires), "hour")}` : "Never"],
        ["Allows", [transfers && "transfers", contracts && "contracts"].filter(Boolean).join(", ") || "nothing"],
        ["Recipients", policy.targets!.length ? plural(policy.targets!.length, "address", "addresses") : "Any"],
      ],
      warning: "The agent spends from this account without asking, up to the budget of each period. A small deposit is reserved while the delegation exists.",
      // The expiry is counted from the best block when signing.
      operation: async (c: TesseraxClient, k: Keypair) => c.authorizeAgent(k, agentAddress, { ...policy, expiresAt: expires ? (await c.bestBlockNumber()) + Number(expires) * BLOCKS_PER_HOUR : undefined }),
      onDone: onClose,
    });
  };

  return (
    <Sheet title={current ? "Edit the delegation" : "Authorize an agent"} icon={<Bot size={18} />} onClose={onClose}>
      <div className="space-y-5">
        {current ? (
          <Field label="Agent">
            <AddressLink address={current.agent} full />
          </Field>
        ) : (
          <AddressInput label="Agent key" value={agent} onChange={setAgent} error={submitted ? errors.agent : null} exclude={active?.address} />
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <AmountInput label="Budget per period" value={budget} onChange={setBudget} error={submitted ? errors.budget : null} />
          <TextInput label="Period" hint="hours" value={hours} onChange={(e) => setHours(e.target.value.replace(/\D/g, ""))} inputMode="numeric" error={submitted ? errors.hours : null} />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <AmountInput label="Limit per call" value={perCall} onChange={setPerCall} error={submitted ? errors.perCall : null} />
          <TextInput label="Expires after" hint="hours, optional" value={expires} onChange={(e) => setExpires(e.target.value.replace(/\D/g, ""))} inputMode="numeric" placeholder="Never" error={submitted ? errors.expires : null} />
        </div>
        <div className="space-y-4 rounded-2xl border border-line p-4">
          <Toggle checked={transfers} onChange={setTransfers} label="Transfers" description="Send TESS, pay agents, open channels and tasks" />
          <Toggle checked={contracts} onChange={setContracts} label="Contract calls" description="Call smart contracts for this account" />
        </div>
        <TextArea label="Allowed recipients" hint="optional" value={targets} onChange={(e) => setTargets(e.target.value)} placeholder="Any recipient. Or one address per line." spellCheck={false} rows={3} mono error={submitted ? errors.targets : null} />
        <Button className="w-full" onClick={submit}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

function Received() {
  const { active } = useWallet();
  const tx = useTransaction();
  const { data, error, isLoading } = useReceivedDelegations(active?.address);
  return (
    <>
      <p className="border-b border-line px-4 py-4 text-sm text-muted sm:px-5">Owners who gave this account a budget. Spend it from the Send, Channels and Tasks pages with “Pay with”.</p>
      {error ? (
        <ErrorState error={error} />
      ) : isLoading ? (
        <SkeletonRows rows={3} />
      ) : !data?.length ? (
        <EmptyState title="No budget received">When an owner authorizes this account as an agent, its budget appears here.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((d) => (
            <DelegationCard
              key={d.owner}
              d={d}
              side="owner"
              actions={
                <>
                  <Link to={`/send?from=${d.owner}`} className="inline-flex h-9 items-center gap-2 rounded-xl bg-accent px-3.5 text-sm font-semibold text-white hover:bg-accent-strong">
                    <Coins size={14} /> Spend
                  </Link>
                  <Button
                    variant="secondary"
                    size="sm" className="text-danger"
                    onClick={() =>
                      tx({
                        title: "Renounce the delegation",
                        details: [["Owner", <AddressLink key="o" address={d.owner} full />]],
                        warning: "This account will no longer be able to spend for this owner, unless authorized again.",
                        operation: (c: TesseraxClient, k: Keypair) => c.renounceDelegation(k, d.owner),
                      })
                    }
                  >
                    <Trash2 size={14} /> Renounce
                  </Button>
                </>
              }
            />
          ))}
        </ul>
      )}
    </>
  );
}

// Registry.

function Reputation({ record }: { record: AgentRecord }) {
  const r = record.reputation;
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-4 sm:p-5">
      <StatCard label="Rating" value={<span className={r.positive - r.negative < 0 ? "text-danger" : ""}>{r.positive - r.negative >= 0 ? "+" : ""}{r.positive - r.negative}</span>} sub={`${r.positive} good · ${r.negative} bad`} icon={<Star size={16} />} />
      <StatCard label="Received" value={`${formatTess(r.volume.planck, 2)}`} sub={`${plural(Number(r.payments), "payment")} · TESS`} icon={<Coins size={16} />} />
      <StatCard label="Payers" value={r.payers} icon={<Wallet size={16} />} />
      <StatCard label="Tasks" value={r.tasksCompleted} sub={`${r.tasksFailed} failed`} icon={<BadgeCheck size={16} />} />
    </div>
  );
}

function MyAgent() {
  const { active } = useWallet();
  const tx = useTransaction();
  const { data: record, error, isLoading } = useAgentRecord(active?.address);
  const [editing, setEditing] = useState(false);
  if (!active) return null;
  if (error) return <ErrorState error={error} />;
  if (isLoading) return <SkeletonRows rows={3} />;
  return (
    <>
      {!record ? (
        <div className="flex flex-col items-center px-6 py-12 text-center">
          <span className="flex size-14 items-center justify-center rounded-2xl bg-accent-soft text-accent">
            <Bot size={26} />
          </span>
          <h3 className="mt-4 font-semibold">{active.name} is not a registered agent</h3>
          <p className="mt-1 max-w-md text-sm text-muted">Register it to offer a service: other agents find it by capability, pay it, and rate it. A deposit is reserved, returned when it leaves the registry.</p>
          <Button className="mt-6" onClick={() => setEditing(true)}>
            <Plus size={16} /> Register as an agent
          </Button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-4 sm:px-5">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-lg font-semibold">{record.profile.name}</h3>
                <Badge tone={record.active ? "success" : "neutral"}>{record.active ? "Active" : "Paused"}</Badge>
              </div>
              {record.profile.description && <p className="mt-1 max-w-2xl text-sm text-muted">{record.profile.description}</p>}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>
                <Pencil size={14} /> Edit
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() =>
                  tx({
                    title: record.active ? "Pause the agent" : "Resume the agent",
                    details: [["Agent", record.profile.name]],
                    operation: (c: TesseraxClient, k: Keypair) => c.setAgentActive(k, record.address, !record.active),
                  })
                }
              >
                <Power size={14} /> {record.active ? "Pause" : "Resume"}
              </Button>
              <Button
                variant="secondary"
                size="sm" className="text-danger"
                onClick={() =>
                  tx({
                    title: "Leave the registry",
                    details: [["Agent", record.profile.name]],
                    warning: "The profile and the reputation are deleted. The deposit returns to the account.",
                    operation: (c: TesseraxClient, k: Keypair) => deregisterAgent(c, k, record.address),
                  })
                }
              >
                <Trash2 size={14} /> Deregister
              </Button>
            </div>
          </div>
          <Reputation record={record} />
          <Fields>
            <Field label="Capabilities">
              {record.profile.capabilities.length ? (
                <span className="flex flex-wrap gap-1.5">
                  {record.profile.capabilities.map((c) => (
                    <Badge key={c}>{c}</Badge>
                  ))}
                </span>
              ) : (
                "—"
              )}
            </Field>
            <Field label="Endpoint">{record.profile.endpoint ? <span className="font-mono text-xs">{record.profile.endpoint}</span> : "—"}</Field>
            <Field label="Owner">
              {record.owner ? (
                <span className="flex flex-wrap items-center gap-2">
                  <AddressLink address={record.owner} />
                  <Badge tone={record.ownerConfirmed ? "success" : "warning"}>{record.ownerConfirmed ? "Confirmed" : "Waiting for confirmation"}</Badge>
                </span>
              ) : (
                "None"
              )}
            </Field>
            <Field label="Registered">
              <ExplorerLink path={`/block/${record.registeredAt}`}>Block #{record.registeredAt.toLocaleString("en-US")}</ExplorerLink>
            </Field>
          </Fields>
        </>
      )}
      <OwnedAgents />
      {editing && <ProfileSheet record={record ?? undefined} onClose={() => setEditing(false)} />}
    </>
  );
}

/** Agents that name the active account as their owner. */
function OwnedAgents() {
  const { active } = useWallet();
  const { client, url } = useChain();
  const tx = useTransaction();
  const { data } = useQuery({
    queryKey: ["owned-agents", url, active?.address],
    queryFn: async () => (await client.findAgents(undefined, false)).filter((a) => a.owner === active?.address),
    enabled: Boolean(active),
    refetchInterval: 30_000,
  });
  if (!data?.length) return null;
  return (
    <div className="border-t border-line">
      <CardHeader title="Agents you own" icon={<UserCheck size={16} />} />
      <ul className="divide-y divide-line">
        {data.map((a) => (
          <li key={a.address} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5 sm:px-5">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-sm font-medium">
                {a.profile.name}
                <Badge tone={a.active ? "success" : "neutral"}>{a.active ? "Active" : "Paused"}</Badge>
              </div>
              <AddressLink address={a.address} className="text-xs" />
            </div>
            <div className="flex flex-wrap gap-2">
              {!a.ownerConfirmed && (
                <Button
                  size="sm"
                  onClick={() =>
                    tx({
                      title: "Confirm ownership",
                      details: [["Agent", <AddressLink key="a" address={a.address} label={a.profile.name} />]],
                      warning: "Its reputation then shows you as its owner, and you can pause or deregister it.",
                      operation: (c: TesseraxClient, k: Keypair) => c.confirmOwner(k, a.address),
                    })
                  }
                >
                  <BadgeCheck size={14} /> Confirm
                </Button>
              )}
              {a.ownerConfirmed && (
                <>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() =>
                      tx({
                        title: a.active ? "Pause the agent" : "Resume the agent",
                        details: [["Agent", a.profile.name]],
                        operation: (c: TesseraxClient, k: Keypair) => c.setAgentActive(k, a.address, !a.active),
                      })
                    }
                  >
                    <Power size={14} /> {a.active ? "Pause" : "Resume"}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm" className="text-danger"
                    onClick={() =>
                      tx({
                        title: "Deregister the agent",
                        details: [["Agent", a.profile.name]],
                        warning: "Its profile and reputation are deleted; its deposit returns to the agent.",
                        operation: (c: TesseraxClient, k: Keypair) => deregisterAgent(c, k, a.address),
                      })
                    }
                  >
                    <Trash2 size={14} /> Deregister
                  </Button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

const byteLength = (text: string) => new TextEncoder().encode(text).length;

function ProfileSheet({ record, onClose }: { record?: AgentRecord; onClose: () => void }) {
  const tx = useTransaction();
  const { active } = useWallet();
  const [name, setName] = useState(record?.profile.name ?? "");
  const [description, setDescription] = useState(record?.profile.description ?? "");
  const [endpoint, setEndpoint] = useState(record?.profile.endpoint ?? "");
  const [capabilities, setCapabilities] = useState(record?.profile.capabilities.join(", ") ?? "");
  const [owner, setOwnerText] = useState(record?.owner ?? "");
  const [submitted, setSubmitted] = useState(false);
  const caps = capabilities
    .split(/[\s,]+/)
    .map((c) => c.trim().toLowerCase())
    .filter(Boolean);
  const ownerAddress = owner ? normalizeAddress(owner) : undefined;
  const errors = {
    name: !name.trim() ? "Enter a name" : byteLength(name) > 64 ? "At most 64 bytes" : null,
    description: byteLength(description) > 512 ? "At most 512 bytes" : null,
    endpoint: byteLength(endpoint) > 256 ? "At most 256 bytes" : endpoint && !/^(https?|wss?|mcp):\/\//.test(endpoint) ? "A URL such as https://…" : null,
    capabilities: caps.length > 16 ? "At most 16 capabilities" : caps.find((c) => byteLength(c) > 32 || !/^[a-z0-9][a-z0-9-]*$/.test(c)) ? "Lowercase words such as translation, image-generation" : null,
    owner: owner && !ownerAddress ? "Not a Tesserax address" : ownerAddress === active?.address ? "An agent cannot own itself" : null,
  };
  const ownerChanged = (ownerAddress ?? undefined) !== (record?.owner ?? undefined);
  const submit = () => {
    setSubmitted(true);
    if (Object.values(errors).some(Boolean)) return;
    const profile: Profile = { name: name.trim(), description: description.trim(), endpoint: endpoint.trim(), capabilities: [...new Set(caps)] };
    tx({
      title: record ? "Update the agent" : "Register as an agent",
      details: [
        ["Name", profile.name],
        ["Capabilities", profile.capabilities!.join(", ") || "—"],
        ...(ownerAddress ? ([["Owner", <AddressLink key="o" address={ownerAddress} />]] as Array<[string, ReactNode]>) : []),
      ],
      warning: record ? undefined : "A deposit proportional to the size of the profile is reserved, returned when the agent leaves the registry.",
      operation: async (c: TesseraxClient, k: Keypair) => {
        if (!record) return c.registerAgent(k, profile, ownerAddress ?? undefined);
        // The owner is changed by its own call, after the profile.
        if (!ownerChanged) return c.updateProfile(k, profile);
        const unchanged = JSON.stringify(profile) === JSON.stringify({ name: record.profile.name, description: record.profile.description, endpoint: record.profile.endpoint, capabilities: record.profile.capabilities });
        if (!unchanged) await c.updateProfile(k, profile);
        return setOwner(c, k, ownerAddress ?? undefined);
      },
      onDone: onClose,
    });
  };
  return (
    <Sheet title={record ? "Edit the agent" : "Register as an agent"} icon={<Bot size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Translator" error={submitted ? errors.name : null} autoFocus />
        <TextArea label="Description" hint="optional" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="What the agent does, its prices" rows={3} error={submitted ? errors.description : null} />
        <TextInput label="Endpoint" hint="optional" value={endpoint} onChange={(e) => setEndpoint(e.target.value.trim())} placeholder="https://agent.example.com/mcp" mono spellCheck={false} error={submitted ? errors.endpoint : null} />
        <TextInput label="Capabilities" hint="comma separated" value={capabilities} onChange={(e) => setCapabilities(e.target.value)} placeholder="translation, summarization" spellCheck={false} error={submitted ? errors.capabilities : null} />
        <AddressInput label="Owner (optional): the account that runs this agent" value={owner} onChange={setOwnerText} error={submitted ? errors.owner : null} exclude={active?.address} placeholder="None" />
        {ownerAddress && ownerChanged && <p className="-mt-2 text-xs text-muted">The owner confirms from its own wallet, in AI agents › My agent.</p>}
        <Button className="w-full" onClick={submit}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

// Discovery.

function Discover() {
  const { client, url } = useChain();
  const { active } = useWallet();
  const tx = useTransaction();
  const [query, setQuery] = useState("");
  const [capability, setCapability] = useState("");
  const [paying, setPaying] = useState<AgentRecord | null>(null);
  const { data, error, isLoading } = useQuery({
    queryKey: ["agents", url, capability],
    queryFn: () => client.findAgents(capability || undefined),
    refetchInterval: 60_000,
  });
  const rate = (a: AgentRecord, positive: boolean) =>
    tx({
      title: positive ? "Rate as good" : "Rate as bad",
      details: [["Agent", <AddressLink key="a" address={a.address} label={a.profile.name} />]],
      warning: "Each payment to an agent allows one rating.",
      operation: (c: TesseraxClient, k: Keypair) => c.rateAgent(k, a.address, positive),
    });
  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setCapability(query.trim().toLowerCase());
        }}
        className="flex gap-2 border-b border-line px-4 py-4 sm:px-5"
      >
        <div className="relative flex-1">
          <Search size={16} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-faint" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Capability, such as translation" spellCheck={false} className="h-11 w-full rounded-xl border border-line bg-surface pl-10 pr-3 text-[15px] outline-none focus:border-accent focus:ring-4 focus:ring-accent-soft" />
        </div>
        <Button type="submit">Search</Button>
      </form>
      {error ? (
        <ErrorState error={error} />
      ) : isLoading ? (
        <SkeletonRows rows={4} />
      ) : !data?.length ? (
        <EmptyState title={capability ? `No active agent offers “${capability}”` : "No active agent yet"}>Agents register from this page, in My agent, or with the SDKs.</EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {data.map((a) => {
            const score = a.reputation.positive - a.reputation.negative;
            const own = a.address === active?.address;
            return (
              <li key={a.address} className="px-4 py-4 sm:px-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">{a.profile.name}</span>
                      <Badge tone={score > 0 ? "success" : score < 0 ? "danger" : "neutral"}>
                        <Star size={11} /> {score >= 0 ? "+" : ""}
                        {score}
                      </Badge>
                      {a.ownerConfirmed && <Badge tone="accent">Owned</Badge>}
                    </div>
                    <AddressLink address={a.address} className="text-xs" />
                    {a.profile.description && <p className="mt-1.5 line-clamp-2 text-sm text-muted">{a.profile.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {a.profile.capabilities.map((c) => (
                        <button key={c} onClick={() => { setQuery(c); setCapability(c); }} className="rounded-full border border-line px-2 py-0.5 text-xs text-muted hover:text-fg">
                          {c}
                        </button>
                      ))}
                    </div>
                    <div className="mt-2 text-xs text-muted">
                      {plural(Number(a.reputation.payments), "payment")} · {formatTess(a.reputation.volume.planck, 2)} TESS · {plural(a.reputation.payers, "payer")} · {plural(a.reputation.tasksCompleted, "task")} done
                    </div>
                  </div>
                  {!own && (
                    <div className="flex gap-2">
                      <Button size="sm" onClick={() => setPaying(a)}>
                        <Coins size={14} /> Pay
                      </Button>
                      <Button variant="secondary" size="sm" className="px-2.5" aria-label="Rate as good" title="Rate as good" onClick={() => rate(a, true)}>
                        <ThumbsUp size={15} />
                      </Button>
                      <Button variant="secondary" size="sm" className="px-2.5" aria-label="Rate as bad" title="Rate as bad" onClick={() => rate(a, false)}>
                        <ThumbsDown size={15} />
                      </Button>
                    </div>
                  )}
                </div>
                {a.profile.endpoint && <div className="mt-2 truncate font-mono text-xs text-faint">{a.profile.endpoint}</div>}
              </li>
            );
          })}
        </ul>
      )}
      {paying && <PaySheet agent={paying} onClose={() => setPaying(null)} />}
    </>
  );
}

function PaySheet({ agent, onClose }: { agent: AgentRecord; onClose: () => void }) {
  const tx = useTransaction();
  const { active } = useWallet();
  const { client, url } = useChain();
  const [from, setFrom] = useState("");
  const [amount, setAmount] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const balance = useQuery({ queryKey: ["balance", url, active?.address], queryFn: () => client.balance(active!.address), enabled: Boolean(active) });
  const received = useReceivedDelegations(active?.address);
  const available: Amount | undefined = from ? received.data?.find((d) => d.owner === from)?.remaining : balance.data?.transferable;
  const parsed = parseAmount(amount, { max: available?.planck });
  const error = !amount ? "Enter an amount" : parsed.error;
  return (
    <Sheet title={`Pay ${agent.profile.name}`} icon={<Coins size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <p className="text-sm text-muted">The payment counts in the reputation of the agent, and allows one rating.</p>
        <PayWith value={from} onChange={setFrom} />
        <AmountInput label="Amount" value={amount} onChange={setAmount} max={available} error={submitted ? error : null} />
        <Button
          className="w-full"
          onClick={() => {
            setSubmitted(true);
            if (error || !parsed.amount) return;
            const value = parsed.amount;
            tx({
              title: "Pay an agent",
              summary: (
                <>
                  {formatTess(value.planck, 12)} <span className="text-xl text-muted">TESS</span>
                </>
              ),
              details: [
                ["Agent", <AddressLink key="a" address={agent.address} label={agent.profile.name} />],
                ...(from ? ([["Paid by", <AddressLink key="o" address={from} />]] as Array<[string, ReactNode]>) : []),
              ],
              operation: (c: TesseraxClient, k: Keypair) => (from ? c.agentPayAgent(k, from, agent.address, value) : c.payAgent(k, agent.address, value)),
              onDone: onClose,
            });
          }}
        >
          Review
        </Button>
      </div>
    </Sheet>
  );
}
