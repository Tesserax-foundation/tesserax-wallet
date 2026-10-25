/** The networks the wallet can use: the mainnet, the testnet, and a chain of one's own for
 * development. Their public endpoints are built in; a build can change any of them with
 * `VITE_<NETWORK>_...` variables, and the variables without prefix apply to the network the
 * build opens by default (`VITE_NETWORK`). */

import type { TesseraxClient } from "@tesserax/sdk";

export type NetworkId = "mainnet" | "testnet" | "development";

export interface Network {
  id: NetworkId;
  name: string;
  /** Genesis hash the node must have, `0x` and 64 digits; none for a development chain. The
   * mainnet is unavailable until its genesis is known. */
  genesisHash?: string;
  nodeUrl: string;
  explorerUrl: string;
  /** Faucet giving test TESS. */
  faucetUrl?: string;
  /** The explorer database, read-only, for the history and the private balance. */
  indexer?: { url: string; key: string };
  /** TESS of this network have no value. */
  test: boolean;
  /** One local EVM chain, such as anvil, standing for every EVM chain of swaps: for development. */
  evmLocalUrl?: string;
}

const builtIn: Record<NetworkId, Omit<Network, "indexer">> = {
  mainnet: {
    id: "mainnet",
    name: "Mainnet",
    genesisHash: undefined,
    nodeUrl: "wss://rpc.tesserax.app",
    explorerUrl: "https://explorer.tesserax.app",
    test: false,
  },
  testnet: {
    id: "testnet",
    name: "Testnet",
    genesisHash: "0xc2f9cb03897c5ad30fff2f93debaa8b4a6e08f37a12270e107c71eb1ad39e5d1",
    nodeUrl: "wss://rpc.tesserax.app:21207",
    explorerUrl: "https://explorer.tesserax.app",
    faucetUrl: "https://faucet.tesserax.app",
    test: true,
  },
  development: {
    id: "development",
    name: "Development",
    nodeUrl: "ws://127.0.0.1:9944",
    explorerUrl: "",
    test: true,
  },
};

export const networkIds: NetworkId[] = ["mainnet", "testnet", "development"];

const isNetworkId = (value: unknown): value is NetworkId => networkIds.includes(value as NetworkId);

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;

/** The network the build opens by default. */
export const defaultNetworkId: NetworkId = (() => {
  const named = env.VITE_NETWORK?.trim().toLowerCase();
  return isNetworkId(named) ? named : "development";
})();

/** The variable `name` of `id`: prefixed, or without prefix for the default network. */
function variable(id: NetworkId, name: string): string | undefined {
  const value = env[`VITE_${id.toUpperCase()}_${name}`] ?? (id === defaultNetworkId ? env[`VITE_${name}`] : undefined);
  return value?.trim() || undefined;
}

const trimSlash = (url: string) => url.replace(/\/$/, "");

function configure(id: NetworkId): Network {
  const base = builtIn[id];
  const indexerUrl = variable(id, "EXPLORER_SUPABASE_URL");
  const indexerKey = variable(id, "EXPLORER_SUPABASE_KEY");
  const faucetUrl = variable(id, "FAUCET_URL") ?? base.faucetUrl;
  return {
    ...base,
    genesisHash: (variable(id, "GENESIS") ?? base.genesisHash)?.toLowerCase(),
    nodeUrl: variable(id, "NODE_URL") ?? base.nodeUrl,
    explorerUrl: trimSlash(variable(id, "EXPLORER_URL") ?? base.explorerUrl),
    faucetUrl: faucetUrl ? trimSlash(faucetUrl) : undefined,
    indexer: indexerUrl && indexerKey ? { url: trimSlash(indexerUrl), key: indexerKey } : undefined,
    evmLocalUrl: id === "development" ? variable(id, "EVM_LOCAL_URL") : undefined,
  };
}

export const networks: Record<NetworkId, Network> = {
  mainnet: configure("mainnet"),
  testnet: configure("testnet"),
  development: configure("development"),
};

/** Whether the wallet can use `network`: the mainnet once its genesis is known. */
export const isAvailable = (network: Network) => network.id !== "mainnet" || Boolean(network.genesisHash);

/** The network of a saved setting, or the default one. */
export const networkOf = (id: unknown): Network => {
  const network = isNetworkId(id) ? networks[id] : undefined;
  return network && isAvailable(network) ? network : networks[defaultNetworkId];
};

const NETWORK = Symbol("network");

/** Mark `client` as connected to `network`. Objects made from it, such as the client capturing a
 * transaction to estimate its fee, inherit the mark. */
export function markClient(client: TesseraxClient, network: Network): void {
  Object.defineProperty(client, NETWORK, { value: network });
}

/** The network `client` is connected to, if marked. */
export const clientNetwork = (client: TesseraxClient): Network | undefined => (client as unknown as Record<symbol, Network | undefined>)[NETWORK];

/** Why the node with `genesisHash` does not serve `network`, if it does not. */
export function wrongChain(network: Network, genesisHash: string): string | null {
  if (!network.genesisHash || genesisHash.toLowerCase() === network.genesisHash) return null;
  return `this node is on another chain than the ${network.name.toLowerCase()}`;
}
