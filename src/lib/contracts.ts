/** Smart contracts in the wallet: their ABI, the values typed in forms, and what they return.
 *
 * Values follow the TypeScript SDK (viem): integers are `bigint`, `address` a `0x` string,
 * `bytes` a `0x` string, arrays and tuples arrays. An `address` may also be typed as a Tesserax
 * address (`te...`): it becomes the address of that account in contracts. */

import { parseAddress, toH160 } from "@tesserax/sdk";
import type { StoredContract } from "./storage";

export interface AbiParameter {
  name?: string;
  type: string;
  components?: AbiParameter[];
  indexed?: boolean;
}

export interface AbiItem {
  type: string;
  name?: string;
  inputs?: AbiParameter[];
  outputs?: AbiParameter[];
  stateMutability?: "pure" | "view" | "nonpayable" | "payable";
}

export type Abi = AbiItem[];

/** The ABI in `text`, the JSON `resolc` and `solc` write, or the object of their output with an
 * `abi` field. */
export function parseAbi(text: string): Abi {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Not JSON: paste the ABI, the .abi.json file of the contract.");
  }
  if (value && !Array.isArray(value) && typeof value === "object" && Array.isArray((value as { abi?: unknown }).abi)) {
    value = (value as { abi: unknown[] }).abi;
  }
  if (!Array.isArray(value) || !value.every((item) => item && typeof item === "object" && typeof (item as AbiItem).type === "string")) {
    throw new Error("Not an ABI: a JSON array of functions, events and errors.");
  }
  return value as Abi;
}

export const isFunction = (item: AbiItem) => item.type === "function" && Boolean(item.name);
export const isRead = (item: AbiItem) => isFunction(item) && (item.stateMutability === "view" || item.stateMutability === "pure");
export const isWrite = (item: AbiItem) => isFunction(item) && !isRead(item);
export const constructorOf = (abi: Abi) => abi.find((item) => item.type === "constructor");

/** `name(type,type)`: functions may share a name. */
export const signature = (item: AbiItem) => `${item.name}(${(item.inputs ?? []).map((p) => p.type).join(",")})`;

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const HEX = /^0x([0-9a-fA-F]{2})*$/;

/** The address of a contract or of an account in contracts, checksummed, from `0x...` or
 * `te...`, or null. */
export function contractAddress(text: string): string | null {
  const value = text.trim();
  if (ADDRESS.test(value)) {
    // The account of an address, its 20 bytes then twelve 0xEE, maps back to it, checksummed.
    const account = new Uint8Array(32).fill(0xee);
    for (let i = 0; i < 20; i++) account[i] = parseInt(value.slice(2 + 2 * i, 4 + 2 * i), 16);
    return toH160(account);
  }
  try {
    return toH160(parseAddress(value));
  } catch {
    return null;
  }
}

function integer(type: string, value: unknown): bigint {
  const text = typeof value === "bigint" || typeof value === "number" ? String(value) : String(value ?? "").trim().replace(/[_\s]/g, "");
  if (!/^-?(\d+|0x[0-9a-fA-F]+)$/.test(text)) throw new Error("an integer");
  const n = text.startsWith("-") ? -BigInt(text.slice(1)) : BigInt(text);
  const bits = Number(type.replace(/^u?int/, "") || 256);
  const [min, max] = type.startsWith("u") ? [0n, (1n << BigInt(bits)) - 1n] : [-(1n << BigInt(bits - 1)), (1n << BigInt(bits - 1)) - 1n];
  if (n < min || n > max) throw new Error(`out of the range of ${type}`);
  return n;
}

/** The value of `parameter` from `value`, the text of a field or an element of JSON. */
export function argument(parameter: AbiParameter, value: unknown): unknown {
  const type = parameter.type;
  const array = /^(.*)\[(\d*)\]$/.exec(type);
  if (array || type === "tuple") {
    let parsed = value;
    if (typeof value === "string") {
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(array ? `a JSON array, such as ["1", "2"]` : "a JSON array of the fields");
      }
    }
    if (array) {
      if (!Array.isArray(parsed)) throw new Error("a JSON array");
      if (array[2] && parsed.length !== Number(array[2])) throw new Error(`${array[2]} elements`);
      return parsed.map((element) => argument({ ...parameter, type: array[1] }, element));
    }
    const components = parameter.components ?? [];
    const fields = Array.isArray(parsed) ? parsed : components.map((c) => (parsed as Record<string, unknown>)?.[c.name ?? ""]);
    if (fields.length !== components.length) throw new Error(`${components.length} fields`);
    return components.map((component, i) => argument(component, fields[i]));
  }
  if (type === "address") {
    const address = contractAddress(String(value ?? ""));
    if (!address) throw new Error("an address: 0x and 40 digits, or a Tesserax address te…");
    return address;
  }
  if (type === "bool") {
    const text = String(value).trim().toLowerCase();
    if (text !== "true" && text !== "false") throw new Error("true or false");
    return text === "true";
  }
  if (/^u?int\d*$/.test(type)) return integer(type, value);
  if (type === "string") return String(value ?? "");
  if (/^bytes\d*$/.test(type)) {
    const text = String(value ?? "").trim();
    if (!HEX.test(text)) throw new Error("hexadecimal bytes: 0x…");
    const size = Number(type.slice(5));
    if (size && text.length !== 2 + 2 * size) throw new Error(`${size} bytes`);
    return text;
  }
  throw new Error(`the type ${type} is not supported here`);
}

/** The arguments of `inputs` from the texts of their fields: the values, or the error of each
 * field. */
export function argumentsOf(inputs: AbiParameter[], texts: string[]): { values?: unknown[]; errors: Array<string | null> } {
  const values: unknown[] = [];
  const errors = inputs.map((input, i) => {
    try {
      values.push(argument(input, texts[i] ?? ""));
      return null;
    } catch (error) {
      return `Expected ${(error as Error).message}.`;
    }
  });
  return errors.some(Boolean) ? { errors } : { values, errors };
}

/** What a placeholder suggests for a value of `type`. */
export function placeholder(type: string): string {
  if (type.endsWith("]")) return '["…", "…"]';
  if (type === "tuple") return '["…", "…"]';
  if (type === "address") return "0x… or te…";
  if (type === "bool") return "true or false";
  if (/^u?int/.test(type)) return "0";
  if (type.startsWith("bytes")) return "0x…";
  return "";
}

/** A value returned by a contract, as text. */
export function display(value: unknown): string {
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return value;
  if (value instanceof Uint8Array) return "0x" + Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) ?? String(value);
}

/** The outputs of a function, by name: one value, or the elements of the array the SDK returns
 * for several outputs. */
export function outputs(item: AbiItem, result: unknown): Array<[string, string]> {
  const declared = item.outputs ?? [];
  if (declared.length <= 1) return [[declared[0]?.name || declared[0]?.type || "result", display(result)]];
  const values = result as unknown[];
  return declared.map((output, i) => [output.name || output.type, display(values[i])]);
}

export type { StoredContract };
