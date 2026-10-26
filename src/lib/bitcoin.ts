/** The Bitcoin wallet of the browser that pays offers in BTC: the Bitcoin account of MetaMask,
 * through its multichain API, or any wallet of the Bitcoin wallet standard (Xverse, Unisat…). It
 * only signs its own inputs: the refund of a payment is signed by this wallet, with a key of the
 * account (`refundKey` of the SDK). Its keys never reach Tesserax. */

import { getDefaultTransport, getMultichainClient, isMetamaskInstalled } from "@metamask/multichain-api-client";
import type { BitcoinNetwork } from "@tesserax/sdk";
import { getWallets } from "@wallet-standard/core";
import { hex } from "./evm";
import type { Network } from "./networks";

/** The Bitcoin network of a Tesserax network, through its Esplora API. */
export const bitcoinNetworkOf = (network: Network): BitcoinNetwork => network.bitcoinNetwork ?? (network.id === "mainnet" ? "bitcoin" : "testnet4");

/** Transactions on mempool.space. */
export const bitcoinTxUrl = (network: BitcoinNetwork, txid: string) =>
  network === "bitcoin" ? `https://mempool.space/tx/${txid}` : network === "regtest" ? `http://127.0.0.1:3002/tx/${txid}/status` : `https://mempool.space/testnet4/tx/${txid}`;

/** A Bitcoin wallet connected: its paying address, and the signature of its inputs of a PSBT. */
export interface BitcoinPayer {
  name: string;
  address: string;
  /** Sign the inputs `inputs` of `psbt` as it is, without changing it. Returns the signed PSBT. */
  sign(psbt: Uint8Array, inputs: number[]): Promise<Uint8Array>;
}

/** CAIP-2 scopes of the Bitcoin networks in MetaMask. */
const METAMASK_SCOPES: Record<BitcoinNetwork, string> = {
  bitcoin: "bip122:000000000019d6689c085ae165831e93",
  testnet4: "bip122:00000000da84f2bafbbc53dee25a72ae",
  regtest: "bip122:regtest",
};

const base64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

type Standard = {
  name: string;
  features: Record<string, any>;
};

/** Wallets of the Bitcoin wallet standard that sign transactions, MetaMask aside. */
function standardWallets(): Standard[] {
  return (getWallets().get() as unknown as Standard[]).filter(
    (w) => "bitcoin:connect" in w.features && "bitcoin:signTransaction" in w.features && !/metamask/i.test(w.name),
  );
}

/** Names of the Bitcoin wallets of this browser. */
export async function bitcoinWallets(): Promise<string[]> {
  const names = standardWallets().map((w) => w.name);
  if (await isMetamaskInstalled({ timeout: 500 }).catch(() => false)) names.unshift("MetaMask");
  return names;
}

async function connectMetaMask(network: BitcoinNetwork): Promise<BitcoinPayer> {
  const client = getMultichainClient({ transport: getDefaultTransport() }) as any;
  const scope = METAMASK_SCOPES[network];
  let session = await client.getSession();
  if (!session?.sessionScopes?.[scope]?.accounts?.length) {
    session = await client.createSession({
      optionalScopes: { [scope]: { methods: [], notifications: [] } },
      sessionProperties: { bip122_accountChanged_notifications: true },
    });
  }
  const account: string | undefined = session?.sessionScopes?.[scope]?.accounts?.[0];
  if (!account) throw new Error(`MetaMask gave no Bitcoin account on ${network === "bitcoin" ? "Bitcoin" : "Bitcoin testnet4"}: enable it in MetaMask.`);
  const address = account.split(":").pop()!;
  return {
    name: "MetaMask",
    address,
    async sign(psbt) {
      const result = await client.invokeMethod({
        scope,
        request: { method: "signPsbt", params: { psbt: base64(psbt), options: { fill: false, broadcast: false }, account: { address } } },
      });
      return fromBase64(result.psbt);
    },
  };
}

async function connectStandard(wallet: Standard, network: BitcoinNetwork): Promise<BitcoinPayer> {
  const { accounts } = await wallet.features["bitcoin:connect"].connect({ purposes: ["payment"] });
  const account = accounts?.[0];
  if (!account) throw new Error(`${wallet.name} gave no Bitcoin account.`);
  return {
    name: wallet.name,
    address: account.address,
    async sign(psbt, inputs) {
      const [result] = await wallet.features["bitcoin:signTransaction"].signTransaction({
        psbt,
        inputsToSign: [{ account, signingIndexes: inputs, sigHash: "ALL" }],
        chain: network === "bitcoin" ? "bitcoin:mainnet" : `bitcoin:${network}`,
      });
      return new Uint8Array(result.signedPsbt);
    },
  };
}

/** Connect the Bitcoin wallet `name` of this browser (MetaMask, by default the first one). */
export async function connectBitcoin(network: BitcoinNetwork, name?: string): Promise<BitcoinPayer> {
  if (!name || name === "MetaMask") {
    if (await isMetamaskInstalled({ timeout: 500 }).catch(() => false)) return connectMetaMask(network);
    if (name) throw new Error("MetaMask is not in this browser.");
  }
  const wallet = standardWallets().find((w) => !name || w.name === name);
  if (!wallet) throw new Error("No Bitcoin wallet in this browser: install one, such as MetaMask, Xverse or Unisat, to pay in BTC.");
  return connectStandard(wallet, network);
}

/** The compressed key of the payout of a Bitcoin offer, as hexadecimal. */
export const keyHex = (key: Uint8Array) => hex(key).slice(2);
