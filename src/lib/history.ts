/** Activity of an account, read from the explorer database (read-only, optional): the chain
 * itself cannot list the transactions of an address. */

import { useQuery } from "@tanstack/react-query";
import { useChain } from "./chain";
import type { Network } from "./networks";

type Indexer = NonNullable<Network["indexer"]>;

export interface ActivityItem {
  kind: "sent" | "received" | "call";
  blockNumber: number;
  index: number;
  hash: string | null;
  timestamp: string | null;
  /** Transfers: the other party and the amount, in planck. */
  counterparty?: string;
  amount?: string;
  /** Calls: what was called, and its result. */
  pallet?: string;
  call?: string;
  success?: boolean;
  error?: string | null;
  fee?: string | null;
}

async function rest<T>({ url, key }: Indexer, path: string): Promise<T> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key, Authorization: `Bearer ${key}` },
    referrerPolicy: "no-referrer",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`history unavailable (${response.status})`);
  return response.json() as Promise<T>;
}

/** The latest transfers and calls of `address`, newest first. */
export async function activity(indexer: Indexer, address: string, limit = 25): Promise<ActivityItem[]> {
  const a = encodeURIComponent(address);
  const [transfers, calls] = await Promise.all([
    rest<Array<{ block_number: number; event_index: number; extrinsic_hash: string | null; from_address: string; to_address: string; amount: string; timestamp: string | null }>>(
      indexer,
      `transfers?select=block_number,event_index,extrinsic_hash,from_address,to_address,amount::text,timestamp&or=(from_address.eq.${a},to_address.eq.${a})&order=block_number.desc,event_index.desc&limit=${limit}`,
    ),
    rest<Array<{ block_number: number; index: number; hash: string; pallet: string; call: string; success: boolean; error: string | null; fee: string | null; timestamp: string | null }>>(
      indexer,
      `extrinsics?select=block_number,index,hash,pallet,call,success,error,fee::text,timestamp&signer=eq.${a}&order=block_number.desc,index.desc&limit=${limit}`,
    ),
  ]);
  const items: ActivityItem[] = [
    ...transfers.map((t) => ({
      kind: (t.from_address === address ? "sent" : "received") as ActivityItem["kind"],
      blockNumber: t.block_number,
      index: t.event_index,
      hash: t.extrinsic_hash,
      timestamp: t.timestamp,
      counterparty: t.from_address === address ? t.to_address : t.from_address,
      amount: t.amount,
    })),
    // Plain transfers already appear as transfers.
    ...calls
      .filter((c) => !(c.pallet === "Balances" && c.call.startsWith("transfer") && c.success))
      .map((c) => ({ kind: "call" as const, blockNumber: c.block_number, index: c.index, hash: c.hash, timestamp: c.timestamp, pallet: c.pallet, call: c.call, success: c.success, error: c.error, fee: c.fee })),
  ];
  return items.sort((x, y) => y.blockNumber - x.blockNumber || y.index - x.index).slice(0, limit);
}

/** Whether the network has an explorer database for the history. */
export const useHistoryAvailable = () => Boolean(useChain().network.indexer);

export const useActivity = (address: string | undefined) => {
  const { network } = useChain();
  return useQuery({
    queryKey: ["activity", network.id, address],
    queryFn: () => activity(network.indexer!, address!),
    enabled: Boolean(network.indexer) && Boolean(address),
    refetchInterval: 20_000,
  });
};
