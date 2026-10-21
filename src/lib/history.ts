/** Activity of an account, read from the explorer database (read-only, optional): the chain
 * itself cannot list the transactions of an address. */

import { useQuery } from "@tanstack/react-query";

const url = (import.meta.env.VITE_EXPLORER_SUPABASE_URL as string | undefined)?.replace(/\/$/, "");
const key = import.meta.env.VITE_EXPLORER_SUPABASE_KEY as string | undefined;

/** Whether the build can show a history. */
export const historyAvailable = Boolean(url && key);

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

async function rest<T>(path: string): Promise<T> {
  const response = await fetch(`${url}/rest/v1/${path}`, {
    headers: { apikey: key!, Authorization: `Bearer ${key}` },
    referrerPolicy: "no-referrer",
    credentials: "omit",
  });
  if (!response.ok) throw new Error(`history unavailable (${response.status})`);
  return response.json() as Promise<T>;
}

/** The latest transfers and calls of `address`, newest first. */
export async function activity(address: string, limit = 25): Promise<ActivityItem[]> {
  const a = encodeURIComponent(address);
  const [transfers, calls] = await Promise.all([
    rest<Array<{ block_number: number; event_index: number; extrinsic_hash: string | null; from_address: string; to_address: string; amount: string; timestamp: string | null }>>(
      `transfers?select=block_number,event_index,extrinsic_hash,from_address,to_address,amount::text,timestamp&or=(from_address.eq.${a},to_address.eq.${a})&order=block_number.desc,event_index.desc&limit=${limit}`,
    ),
    rest<Array<{ block_number: number; index: number; hash: string; pallet: string; call: string; success: boolean; error: string | null; fee: string | null; timestamp: string | null }>>(
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

export const useActivity = (address: string | undefined) =>
  useQuery({
    queryKey: ["activity", address],
    queryFn: () => activity(address!),
    enabled: historyAvailable && Boolean(address),
    refetchInterval: 20_000,
  });
