/** The EVM chains of the market, and the EVM wallet of the browser that pays on them: MetaMask,
 * Rabby or any wallet of the EIP-1193 standard. The keys of the EVM accounts stay in that wallet;
 * nothing of it touches Tesserax. */

import { EvmSwaps, evmNetworks, type EvmNetwork, type SwapChain } from "@tesserax/sdk";
import { createWalletClient, custom, type Address, type EIP1193Provider, type WalletClient } from "viem";
import type { Network } from "./networks";

/** The EVM chains paying offers of `network`: the mainnets for the mainnet, their testnets
 * otherwise, or one local chain for every one of them on a development chain. */
export function evmNetworksOf(network: Network): EvmNetwork[] {
  const list = evmNetworks(network.id !== "mainnet");
  if (!network.evmLocalUrl) return list;
  return list.map((n) => ({ ...n, name: `${n.chain} (local)`, chainId: 31_337, rpcUrl: network.evmLocalUrl!, explorer: "" }));
}

export const evmNetworkOf = (network: Network, chain: SwapChain): EvmNetwork | undefined => evmNetworksOf(network).find((n) => n.chain === chain);

/** The EVM wallet of the browser, if any. */
export const browserWallet = (): EIP1193Provider | undefined => (globalThis as { ethereum?: EIP1193Provider }).ethereum;

/** Reads of `evm`, through its public RPC. */
export const evmReader = (evm: EvmNetwork) => new EvmSwaps(evm);

/** Connect the EVM wallet of the browser on `evm`, adding the chain to it if it lacks it. */
export async function connectEvm(evm: EvmNetwork): Promise<{ swaps: EvmSwaps; address: Address; client: WalletClient }> {
  const provider = browserWallet();
  if (!provider) throw new Error("No EVM wallet in this browser: install one, such as MetaMask or Rabby, to pay in ETH, USDC or USDT.");
  const [address] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!address) throw new Error("The EVM wallet gave no account.");
  const chainId = `0x${evm.chainId.toString(16)}`;
  if (Number.parseInt(String(await provider.request({ method: "eth_chainId" })), 16) !== evm.chainId) {
    try {
      await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
    } catch (error) {
      const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
      if (code !== 4902) throw error;
      await provider.request({
        method: "wallet_addEthereumChain",
        params: [{ chainId, chainName: evm.name, nativeCurrency: evm.nativeCurrency, rpcUrls: [evm.rpcUrl], blockExplorerUrls: evm.explorer ? [evm.explorer] : undefined }],
      });
    }
  }
  const client = createWalletClient({ account: address, transport: custom(provider) });
  return { swaps: new EvmSwaps(evm, { walletClient: client }), address, client };
}

/** Link to the EVM transaction `hash` on the explorer of `evm`, if it has one. */
export const evmTxUrl = (evm: EvmNetwork | undefined, hash: string) => (evm?.explorer ? `${evm.explorer}/tx/${hash}` : undefined);

/** Hexadecimal of `bytes`, `0x` first. */
export const hex = (bytes: Uint8Array) => `0x${Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

/** Bytes of a hexadecimal string, with or without `0x`. */
export function unhex(text: string): Uint8Array {
  const digits = text.trim().replace(/^0x/i, "");
  if (digits.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(digits)) throw new Error("not hexadecimal");
  return Uint8Array.from(digits.match(/../g) ?? [], (b) => Number.parseInt(b, 16));
}

/** `value` smallest units of an asset of `decimals` as a decimal number, without trailing zeros. */
export function decimal(value: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole.toLocaleString("en-US")}.${fraction}` : whole.toLocaleString("en-US");
}

/** A decimal number of an asset of `decimals` in its smallest unit, or why it is not one. */
export function units(text: string, decimals: number): { value?: bigint; error?: string } {
  const clean = text.trim().replace(/,/g, "");
  if (!clean) return { error: "Enter a number" };
  const match = /^(\d*)(?:\.(\d*))?$/.exec(clean);
  if (!match || (!match[1] && !match[2])) return { error: "Not a number" };
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return { error: `At most ${decimals} decimals` };
  return { value: BigInt(match[1] || "0") * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, "0") || "0") };
}
