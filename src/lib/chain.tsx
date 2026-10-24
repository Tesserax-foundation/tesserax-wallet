/** Connection to a Tesserax node, and what the wallet needs beyond the SDK: fee estimates,
 * delegations by owner or agent, channels by payee. */

import { accountIdOf, Amount, Channels, formatAddress, MORTALITY, mlDsaTxCreator, parseAddress, Tasks, TesseraxClient, type Delegation, type Keypair } from "@tesserax/sdk";
import { useQuery } from "@tanstack/react-query";
import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { markClient, wrongChain, type Network } from "./networks";
import { useWallet } from "./session";
import { activeNetwork } from "./storage";

export type Operation = (client: TesseraxClient) => Promise<unknown>;

interface Chain {
  client: TesseraxClient;
  tasks: Tasks;
  channels: Channels;
  url: string;
  /** The network chosen, with its node and explorer. */
  network: Network;
}

const ChainContext = createContext<Chain | null>(null);

export function useChain(): Chain {
  const chain = useContext(ChainContext);
  if (!chain) throw new Error("useChain outside of ChainProvider");
  return chain;
}

export function ChainProvider({ children }: { children: ReactNode }) {
  const { settings } = useWallet();
  const network = activeNetwork(settings);
  const [chain, setChain] = useState<Chain | null>(null);
  // The connection is opened and closed by the same effect: an effect run twice, as in strict
  // mode, never leaves the application with a closed connection.
  useEffect(() => {
    const client = new TesseraxClient(network.nodeUrl);
    markClient(client, network);
    setChain({ client, tasks: new Tasks(client), channels: new Channels(client), url: network.nodeUrl, network });
    return () => client.destroy();
  }, [network.id, network.nodeUrl]);
  if (!chain || chain.url !== network.nodeUrl || chain.network.id !== network.id) return null;
  const value = chain.network.explorerUrl === network.explorerUrl ? chain : { ...chain, network };
  return <ChainContext.Provider value={value}>{children}</ChainContext.Provider>;
}

const toHex = (bytes: Uint8Array) => "0x" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** Chain information of `client`, if it serves `network`: a node of another chain is refused. */
export async function checkedChainInfo(client: TesseraxClient, network: Network) {
  const answer = Promise.all([client.chainInfo(), client.genesisHash()]);
  const timeout = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("the node does not answer")), 8000));
  const [info, genesis] = await Promise.race([answer, timeout]);
  const wrong = wrongChain(network, toHex(genesis));
  if (wrong) throw new WrongChain(wrong);
  return info;
}

/** The node serves another chain than the network chosen. */
export class WrongChain extends Error {}

/** The node answers, on the chain of the network, and on which block it is. */
export const useNodeStatus = () => {
  const { client, url, network } = useChain();
  return useQuery({
    queryKey: ["node", network.id, url],
    queryFn: () => checkedChainInfo(client, network),
    refetchInterval: 12_000,
    retry: false,
  });
};

export const useBalance = (address: string | undefined) => {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["balance", url, address],
    queryFn: () => client.balance(address!),
    enabled: Boolean(address),
    refetchInterval: 12_000,
  });
};

/** The address as written by the chain, or null if it is not a Tesserax address. */
export function normalizeAddress(text: string): string | null {
  try {
    return formatAddress(parseAddress(text.trim()));
  } catch {
    return null;
  }
}

interface Tx {
  create(creator: unknown, options: unknown): Promise<Uint8Array>;
}

class Captured extends Error {
  constructor(readonly tx: Tx) {
    super("captured");
  }
}

/** The transaction `operation` would submit, without submitting it. */
async function capture(client: TesseraxClient, operation: (client: TesseraxClient) => Promise<unknown>) {
  const capturing: TesseraxClient = Object.create(client);
  (capturing as any).submit = async (tx: Tx) => {
    throw new Captured(tx);
  };
  try {
    await operation(capturing);
  } catch (error) {
    if (error instanceof Captured) return error.tx;
    throw error;
  }
  throw new Error("the operation submits no transaction");
}

/** The fee of the transaction `operation` would submit, signed by `signer`: the transaction is
 * signed for real (an ML-DSA-87 signature weighs 4 627 bytes) but not submitted. */
export async function estimateFee(client: TesseraxClient, operation: (client: TesseraxClient) => Promise<unknown>, signer: Keypair): Promise<Amount> {
  const tx = await capture(client, operation);
  const signed = await tx.create(mlDsaTxCreator(signer), { mortality: { mortal: true, period: MORTALITY } });
  const hex = "0x" + Array.from(signed, (b) => b.toString(16).padStart(2, "0")).join("");
  const info = await client.client._request<{ partialFee: string | number }>("payment_queryInfo", [hex]);
  return new Amount(BigInt(info.partialFee));
}

/** Delegations given by `owner`. */
export async function delegationsOf(client: TesseraxClient, owner: string): Promise<Delegation[]> {
  const entries = await client.api.query.Agents.Delegations.getEntries(formatAddress(parseAddress(owner)), { at: "best" });
  const agents: string[] = entries.map((e: { keyArgs: [string, string] }) => formatAddress(parseAddress(e.keyArgs[1])));
  return (await Promise.all(agents.map((agent) => client.delegation(owner, agent)))).filter((d): d is Delegation => Boolean(d));
}

/** Delegations received by the agent key `agent`. */
export async function delegationsTo(client: TesseraxClient, agent: string): Promise<Delegation[]> {
  const me = formatAddress(parseAddress(agent));
  const entries = await client.api.query.Agents.Delegations.getEntries({ at: "best" });
  const owners: string[] = entries
    .map((e: { keyArgs: [string, string] }) => e.keyArgs.map((k) => formatAddress(parseAddress(k))))
    .filter(([, a]: string[]) => a === me)
    .map(([owner]: string[]) => owner);
  return (await Promise.all(owners.map((owner) => client.delegation(owner, agent)))).filter((d): d is Delegation => Boolean(d));
}

/** The account of the key signing the vouchers of a channel, from its stored public key. */
function signerAccount(value: unknown): string | null {
  try {
    const bytes = value instanceof Uint8Array ? value : typeof value === "string" ? Uint8Array.from(value.slice(2).match(/../g) ?? [], (b) => parseInt(b, 16)) : null;
    return bytes ? formatAddress(accountIdOf(bytes)) : null;
  } catch {
    return null;
  }
}

/** Channels where `account` is the payer, the payee, or the key signing the vouchers. */
export async function channelsOf(chain: Chain, account: string) {
  const me = formatAddress(parseAddress(account));
  const entries = await chain.client.api.query.Channels.Channels.getEntries({ at: "best" });
  const ids: bigint[] = entries
    .filter((e: { value: { payer: string; payee: string; signer: unknown } }) =>
      [formatAddress(parseAddress(e.value.payer)), formatAddress(parseAddress(e.value.payee)), signerAccount(e.value.signer)].includes(me),
    )
    .map((e: { keyArgs: [bigint] }) => BigInt(e.keyArgs[0]));
  const channels = await Promise.all(ids.map((id) => chain.channels.channel(id)));
  return channels.filter((c): c is NonNullable<typeof c> => Boolean(c)).sort((a, b) => Number(b.id - a.id));
}

/** Deregister the agent `agent` (the agent itself or its confirmed owner): the deposit returns. */
export const deregisterAgent = (client: TesseraxClient, signer: Keypair, agent: string) =>
  client.submit(client.api.tx.AgentRegistry.deregister({ agent: formatAddress(parseAddress(agent)) }), signer);

/** Propose `owner` as the owner of the agent signing; the owner confirms it. */
export const setOwner = (client: TesseraxClient, signer: Keypair, owner: string | undefined) =>
  client.submit(client.api.tx.AgentRegistry.set_owner({ owner: owner ? formatAddress(parseAddress(owner)) : undefined }), signer);

/** The best block number, refreshed, for deadlines and periods. */
export const useBestBlock = () => {
  const { client, url } = useChain();
  return useQuery({ queryKey: ["best", url], queryFn: () => client.bestBlockNumber(), refetchInterval: 12_000 });
};

/** Blocks of 18 seconds in an hour. */
export const BLOCKS_PER_HOUR = 200;

/** Delegations the account received: it can spend for those owners. */
export const useReceivedDelegations = (address?: string) => {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["delegations-to", url, address],
    queryFn: () => delegationsTo(client, address!),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
};

/** Delegations the account gave to agents. */
export const useGivenDelegations = (address?: string) => {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["delegations-of", url, address],
    queryFn: () => delegationsOf(client, address!),
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
};

/** The registry record of an agent, if registered. */
export const useAgentRecord = (address?: string) => {
  const { client, url } = useChain();
  return useQuery({
    queryKey: ["agent", url, address],
    queryFn: async () => (await client.agent(address!)) ?? null,
    enabled: Boolean(address),
    refetchInterval: 30_000,
  });
};
