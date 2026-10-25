import { Amount, type Contract, type ContractEvent, type ContractTxOutcome, type Keypair, type TesseraxClient } from "@tesserax/sdk";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileCode2, FileUp, PenLine, Plus, Radio, RefreshCw, Rocket, Trash2 } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { AmountInput, Button, ErrorText, parseAmount, TextArea, TextInput } from "../components/forms";
import { Page } from "../components/Layout";
import { BlockLink, CopyButton } from "../components/links";
import { Sheet } from "../components/Sheet";
import { useTransaction } from "../components/Transaction";
import { Badge, Card, CardHeader, EmptyState, ErrorState, PageHeader, SkeletonRows, Tabs } from "../components/ui";
import { useChain } from "../lib/chain";
import {
  argumentsOf,
  constructorOf,
  contractAddress,
  display,
  isRead,
  isWrite,
  outputs,
  parseAbi,
  placeholder,
  signature,
  type Abi,
  type AbiItem,
  type StoredContract,
} from "../lib/contracts";
import { useWallet } from "../lib/session";
import { deleteContract, listContracts, putContract } from "../lib/storage";

/** The contracts followed on the network of the wallet. */
function useContracts() {
  const { network } = useChain();
  const queries = useQueryClient();
  const query = useQuery({ queryKey: ["contracts", network.id], queryFn: () => listContracts(network.id) });
  const refresh = () => queries.invalidateQueries({ queryKey: ["contracts", network.id] });
  return {
    ...query,
    save: async (contract: { address: string; name: string; abi: Abi }) => {
      await putContract({ ...contract, network: network.id, addedAt: Date.now() });
      await refresh();
    },
    remove: async (address: string) => {
      await deleteContract(network.id, address);
      await refresh();
    },
  };
}

const short = (address: string) => `${address.slice(0, 10)}…${address.slice(-8)}`;

/** Whether a contract is deployed at `address` on the chain of `client`. */
async function deployed(client: TesseraxClient, address: string): Promise<boolean> {
  const info = await client.api.query.Revive.AccountInfoOf.getValue(address.toLowerCase(), { at: "best" });
  return Boolean(info) && (info as { account_type: { type: string } }).account_type.type === "Contract";
}

/** The SDK contract of `stored`, on `client`. */
const contractOf = (client: TesseraxClient, stored: { address: string; abi: unknown[] }): Contract => client.contract(stored.address, stored.abi as never);

/** The address of the active account in contracts, its `msg.sender`. */
function MyAddress() {
  const { active } = useWallet();
  const address = active ? contractAddress(active.address) : null;
  if (!address) return null;
  return (
    <Card className="mb-5 p-4 sm:p-5">
      <div className="text-sm font-semibold">Your address in contracts</div>
      <p className="mt-1 text-xs text-muted">
        Contracts see {active!.name} as this address, its <span className="font-mono">msg.sender</span>. Fields of type address also take Tesserax addresses, te…
      </p>
      <div className="mt-3 flex items-center gap-2 rounded-xl bg-surface-2 px-3 py-2.5">
        <span className="min-w-0 flex-1 truncate font-mono text-xs sm:text-sm">{address}</span>
        <CopyButton value={address} />
      </div>
    </Card>
  );
}

export function Contracts() {
  const { network } = useChain();
  const contracts = useContracts();
  const [sheet, setSheet] = useState<"add" | "deploy" | null>(null);
  return (
    <Page>
      <PageHeader title="Contracts" icon={<FileCode2 size={20} />} subtitle={`Solidity contracts compiled for PolkaVM, on the ${network.name.toLowerCase()}.`}>
        <div className="flex gap-2">
          <Button variant="secondary" onClick={() => setSheet("add")}>
            <Plus size={16} /> Add
          </Button>
          <Button onClick={() => setSheet("deploy")}>
            <Rocket size={16} /> Deploy
          </Button>
        </div>
      </PageHeader>
      <MyAddress />
      <Card>
        {contracts.error ? (
          <ErrorState error={contracts.error} />
        ) : contracts.isLoading ? (
          <SkeletonRows rows={3} />
        ) : !contracts.data?.length ? (
          <EmptyState title="No contract yet">Deploy a contract compiled with resolc, or add one with its address and its ABI to read it and call it.</EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {contracts.data.map((c) => (
              <li key={c.id}>
                <Link to={`/contracts/${c.address}`} className="flex items-center gap-3 px-4 py-3.5 hover:bg-surface-2 sm:px-5">
                  <span className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-accent-soft text-accent">
                    <FileCode2 size={17} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold">{c.name}</span>
                    <span className="block truncate font-mono text-xs text-muted">{short(c.address)}</span>
                  </span>
                  <Badge>{(c.abi as Abi).filter(isRead).length + (c.abi as Abi).filter(isWrite).length} functions</Badge>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {sheet === "add" && <AddSheet onClose={() => setSheet(null)} />}
      {sheet === "deploy" && <DeploySheet onClose={() => setSheet(null)} />}
    </Page>
  );
}

/** An ABI pasted or read from its file. */
function AbiField({ text, onChange, error }: { text: string; onChange: (text: string) => void; error?: string | null }) {
  return (
    <div>
      <TextArea label="ABI" hint={<FileButton accept=".json,application/json" onFile={async (file) => onChange(await file.text())}>Open a file</FileButton>} value={text} onChange={(e) => onChange(e.target.value)} placeholder='[{"type":"function","name":…}]' rows={5} mono spellCheck={false} error={error} />
    </div>
  );
}

function FileButton({ accept, onFile, children }: { accept: string; onFile: (file: File) => void; children: ReactNode }) {
  return (
    <label className="cursor-pointer font-medium text-accent hover:text-accent-strong">
      {children}
      <input type="file" accept={accept} className="hidden" onChange={(e) => e.target.files?.[0] && onFile(e.target.files[0])} />
    </label>
  );
}

function AddSheet({ onClose }: { onClose: () => void }) {
  const { client, network } = useChain();
  const contracts = useContracts();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [abiText, setAbiText] = useState("");
  const [errors, setErrors] = useState<{ name?: string; address?: string; abi?: string }>({});
  const [busy, setBusy] = useState(false);

  const add = async () => {
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Name it, for you";
    const checksummed = /^0x[0-9a-fA-F]{40}$/.test(address.trim()) ? contractAddress(address) : null;
    if (!checksummed) next.address = "A contract address: 0x and 40 digits";
    let abi: Abi | undefined;
    try {
      abi = parseAbi(abiText);
    } catch (e) {
      next.abi = (e as Error).message;
    }
    setErrors(next);
    if (Object.keys(next).length || !checksummed || !abi) return;
    setBusy(true);
    try {
      if (!(await deployed(client, checksummed))) {
        setErrors({ address: `No contract at this address on the ${network.name.toLowerCase()}` });
        return;
      }
      await contracts.save({ address: checksummed, name: name.trim(), abi });
      navigate(`/contracts/${checksummed}`);
    } catch (e) {
      setErrors({ address: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Add a contract" icon={<Plus size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My token" error={errors.name} />
        <TextInput label="Address" value={address} onChange={(e) => setAddress(e.target.value.trim())} placeholder="0x…" mono spellCheck={false} error={errors.address} />
        <AbiField text={abiText} onChange={setAbiText} error={errors.abi} />
        <Button className="w-full" busy={busy} onClick={add}>
          Add the contract
        </Button>
      </div>
    </Sheet>
  );
}

/** Fields for the inputs of a function or a constructor. */
function InputFields({ inputs, texts, onChange, errors }: { inputs: AbiItem["inputs"]; texts: string[]; onChange: (texts: string[]) => void; errors: Array<string | null> }) {
  return (
    <>
      {(inputs ?? []).map((input, i) => (
        <TextInput
          key={i}
          label={input.name || `Argument ${i + 1}`}
          hint={input.type}
          value={texts[i] ?? ""}
          onChange={(e) => onChange(Object.assign([...texts], { [i]: e.target.value }))}
          placeholder={placeholder(input.type)}
          mono
          spellCheck={false}
          autoComplete="off"
          error={errors[i]}
        />
      ))}
    </>
  );
}

function DeploySheet({ onClose }: { onClose: () => void }) {
  const tx = useTransaction();
  const contracts = useContracts();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [code, setCode] = useState<{ file: string; bytes: Uint8Array } | null>(null);
  const [abiText, setAbiText] = useState("");
  const [texts, setTexts] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);

  const abi = useMemo(() => {
    try {
      return { abi: parseAbi(abiText) };
    } catch (e) {
      return { error: (e as Error).message };
    }
  }, [abiText]);
  const constructor = abi.abi ? constructorOf(abi.abi) : undefined;
  const payable = constructor?.stateMutability === "payable";
  const args = argumentsOf(constructor?.inputs ?? [], texts);
  const amount = payable && value ? parseAmount(value) : null;
  const errors = {
    name: !name.trim() ? "Name it, for you" : null,
    code: !code ? "Choose the .polkavm file resolc compiled" : code.bytes[0] === 0x60 ? "This is EVM bytecode: compile with resolc for PolkaVM" : null,
    abi: abiText ? (abi.error ?? null) : "Paste or open the ABI of the contract",
    value: amount?.error ?? null,
  };

  const review = () => {
    setSubmitted(true);
    if (errors.name || errors.code || errors.abi || errors.value || !args.values || !abi.abi || !code) return;
    const sent = amount?.amount ?? new Amount(0n);
    tx({
      title: "Deploy a contract",
      summary: name.trim(),
      details: [
        ["Code", `${code.file}, ${(code.bytes.length / 1024).toFixed(1)} KB`],
        ...(constructor?.inputs?.length ? [["Constructor", <span key="args" className="break-all font-mono text-xs">{args.values.map(display).join(", ")}</span>] as [string, ReactNode]] : []),
        ...(sent.planck > 0n ? [["Sent to the contract", `${value} TESS`] as [string, ReactNode]] : []),
        ["Deposit", "Storing the code and the state of the contract reserves TESS of your account, returned when they are removed"],
      ],
      operation: (c: TesseraxClient, key: Keypair) => c.deployContract(key, { code: code.bytes, abi: abi.abi as never, args: args.values, value: sent }),
      onDone: (result) => {
        const address = (result as { address: string }).address;
        void contracts.save({ address, name: name.trim(), abi: abi.abi! }).then(() => navigate(`/contracts/${address}`));
      },
    });
  };

  return (
    <Sheet title="Deploy a contract" icon={<Rocket size={18} />} onClose={onClose}>
      <div className="space-y-5">
        <TextInput label="Name" value={name} onChange={(e) => setName(e.target.value)} placeholder="My token" error={submitted ? errors.name : null} />
        <div>
          <div className="mb-1.5 text-sm font-medium">Code</div>
          <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-dashed border-line-strong bg-surface-2 px-4 py-3 text-sm hover:border-accent">
            <FileUp size={18} className="shrink-0 text-accent" />
            <span className="min-w-0 flex-1 truncate">{code ? `${code.file}, ${(code.bytes.length / 1024).toFixed(1)} KB` : "Choose the .polkavm file (resolc --bin)"}</span>
            <input
              type="file"
              accept=".polkavm,application/octet-stream"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCode({ file: file.name, bytes: new Uint8Array(await file.arrayBuffer()) });
              }}
            />
          </label>
          <ErrorText>{submitted ? errors.code : null}</ErrorText>
        </div>
        <AbiField text={abiText} onChange={setAbiText} error={submitted ? errors.abi : null} />
        {constructor?.inputs?.length ? (
          <div className="space-y-4 rounded-xl border border-line p-4">
            <div className="text-sm font-semibold">Constructor</div>
            <InputFields inputs={constructor.inputs} texts={texts} onChange={setTexts} errors={submitted ? args.errors : []} />
          </div>
        ) : null}
        {payable && <AmountInput label="TESS sent to the contract" value={value} onChange={setValue} error={submitted ? errors.value : null} />}
        <Button className="w-full" onClick={review}>
          Review
        </Button>
      </div>
    </Sheet>
  );
}

type View = "read" | "write" | "events";

export function ContractDetail() {
  const { address = "" } = useParams();
  const contracts = useContracts();
  const navigate = useNavigate();
  const [view, setView] = useState<View>("read");
  const [events, setEvents] = useState<ContractEvent[]>([]);
  const stored = contracts.data?.find((c) => c.address.toLowerCase() === address.toLowerCase());

  if (contracts.isLoading) {
    return (
      <Page>
        <SkeletonRows rows={4} />
      </Page>
    );
  }
  if (!stored) {
    return (
      <Page narrow>
        <EmptyState title="Unknown contract">
          This contract is not in your list on this network. <Link to="/contracts" className="text-accent">Back to the contracts</Link>
        </EmptyState>
      </Page>
    );
  }
  const abi = stored.abi as Abi;
  const reads = abi.filter(isRead);
  const writes = abi.filter(isWrite);
  return (
    <Page>
      <PageHeader
        title={stored.name}
        icon={<FileCode2 size={20} />}
        subtitle={
          <span className="flex min-w-0 items-center gap-1">
            <span className="truncate font-mono">{stored.address}</span>
            <CopyButton value={stored.address} />
          </span>
        }
      >
        <Button
          variant="ghost"
          onClick={async () => {
            await contracts.remove(stored.address);
            navigate("/contracts");
          }}
        >
          <Trash2 size={16} /> Remove from the list
        </Button>
      </PageHeader>
      <div className="mb-5">
        <Tabs<View>
          tabs={[
            { id: "read", label: <span className="inline-flex items-center gap-1.5"><BookOpen size={15} /> Read</span>, count: reads.length },
            { id: "write", label: <span className="inline-flex items-center gap-1.5"><PenLine size={15} /> Write</span>, count: writes.length },
            { id: "events", label: <span className="inline-flex items-center gap-1.5"><Radio size={15} /> Events</span> },
          ]}
          value={view}
          onChange={setView}
        />
      </div>
      {view === "read" && (
        <div className="grid gap-4 lg:grid-cols-2">
          {reads.length ? reads.map((item) => <ReadFunction key={signature(item)} stored={stored} item={item} />) : <EmptyState title="No function to read" />}
        </div>
      )}
      {view === "write" && (
        <div className="grid gap-4 lg:grid-cols-2">
          {writes.length ? (
            writes.map((item) => <WriteFunction key={signature(item)} stored={stored} item={item} onEvents={(emitted) => setEvents((seen) => [...emitted, ...seen])} />)
          ) : (
            <EmptyState title="No function to call" />
          )}
        </div>
      )}
      {view === "events" && <Events stored={stored} recent={events} />}
    </Page>
  );
}

function ResultRows({ rows }: { rows: Array<[string, string]> }) {
  return (
    <dl className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3">
      {rows.map(([name, value], i) => (
        <div key={i} className="min-w-0">
          <dt className="text-xs text-muted">{name}</dt>
          <dd className="whitespace-pre-wrap break-all font-mono text-[13px]">{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReadFunction({ stored, item }: { stored: StoredContract; item: AbiItem }) {
  const { client, url } = useChain();
  const { active } = useWallet();
  const inputs = item.inputs ?? [];
  const [texts, setTexts] = useState<string[]>([]);
  const [asked, setAsked] = useState<unknown[] | null>(inputs.length ? null : []);
  const [submitted, setSubmitted] = useState(false);
  const args = argumentsOf(inputs, texts);
  const result = useQuery({
    queryKey: ["contract-read", url, stored.address, signature(item), asked, active?.address],
    queryFn: async () => outputs(item, await contractOf(client, stored).read(item.name!, asked!, { from: active?.address })),
    enabled: asked !== null,
    retry: false,
  });
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate font-mono text-sm font-semibold">{item.name}</div>
          <div className="mt-0.5 truncate font-mono text-xs text-muted">→ {(item.outputs ?? []).map((o) => o.type).join(", ") || "nothing"}</div>
        </div>
        {asked !== null && (
          <Button variant="ghost" size="sm" busy={result.isFetching} onClick={() => void result.refetch()} aria-label="Read again">
            <RefreshCw size={14} />
          </Button>
        )}
      </div>
      {inputs.length > 0 && (
        <div className="mt-4 space-y-3">
          <InputFields inputs={inputs} texts={texts} onChange={setTexts} errors={submitted ? args.errors : []} />
          <Button
            variant="secondary"
            size="sm"
            onClick={() => {
              setSubmitted(true);
              if (args.values) setAsked(args.values);
            }}
          >
            Read
          </Button>
        </div>
      )}
      {result.error ? <ErrorText>{(result.error as Error).message}</ErrorText> : result.data ? <ResultRows rows={result.data} /> : null}
    </Card>
  );
}

function WriteFunction({ stored, item, onEvents }: { stored: StoredContract; item: AbiItem; onEvents: (events: ContractEvent[]) => void }) {
  const tx = useTransaction();
  const inputs = item.inputs ?? [];
  const payable = item.stateMutability === "payable";
  const [texts, setTexts] = useState<string[]>([]);
  const [value, setValue] = useState("");
  const [submitted, setSubmitted] = useState(false);
  const [last, setLast] = useState<ContractTxOutcome | null>(null);
  const args = argumentsOf(inputs, texts);
  const amount = payable && value ? parseAmount(value) : null;

  const review = () => {
    setSubmitted(true);
    if (!args.values || amount?.error) return;
    const values = args.values;
    const sent = amount?.amount ?? new Amount(0n);
    tx({
      title: `Call ${item.name}`,
      summary: <span className="font-mono">{item.name}</span>,
      details: [
        ["Contract", `${stored.name}, ${short(stored.address)}`],
        ...inputs.map((input, i) => [input.name || `Argument ${i + 1}`, <span key={i} className="break-all font-mono text-xs">{display(values[i])}</span>] as [string, ReactNode]),
        ...(sent.planck > 0n ? [["Sent to the contract", `${value} TESS`] as [string, ReactNode]] : []),
      ],
      operation: (c: TesseraxClient, key: Keypair) => contractOf(c, stored).write(key, item.name!, values, { value: sent }),
      onDone: (result) => {
        const outcome = result as ContractTxOutcome;
        setLast(outcome);
        onEvents(outcome.contractEvents);
      },
    });
  };

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex items-center gap-2">
        <span className="truncate font-mono text-sm font-semibold">{item.name}</span>
        {payable && <Badge tone="warning">payable</Badge>}
      </div>
      <div className="mt-4 space-y-3">
        <InputFields inputs={inputs} texts={texts} onChange={setTexts} errors={submitted ? args.errors : []} />
        {payable && <AmountInput label="TESS sent" value={value} onChange={setValue} error={submitted ? (amount?.error ?? null) : null} />}
        <Button size="sm" onClick={review}>
          Review
        </Button>
      </div>
      {last && (
        <div className="mt-3 text-xs text-muted">
          Included in block <BlockLink number={last.blockNumber} />
          {last.contractEvents.length > 0 && ` · ${last.contractEvents.map((e) => e.name ?? "event").join(", ")}`}
        </div>
      )}
    </Card>
  );
}

interface IndexedEvent {
  block_number: number;
  block_hash: string;
  index: number;
  data: { contract?: string; data?: string | { bytes: number }; topics?: string[] };
  timestamp: string | null;
}

function Events({ stored, recent }: { stored: StoredContract; recent: ContractEvent[] }) {
  const { client, network } = useChain();
  const contract = contractOf(client, stored);
  const indexed = useQuery({
    queryKey: ["contract-events", network.id, stored.address],
    queryFn: async () => {
      const { url, key } = network.indexer!;
      const response = await fetch(
        `${url}/rest/v1/events?select=block_number,block_hash,index,data,timestamp&pallet=eq.Revive&name=eq.ContractEmitted&data->>contract=eq.${stored.address.toLowerCase()}&order=block_number.desc,index.desc&limit=50`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` }, referrerPolicy: "no-referrer", credentials: "omit" },
      );
      if (!response.ok) throw new Error(`explorer database unavailable (${response.status})`);
      return (await response.json()) as IndexedEvent[];
    },
    enabled: Boolean(network.indexer),
    refetchInterval: 20_000,
  });

  // Events of the calls made here, then those of the explorer database, once each.
  const rows: Array<{ key: string; name: string; args: Array<[string, string]>; block: number }> = [];
  const seen = new Set<string>();
  const keyOf = (block: string, topics: readonly string[], data: unknown) => `${block}|${topics.join()}|${String(data)}`.toLowerCase();
  for (const e of recent) {
    const key = keyOf(e.blockHash, e.topics, e.data);
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ key, name: e.name ?? "Unknown event", args: Object.entries(e.args).map(([k, v]) => [k, display(v)]), block: e.blockNumber });
  }
  for (const e of indexed.data ?? []) {
    const key = keyOf(e.block_hash, e.data.topics ?? [], e.data.data);
    if (seen.has(key)) continue;
    seen.add(key);
    const data = typeof e.data.data === "string" ? e.data.data : null;
    const decoded = data ? contract.decodeEvent((e.data.topics ?? []) as never, data as never) : undefined;
    rows.push({
      key,
      name: decoded?.name ?? (data ? "Unknown event" : "Event too large to show here"),
      args: decoded ? Object.entries(decoded.args).map(([k, v]) => [k, display(v)]) : [],
      block: e.block_number,
    });
  }

  return (
    <Card>
      <CardHeader title="Events" icon={<Radio size={16} />} />
      {indexed.error ? (
        <ErrorState error={indexed.error} />
      ) : indexed.isLoading ? (
        <SkeletonRows rows={3} />
      ) : !rows.length ? (
        <EmptyState title="No event yet">
          {network.indexer ? "Events this contract emits appear here." : "Events of the calls you make appear here; this network has no explorer database for the older ones."}
        </EmptyState>
      ) : (
        <ul className="divide-y divide-line">
          {rows.map((row) => (
            <li key={row.key} className="px-4 py-3 sm:px-5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-mono text-sm font-semibold">{row.name}</span>
                <span className="text-xs text-muted">
                  Block <BlockLink number={row.block} />
                </span>
              </div>
              {row.args.length > 0 && <ResultRows rows={row.args} />}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
