import { Amount, Tasks as TaskCalls, type Keypair, type TaskInfo, type TesseraxClient } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Ban, Check, CircleDot, Clock, Gavel, Hand, ListTodo, Plus, Scale, Send, ShieldAlert, Users } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AddressInput, AmountInput, Button, parseAmount, TextArea, TextInput } from "../components/forms";
import { Page } from "../components/Layout";
import { AddressLink } from "../components/links";
import { PayWith } from "../components/PayWith";
import { Sheet } from "../components/Sheet";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, cx, EmptyState, ErrorState, Field, Fields, PageHeader, SkeletonRows, Tabs } from "../components/ui";
import { BLOCKS_PER_HOUR, normalizeAddress, useBalance, useBestBlock, useChain, useReceivedDelegations } from "../lib/chain";
import { blocksDuration, formatTess, plural } from "../lib/format";
import { useWallet } from "../lib/session";

const useAllTasks = () => {
  const { tasks, url } = useChain();
  return useQuery({ queryKey: ["tasks", url], queryFn: () => tasks.all(), refetchInterval: 20_000 });
};

/** Accounts the active account acts as: itself, and the owners whose budget it holds. */
const useIdentities = () => {
  const { active } = useWallet();
  const received = useReceivedDelegations(active?.address);
  return [active?.address, ...(received.data?.map((d) => d.owner) ?? [])].filter((a): a is string => Boolean(a));
};

const worker = (t: TaskInfo) => (t.status.state === "open" ? undefined : t.status.worker);

const stateBadge: Record<TaskInfo["status"]["state"], { tone: "accent" | "warning" | "success" | "danger"; label: string }> = {
  open: { tone: "accent", label: "Open" },
  assigned: { tone: "warning", label: "In progress" },
  delivered: { tone: "success", label: "Delivered" },
  disputed: { tone: "danger", label: "Disputed" },
};

type Tab = "market" | "mine";

export function Tasks() {
  const [params, setParams] = useSearchParams();
  const tab: Tab = params.get("tab") === "mine" ? "mine" : "market";
  const capability = params.get("capability") ?? "";
  const [query, setQuery] = useState(capability);
  const [creating, setCreating] = useState(false);
  const { data, error, isLoading } = useAllTasks();
  const identities = useIdentities();
  const mine = data?.filter((t) => [t.client, worker(t), t.arbiter?.address, t.invited].some((a) => a && identities.includes(a))) ?? [];
  const market = data?.filter((t) => t.status.state === "open" && (!capability || t.capability === capability)).sort((a, b) => (b.reward.planck > a.reward.planck ? 1 : -1)) ?? [];
  const list = tab === "mine" ? mine : market;
  return (
    <Page>
      <PageHeader title="Task market" icon={<Users size={20} />} subtitle="Order work from agents with the reward in escrow, or take tasks and get paid on approval.">
        <Button onClick={() => setCreating(true)}>
          <Plus size={16} /> Create a task
        </Button>
      </PageHeader>
      <Card>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pr-4">
          <Tabs<Tab>
            value={tab}
            onChange={(id) => setParams(id === "market" ? {} : { tab: id }, { replace: true })}
            tabs={[
              { id: "market", label: "Open tasks", count: data ? market.length : undefined },
              { id: "mine", label: "My tasks", count: data ? mine.length : undefined },
            ]}
          />
          {tab === "market" && (
            <form
              className="ml-4 py-2 sm:ml-0"
              onSubmit={(e) => {
                e.preventDefault();
                const c = query.trim().toLowerCase();
                setParams(c ? { capability: c } : {}, { replace: true });
              }}
            >
              <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter by capability" spellCheck={false} className="h-9 w-48 rounded-lg border border-line bg-surface px-3 text-sm outline-none focus:border-accent" />
            </form>
          )}
        </div>
        {error ? (
          <ErrorState error={error} />
        ) : isLoading ? (
          <SkeletonRows rows={4} />
        ) : !list.length ? (
          <EmptyState title={tab === "mine" ? "No task in progress" : capability ? `No open task for “${capability}”` : "No open task"}>
            {tab === "mine" ? "Tasks you created, took, or arbitrate appear here until they end." : "Create one: workers see it here and in their SDKs."}
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {list.map((t) => (
              <TaskRow key={t.id.toString()} task={t} identities={identities} />
            ))}
          </ul>
        )}
      </Card>
      {creating && <CreateSheet onClose={() => setCreating(false)} />}
    </Page>
  );
}

/** The role of the account in a task, its own before those it holds for owners. */
function roleOf(t: TaskInfo, identities: string[]): string | null {
  const roles = (account: string) => {
    if (t.client === account) return "Client";
    if (worker(t) === account) return "Worker";
    if (t.arbiter?.address === account) return "Arbiter";
    if (t.invited === account) return "Invited";
    return null;
  };
  const [me, ...owners] = identities;
  const own = me ? roles(me) : null;
  if (own) return own;
  for (const owner of owners) {
    const role = roles(owner);
    if (role) return `${role}, for an owner`;
  }
  return null;
}

function TaskRow({ task: t, identities }: { task: TaskInfo; identities: string[] }) {
  const role = roleOf(t, identities);
  const badge = stateBadge[t.status.state];
  return (
    <li>
      <Link to={`/tasks/${t.id}`} className="flex items-center gap-4 px-4 py-4 hover:bg-surface-2 sm:px-5">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-sm font-semibold text-muted tabular">#{t.id.toString()}</span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-medium">{t.spec}</div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {t.capability && <Badge>{t.capability}</Badge>}
            {role && <Badge tone="accent">{role}</Badge>}
            {t.invited && !role && <Badge tone="warning">Invite only</Badge>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-sm font-semibold tabular">{formatTess(t.reward.planck, 4)} TESS</div>
          <div className="text-xs text-muted">{blocksDuration(t.deliveryBlocks)} to deliver</div>
        </div>
      </Link>
    </li>
  );
}

const hoursOk = (v: string) => /^\d+$/.test(v) && Number(v) >= 1 && Number(v) <= 8760;

function CreateSheet({ onClose }: { onClose: () => void }) {
  const { active } = useWallet();
  const tx = useTransaction();
  const navigate = useNavigate();
  const balance = useBalance(active?.address);
  const received = useReceivedDelegations(active?.address);
  const [from, setFrom] = useState("");
  const [spec, setSpec] = useState("");
  const [capability, setCapability] = useState("");
  const [reward, setReward] = useState("");
  const [invited, setInvited] = useState("");
  const [arbiter, setArbiter] = useState("");
  const [fee, setFee] = useState("");
  const [bond, setBond] = useState("");
  const [delivery, setDelivery] = useState("24");
  const [review, setReview] = useState("24");
  const [advanced, setAdvanced] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const available = from ? received.data?.find((d) => d.owner === from)?.remaining : balance.data?.transferable;
  const rewardAmount = parseAmount(reward, { max: available?.planck });
  const feeAmount = parseAmount(fee);
  const bondAmount = parseAmount(bond);
  const invitedAddress = invited ? normalizeAddress(invited) : null;
  const arbiterAddress = arbiter ? normalizeAddress(arbiter) : null;
  const clientAddress = from || active?.address;
  const errors = {
    spec: !spec.trim() ? "Describe the work, or give a URI to its description" : new TextEncoder().encode(spec).length > 256 ? "At most 256 bytes: link to a longer description" : null,
    capability: capability && !/^[a-z0-9][a-z0-9-]{0,31}$/.test(capability) ? "A lowercase word such as translation" : null,
    reward: !reward ? "Enter a reward" : rewardAmount.error,
    invited: invited && !invitedAddress ? "Not a Tesserax address" : invitedAddress === clientAddress ? "The client cannot work on its own task" : null,
    arbiter: arbiter && !arbiterAddress ? "Not a Tesserax address" : arbiterAddress === clientAddress ? "The client cannot arbitrate its own task" : null,
    fee: arbiter && !fee ? "Enter the fee of the arbiter, 0 for none" : fee && fee !== "0" ? feeAmount.error : null,
    bond: bond && bond !== "0" ? bondAmount.error : null,
    delivery: hoursOk(delivery) ? null : "From 1 hour to a year",
    review: hoursOk(review) ? null : "From 1 hour to a year",
  };
  const invalid = Object.values(errors).some(Boolean);
  const submit = () => {
    setSubmitted(true);
    if (invalid) {
      if (errors.invited || errors.arbiter || errors.fee || errors.bond || errors.delivery || errors.review) setAdvanced(true);
      return;
    }
    const task = {
      spec: spec.trim(),
      capability: capability || undefined,
      reward: rewardAmount.amount!,
      invited: invitedAddress ?? undefined,
      arbiter: arbiterAddress ? { address: arbiterAddress, fee: fee && fee !== "0" ? feeAmount.amount! : new Amount(0n) } : undefined,
      bond: bond && bond !== "0" ? bondAmount.amount : undefined,
      deliveryBlocks: Number(delivery) * BLOCKS_PER_HOUR,
      reviewBlocks: Number(review) * BLOCKS_PER_HOUR,
    };
    tx({
      title: "Create a task",
      summary: (
        <>
          {formatTess(task.reward.planck, 12)} <span className="text-xl text-muted">TESS</span>
        </>
      ),
      details: [
        ["Work", <span key="s" className="line-clamp-3">{task.spec}</span>],
        ["Delivery", `${plural(Number(delivery), "hour")} after accepting`],
        ["Review", plural(Number(review), "hour")],
        ...(task.arbiter ? ([["Arbiter", <AddressLink key="a" address={task.arbiter.address} />]] as Array<[string, ReactNode]>) : []),
        ...(task.bond ? ([["Worker bond", `${formatTess(task.bond.planck, 6)} TESS`]] as Array<[string, ReactNode]>) : []),
        ...(from ? ([["Paid by", <AddressLink key="o" address={from} />]] as Array<[string, ReactNode]>) : []),
      ],
      warning: task.arbiter
        ? "The reward and the arbiter fee are held in escrow until the task ends."
        : "The reward is held in escrow. Without an arbiter, the result is paid when you approve it, or automatically at the end of the review period.",
      operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).create(k, from || undefined, task),
      onDone: (id) => {
        onClose();
        navigate(`/tasks/${id as bigint}`);
      },
    });
  };
  return (
    <Sheet title="Create a task" icon={<ListTodo size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <PayWith value={from} onChange={setFrom} />
        <TextArea label="Work" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder="Translate https://example.com/doc.md into French" rows={3} error={submitted ? errors.spec : null} autoFocus />
        <div className="grid gap-4 sm:grid-cols-2">
          <AmountInput label="Reward" value={reward} onChange={setReward} max={available} error={submitted ? errors.reward : null} />
          <TextInput label="Capability" hint="optional" value={capability} onChange={(e) => setCapability(e.target.value.trim().toLowerCase())} placeholder="translation" spellCheck={false} error={submitted ? errors.capability : null} />
        </div>
        <button type="button" onClick={() => setAdvanced(!advanced)} className="text-sm font-medium text-accent">
          {advanced ? "Hide" : "Show"} the options: worker, arbiter, bond, periods
        </button>
        {advanced && (
          <div className="space-y-5 rounded-2xl border border-line p-4">
            <AddressInput label="Invite one worker (optional)" value={invited} onChange={setInvited} error={submitted ? errors.invited : null} exclude={active?.address} placeholder="Anyone can accept" />
            <AddressInput label="Arbiter of disputes (optional)" value={arbiter} onChange={setArbiter} error={submitted ? errors.arbiter : null} exclude={active?.address} placeholder="No arbiter" />
            {arbiter && <AmountInput label="Fee of the arbiter" value={fee} onChange={setFee} error={submitted ? errors.fee : null} />}
            <AmountInput label="Bond of the worker (optional)" hint="lost if it does not deliver" value={bond} onChange={setBond} error={submitted ? errors.bond : null} />
            <div className="grid grid-cols-2 gap-4">
              <TextInput label="Delivery" hint="hours" value={delivery} onChange={(e) => setDelivery(e.target.value.replace(/\D/g, ""))} inputMode="numeric" error={submitted ? errors.delivery : null} />
              <TextInput label="Review" hint="hours" value={review} onChange={(e) => setReview(e.target.value.replace(/\D/g, ""))} inputMode="numeric" error={submitted ? errors.review : null} />
            </div>
          </div>
        )}
        <Button className="w-full" onClick={submit}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

// Detail.

function Timeline({ task: t }: { task: TaskInfo }) {
  const steps = ["Open", "Accepted", "Delivered", "Paid"];
  const index = { open: 0, assigned: 1, delivered: 2, disputed: 2 }[t.status.state];
  return (
    <ol className="flex items-center gap-2 px-4 py-4 sm:px-5">
      {steps.map((s, i) => (
        <li key={s} className={cx("flex min-w-0 items-center gap-2", i < steps.length - 1 && "flex-1")}>
          <span className={i <= index ? "flex size-6 shrink-0 items-center justify-center rounded-full bg-accent text-white" : "flex size-6 shrink-0 items-center justify-center rounded-full border border-line text-faint"}>
            {i < index ? <Check size={13} /> : <CircleDot size={13} />}
          </span>
          {/* On phones, only the current step is named. */}
          <span className={cx("truncate text-xs", i <= index ? "font-medium" : "text-muted", i !== index && "hidden sm:inline")}>{i === 2 && t.status.state === "disputed" ? "Disputed" : s}</span>
          {i < steps.length - 1 && <span className={i < index ? "h-px flex-1 bg-accent" : "h-px flex-1 bg-line"} />}
        </li>
      ))}
    </ol>
  );
}

export function TaskDetail() {
  const { id } = useParams();
  const { tasks, url } = useChain();
  const taskId = /^\d+$/.test(id ?? "") ? BigInt(id!) : null;
  const { data: task, error, isLoading } = useQuery({
    queryKey: ["task", url, id],
    queryFn: async () => (await tasks.task(taskId!)) ?? null,
    enabled: taskId !== null,
    refetchInterval: 12_000,
  });
  return (
    <Page>
      <Link to="/tasks" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-muted hover:text-fg">
        <ArrowLeft size={16} /> Task market
      </Link>
      {taskId === null ? (
        <Card>
          <EmptyState title="Not a task number" />
        </Card>
      ) : error ? (
        <Card>
          <ErrorState error={error} />
        </Card>
      ) : isLoading ? (
        <Card>
          <SkeletonRows rows={4} />
        </Card>
      ) : !task ? (
        <Card>
          <EmptyState title={`Task #${id} is not in progress`}>It was never created, or it ended: its outcome is in the explorer.</EmptyState>
        </Card>
      ) : (
        <TaskView task={task} />
      )}
    </Page>
  );
}

function TaskView({ task: t }: { task: TaskInfo }) {
  const tx = useTransaction();
  const best = useBestBlock();
  const identities = useIdentities();
  const { active } = useWallet();
  const [sheet, setSheet] = useState<"deliver" | "resolve" | null>(null);
  const now = best.data;
  const s = t.status;
  const badge = stateBadge[s.state];
  // The account itself first; an owner when the active account acts through its delegation.
  const me = active?.address;
  // An owner the account acts for through its delegation, or undefined for the account itself.
  const actAs = (account: string | undefined) => (account && account !== me && identities.includes(account) ? account : undefined);
  const isClient = identities.includes(t.client);
  const w = worker(t);
  const isWorker = Boolean(w && identities.includes(w));
  const isArbiter = t.arbiter?.address === active?.address;
  // The account accepts as itself, or as the invited owner; never on its own task.
  const canAccept = s.state === "open" && t.client !== me && (!t.invited || identities.includes(t.invited)) && t.invited !== t.client;
  const acceptAs = t.invited ? actAs(t.invited) : undefined;
  const details: Array<[string, ReactNode]> = [["Task", `#${t.id}`]];

  const until = (block: number) => (now === undefined ? `block ${block}` : block > now ? `in ${blocksDuration(block - now)}` : "now");
  const finalizable = now !== undefined && ((s.state === "assigned" && now > s.deadline) || (s.state === "delivered" && now >= s.reviewUntil) || (s.state === "disputed" && now >= s.until));

  const actions: ReactNode[] = [];
  if (canAccept)
    actions.push(
      <Button
        key="accept"
        onClick={() =>
          tx({
            title: "Accept the task",
            details: [...details, ["Deliver within", blocksDuration(t.deliveryBlocks)], ["Your bond", `${formatTess(t.bond.planck, 6)} TESS`]],
            warning: t.bond.planck > 0n ? "The bond is held until you deliver, and lost if you do not deliver in time." : "Deliver in time: otherwise the task ends without payment.",
            operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).accept(k, acceptAs, t.id),
          })
        }
      >
        <Hand size={16} /> Accept
      </Button>,
    );
  if (s.state === "open" && isClient)
    actions.push(
      <Button
        key="cancel"
        variant="secondary"
        className="text-danger"
        onClick={() =>
          tx({
            title: "Cancel the task",
            details,
            warning: "The reward returns to the client.",
            operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).cancel(k, actAs(t.client), t.id),
          })
        }
      >
        <Ban size={16} /> Cancel{actAs(t.client) ? " for the owner" : ""}
      </Button>,
    );
  if (s.state === "assigned" && isWorker && !finalizable)
    actions.push(
      <Button key="deliver" onClick={() => setSheet("deliver")}>
        <Send size={16} /> Deliver
      </Button>,
    );
  if (s.state === "delivered" && isClient && !finalizable) {
    actions.push(
      <Button
        key="approve"
        onClick={() =>
          tx({
            title: "Approve the result",
            summary: (
              <>
                {formatTess(t.reward.planck, 12)} <span className="text-xl text-muted">TESS</span>
              </>
            ),
            details: [...details, ["Paid to", <AddressLink key="w" address={w} />]],
            warning: "The worker is paid the reward, and its reputation counts the task.",
            operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).approve(k, actAs(t.client), t.id),
          })
        }
      >
        <Check size={16} /> Approve and pay
      </Button>,
    );
    if (t.arbiter)
      actions.push(
        <Button
          key="dispute"
          variant="secondary"
          className="text-danger"
          onClick={() =>
            tx({
              title: "Dispute the result",
              details: [...details, ["Arbiter", <AddressLink key="a" address={t.arbiter!.address} />]],
              warning: "The arbiter decides the share of the reward paid to the worker. Without a decision in time, the worker is paid in full.",
              operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).dispute(k, actAs(t.client), t.id),
            })
          }
        >
          <ShieldAlert size={16} /> Dispute
        </Button>,
      );
  }
  if (s.state === "disputed" && isArbiter && !finalizable)
    actions.push(
      <Button key="resolve" onClick={() => setSheet("resolve")}>
        <Gavel size={16} /> Resolve
      </Button>,
    );
  if (finalizable)
    actions.push(
      <Button
        key="finalize"
        onClick={() =>
          tx({
            title: "Finalize the task",
            details,
            warning:
              s.state === "assigned"
                ? "The worker did not deliver in time: the reward returns to the client and the bond is lost."
                : "The review time is over: the worker is paid in full.",
            operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).finalize(k, t.id),
          })
        }
      >
        <Clock size={16} /> Finalize
      </Button>,
    );

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <Card>
        <div className="border-b border-line px-4 py-5 sm:px-5">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">Task #{t.id.toString()}</h1>
            <Badge tone={badge.tone}>{badge.label}</Badge>
            {t.capability && <Badge>{t.capability}</Badge>}
          </div>
          <p className="mt-3 whitespace-pre-wrap break-words text-[15px]">{t.spec}</p>
        </div>
        <Timeline task={t} />
        <Fields>
          <Field label="Client">
            <AddressLink address={t.client} copy />
          </Field>
          {w && (
            <Field label="Worker">
              <AddressLink address={w} copy />
            </Field>
          )}
          {t.invited && (
            <Field label="Invited worker">
              <AddressLink address={t.invited} />
            </Field>
          )}
          {(s.state === "delivered" || s.state === "disputed") && (
            <Field label="Result">
              <span className="whitespace-pre-wrap break-words font-medium">{s.result}</span>
            </Field>
          )}
          {s.state === "assigned" && <Field label="Deadline">{until(s.deadline)}</Field>}
          {s.state === "delivered" && <Field label="Review until">{until(s.reviewUntil)}</Field>}
          {s.state === "disputed" && <Field label="Arbiter decides until">{until(s.until)}</Field>}
          <Field label="Arbiter">
            {t.arbiter ? (
              <span className="flex flex-wrap items-center gap-2">
                <AddressLink address={t.arbiter.address} /> <span className="text-muted">fee {formatTess(t.arbiter.fee.planck, 6)} TESS</span>
              </span>
            ) : (
              "None: approved by the client, or automatically after the review"
            )}
          </Field>
          <Field label="Periods">
            {blocksDuration(t.deliveryBlocks)} to deliver · {blocksDuration(t.reviewBlocks)} to review
          </Field>
        </Fields>
      </Card>
      <div className="space-y-4">
        <Card className="p-5">
          <div className="text-sm text-muted">Reward in escrow</div>
          <div className="mt-1 text-3xl font-semibold tracking-tight tabular">
            {formatTess(t.reward.planck, 4)} <span className="text-base text-muted">TESS</span>
          </div>
          {t.bond.planck > 0n && <div className="mt-2 text-sm text-muted">Worker bond {formatTess(t.bond.planck, 4)} TESS</div>}
          {actions.length > 0 ? (
            <div className="mt-5 grid gap-2">{actions}</div>
          ) : (
            <p className="mt-5 rounded-xl bg-surface-2 px-3 py-2.5 text-sm text-muted">
              {s.state === "open" && t.invited && !canAccept && !isClient ? "Only the invited worker can accept this task." : "Nothing to do for this account now."}
            </p>
          )}
        </Card>
        <Card>
          <CardHeader title="How it ends" icon={<Scale size={16} />} />
          <ul className="space-y-2 p-4 text-xs leading-relaxed text-muted sm:p-5">
            <li>The client approves the result: the worker is paid.</li>
            <li>No answer before the end of the review: the worker is paid.</li>
            {t.arbiter && <li>A dispute: the arbiter splits the reward.</li>}
            <li>No delivery in time: the client gets the reward back{t.bond.planck > 0n ? " and the bond" : ""}.</li>
          </ul>
        </Card>
      </div>
      {sheet === "deliver" && <DeliverSheet task={t} actAs={actAs(w)} onClose={() => setSheet(null)} />}
      {sheet === "resolve" && <ResolveSheet task={t} onClose={() => setSheet(null)} />}
    </div>
  );
}

function DeliverSheet({ task, actAs, onClose }: { task: TaskInfo; actAs?: string; onClose: () => void }) {
  const tx = useTransaction();
  const [result, setResult] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const error = !result.trim() ? "Enter the result, or a URI to it" : new TextEncoder().encode(result).length > 256 ? "At most 256 bytes: link to a longer result" : null;
  return (
    <Sheet title={`Deliver task #${task.id}`} icon={<Send size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <TextArea label="Result" value={result} onChange={(e) => setResult(e.target.value)} placeholder="https://example.com/result.md" rows={4} error={submitted ? error : null} autoFocus />
        <Button
          className="w-full"
          onClick={() => {
            setSubmitted(true);
            if (error) return;
            tx({
              title: "Deliver the result",
              details: [
                ["Task", `#${task.id}`],
                ["Result", <span key="r" className="line-clamp-3">{result.trim()}</span>],
              ],
              warning: `The client then has ${blocksDuration(task.reviewBlocks)} to approve${task.arbiter ? " or dispute" : ""}; without an answer, you are paid.`,
              operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).deliver(k, actAs, task.id, result.trim()),
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

function ResolveSheet({ task, onClose }: { task: TaskInfo; onClose: () => void }) {
  const tx = useTransaction();
  const [share, setShare] = useState(50);
  const toWorker = (task.reward.planck * BigInt(share)) / 100n;
  return (
    <Sheet title={`Resolve task #${task.id}`} icon={<Gavel size={18} />} onClose={onClose}>
      <div className="space-y-5">
        {task.status.state === "disputed" && (
          <div className="rounded-xl bg-surface-2 p-3 text-sm">
            <div className="text-xs text-muted">Result delivered</div>
            <div className="mt-1 whitespace-pre-wrap break-words">{task.status.result}</div>
          </div>
        )}
        <div>
          <div className="mb-2 flex items-baseline justify-between text-sm">
            <span className="font-medium">Share paid to the worker</span>
            <span className="text-lg font-semibold tabular">{share}%</span>
          </div>
          <input type="range" min={0} max={100} step={5} value={share} onChange={(e) => setShare(Number(e.target.value))} className="w-full accent-[var(--accent)]" aria-label="Share paid to the worker" />
          <div className="mt-2 flex justify-between text-xs text-muted">
            <span>Worker {formatTess(toWorker, 4)} TESS</span>
            <span>Client {formatTess(task.reward.planck - toWorker, 4)} TESS</span>
          </div>
        </div>
        <Button
          className="w-full"
          onClick={() =>
            tx({
              title: "Resolve the dispute",
              details: [
                ["Task", `#${task.id}`],
                ["To the worker", `${share}% · ${formatTess(toWorker, 6)} TESS`],
                ["To the client", `${formatTess(task.reward.planck - toWorker, 6)} TESS`],
                ["Your fee", `${formatTess(task.arbiter?.fee.planck ?? 0n, 6)} TESS`],
              ],
              operation: (c: TesseraxClient, k: Keypair) => new TaskCalls(c).resolve(k, task.id, share),
              onDone: onClose,
            })
          }
        >
          Review
        </Button>
      </div>
    </Sheet>
  );
}
