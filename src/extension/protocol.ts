/**
 * The provider protocol of the extension: what web pages may ask through `window.tesserax`, and
 * the checks every request goes through before the wallet shows it.
 *
 * Errors carry codes in the style of EIP-1193, which wallet libraries already handle.
 */

export const METHODS = [
  "tesserax_requestAccounts",
  "tesserax_accounts",
  "tesserax_disconnect",
  "tesserax_transfer",
  "tesserax_payAgent",
  "tesserax_openChannel",
  "tesserax_signVoucher",
  "tesserax_signMessage",
] as const;

export type Method = (typeof METHODS)[number];

/** Methods the user approves in a window of the extension. */
export const SIGNING_METHODS: readonly Method[] = ["tesserax_transfer", "tesserax_payAgent", "tesserax_openChannel", "tesserax_signVoucher", "tesserax_signMessage"];

export const isMethod = (value: unknown): value is Method => typeof value === "string" && (METHODS as readonly string[]).includes(value);

export const ERRORS = {
  /** The user rejected the request. */
  rejected: 4001,
  /** The site is not connected, or not to this account. */
  unauthorized: 4100,
  unsupported: 4200,
  invalidParams: -32602,
  /** Another request of the site waits for the user. */
  pending: -32002,
  internal: -32603,
} as const;

export class ProviderError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }

  toJSON() {
    return { code: this.code, message: this.message };
  }
}

/** An account as sites see it. */
export interface ProviderAccount {
  address: string;
  name: string;
}

/** The accounts a site may see and ask to sign with. */
export interface Connection {
  accounts: string[];
  connectedAt: number;
}

/** A request waiting in the approval window. */
export interface PendingRequest {
  id: string;
  origin: string;
  method: Method;
  params: Params;
}

export type Params = Record<string, string>;

/** Domain separation of signed messages from transactions ("tesserax") and vouchers ("tesserax-channel"). */
export const MESSAGE_CONTEXT = new TextEncoder().encode("tesserax-message");

const ADDRESS = /^te[1-9A-HJ-NP-Za-km-z]{44,48}$/;
const AMOUNT = /^(?!0+(\.0+)?$)\d{1,20}(\.\d{1,12})?$/;
const INTEGER = /^\d{1,20}$/;

type Rule = (value: string) => boolean;
const address: Rule = (v) => ADDRESS.test(v);
const amount: Rule = (v) => AMOUNT.test(v);
const integer: Rule = (v) => INTEGER.test(v);
const message: Rule = (v) => v.length > 0 && v.length <= 4096;

/** Parameters of each method: required, then optional. */
const SCHEMAS: Record<Method, { required: Record<string, Rule>; optional?: Record<string, Rule> }> = {
  tesserax_requestAccounts: { required: {} },
  tesserax_accounts: { required: {} },
  tesserax_disconnect: { required: {} },
  tesserax_transfer: { required: { from: address, to: address, amount }, optional: { owner: address } },
  tesserax_payAgent: { required: { from: address, agent: address, amount }, optional: { owner: address } },
  tesserax_openChannel: { required: { from: address, payee: address, deposit: amount }, optional: { owner: address } },
  tesserax_signVoucher: { required: { from: address, channel: integer, amount } },
  tesserax_signMessage: { required: { from: address, message } },
};

/**
 * The parameters of a request, checked: an object of strings with exactly the keys its method
 * takes. Amounts are decimal strings of TESS, such as "1.5".
 */
export function validateParams(method: Method, params: unknown): Params {
  const schema = SCHEMAS[method];
  const value = params ?? {};
  if (typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new ProviderError(ERRORS.invalidParams, "params must be an object");
  }
  const checked: Params = {};
  for (const [key, field] of Object.entries(value)) {
    const rule = schema.required[key] ?? schema.optional?.[key];
    if (!rule) throw new ProviderError(ERRORS.invalidParams, `unknown parameter ${key}`);
    if (field === undefined) continue;
    if (typeof field !== "string" || !rule(field)) throw new ProviderError(ERRORS.invalidParams, `invalid parameter ${key}`);
    checked[key] = field;
  }
  for (const key of Object.keys(schema.required)) {
    if (!(key in checked)) throw new ProviderError(ERRORS.invalidParams, `missing parameter ${key}`);
  }
  return checked;
}

/** Sites may connect over HTTPS, or over HTTP from this computer during development. */
export function allowedOrigin(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const { protocol, hostname, origin } = new URL(url);
    if (protocol === "https:") return origin;
    if (protocol === "http:" && (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost"))) return origin;
  } catch {
    // Not a URL.
  }
  return null;
}

// Messages between the parts of the extension.

/** Window messages between the page and the content script. */
export const TO_CONTENT = "tesserax:to-content";
export const TO_PAGE = "tesserax:to-page";

export type ExtensionMessage =
  | { type: "provider:request"; method: string; params?: unknown }
  | { type: "approval:get"; id: string }
  | { type: "approval:resolve"; id: string; result: unknown }
  | { type: "approval:reject"; id: string; error?: { code: number; message: string } }
  | { type: "approval:ping" }
  | { type: "connections:list" }
  | { type: "connections:disconnect"; origin: string }
  | { type: "connections:clear" };

/** From the background to the content scripts of a site. */
export interface ProviderEvent {
  type: "provider:event";
  origin: string;
  event: "accountsChanged";
  data: ProviderAccount[];
}
