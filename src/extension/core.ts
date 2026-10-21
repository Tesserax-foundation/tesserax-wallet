/**
 * The background logic of the extension, apart from the browser API so that it can be tested:
 * which sites are connected to which accounts, and the requests that wait for the user.
 *
 * A site sees nothing until the user connects it, and then only the accounts chosen. Every
 * signature is approved by the user in a window of the extension, one request per site at a time.
 */

import {
  ERRORS,
  ProviderError,
  validateParams,
  isMethod,
  type Connection,
  type Method,
  type Params,
  type PendingRequest,
  type ProviderAccount,
  type ProviderEvent,
} from "./protocol";

export interface CoreDeps {
  loadConnections(): Promise<Record<string, Connection>>;
  saveConnections(connections: Record<string, Connection>): Promise<void>;
  /** Accounts of the wallet, which may have changed since a site connected. */
  walletAccounts(): Promise<ProviderAccount[]>;
  /** Open the approval window of request `id`; its window id. */
  openApproval(id: string): Promise<number | undefined>;
  focusWindow(windowId: number): void;
  closeWindow(windowId: number): void;
  sendToTab(tabId: number, event: ProviderEvent): void;
  newId(): string;
  now(): number;
}

interface Pending extends PendingRequest {
  tabId: number;
  windowId?: number;
  resolve(value: unknown): void;
  reject(error: ProviderError): void;
}

const rejected = () => new ProviderError(ERRORS.rejected, "The user rejected the request");

export class Core {
  readonly #pending = new Map<string, Pending>();
  /** Tabs where each site asked something, to tell them about changes. */
  readonly #tabs = new Map<string, Set<number>>();

  constructor(private readonly deps: CoreDeps) {}

  /** A request of the page at `origin`, in tab `tabId`. */
  async request(origin: string, tabId: number, method: unknown, rawParams: unknown): Promise<unknown> {
    if (!isMethod(method)) throw new ProviderError(ERRORS.unsupported, `unsupported method ${String(method)}`);
    const params = validateParams(method, rawParams);
    this.#track(origin, tabId);
    const accounts = await this.connectedAccounts(origin);
    switch (method) {
      case "tesserax_accounts":
        return accounts;
      case "tesserax_disconnect":
        await this.disconnect(origin);
        return null;
      case "tesserax_requestAccounts":
        return accounts.length > 0 ? accounts : this.#approve(origin, tabId, method, params);
      default:
        if (accounts.length === 0) throw new ProviderError(ERRORS.unauthorized, "Connect first with tesserax_requestAccounts");
        if (!accounts.some((a) => a.address === params.from)) throw new ProviderError(ERRORS.unauthorized, "This account is not connected to this site");
        return this.#approve(origin, tabId, method, params);
    }
  }

  /** The accounts connected to `origin` that are still in the wallet. */
  async connectedAccounts(origin: string): Promise<ProviderAccount[]> {
    const connection = (await this.deps.loadConnections())[origin];
    if (!connection) return [];
    const wallet = await this.deps.walletAccounts();
    return connection.accounts.map((address) => wallet.find((a) => a.address === address)).filter((a): a is ProviderAccount => Boolean(a));
  }

  #approve(origin: string, tabId: number, method: Method, params: Params): Promise<unknown> {
    const waiting = [...this.#pending.values()].find((p) => p.origin === origin);
    if (waiting) {
      if (waiting.windowId !== undefined) this.deps.focusWindow(waiting.windowId);
      throw new ProviderError(ERRORS.pending, "A request of this site already waits for approval");
    }
    const id = this.deps.newId();
    return new Promise((resolve, reject) => {
      const pending: Pending = { id, origin, method, params, tabId, resolve, reject };
      this.#pending.set(id, pending);
      this.deps.openApproval(id).then(
        (windowId) => {
          pending.windowId = windowId;
          // The request may have ended while the window opened.
          if (!this.#pending.has(id) && windowId !== undefined) this.deps.closeWindow(windowId);
        },
        () => {
          this.#pending.delete(id);
          reject(new ProviderError(ERRORS.internal, "The wallet could not open its approval window"));
        },
      );
    });
  }

  /** What the approval window shows. */
  approval(id: string): PendingRequest | null {
    const pending = this.#pending.get(id);
    return pending ? { id, origin: pending.origin, method: pending.method, params: pending.params } : null;
  }

  /** The user approved: `result` goes to the site. For a connection, it is the addresses chosen. */
  async resolve(id: string, result: unknown): Promise<void> {
    const pending = this.#take(id);
    if (pending.method !== "tesserax_requestAccounts") {
      pending.resolve(result);
      return;
    }
    const wallet = await this.deps.walletAccounts();
    const chosen = Array.isArray(result) ? result : [];
    const accounts = wallet.filter((a) => chosen.includes(a.address));
    if (accounts.length === 0 || accounts.length !== chosen.length) {
      pending.reject(new ProviderError(ERRORS.invalidParams, "No account of the wallet chosen"));
      return;
    }
    const connections = await this.deps.loadConnections();
    connections[pending.origin] = { accounts: accounts.map((a) => a.address), connectedAt: this.deps.now() };
    await this.deps.saveConnections(connections);
    pending.resolve(accounts);
    this.#notify(pending.origin, accounts, pending.tabId);
  }

  reject(id: string, error?: { code: number; message: string }): void {
    const pending = this.#take(id);
    pending.reject(error ? new ProviderError(error.code, error.message) : rejected());
  }

  /** The approval window closed: what it did not answer is rejected. */
  windowClosed(windowId: number): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.windowId === windowId) {
        this.#pending.delete(pending.id);
        pending.reject(rejected());
      }
    }
  }

  /** The tab of a site closed: its request is dropped, with its window. */
  tabClosed(tabId: number): void {
    for (const pending of [...this.#pending.values()]) {
      if (pending.tabId === tabId) {
        this.#pending.delete(pending.id);
        pending.reject(rejected());
        if (pending.windowId !== undefined) this.deps.closeWindow(pending.windowId);
      }
    }
    for (const tabs of this.#tabs.values()) tabs.delete(tabId);
  }

  async connections(): Promise<Record<string, Connection>> {
    return this.deps.loadConnections();
  }

  /** The wallet was deleted: no site stays connected. */
  async disconnectAll(): Promise<void> {
    const connections = await this.deps.loadConnections();
    await this.deps.saveConnections({});
    for (const origin of Object.keys(connections)) this.#notify(origin, []);
  }

  async disconnect(origin: string): Promise<void> {
    const connections = await this.deps.loadConnections();
    if (!connections[origin]) return;
    delete connections[origin];
    await this.deps.saveConnections(connections);
    this.#notify(origin, []);
  }

  #take(id: string): Pending {
    const pending = this.#pending.get(id);
    if (!pending) throw new ProviderError(ERRORS.internal, "This request is no longer waiting");
    this.#pending.delete(id);
    return pending;
  }

  #track(origin: string, tabId: number) {
    const tabs = this.#tabs.get(origin) ?? new Set();
    tabs.add(tabId);
    this.#tabs.set(origin, tabs);
  }

  /** Tell the tabs of `origin`, except `except`, which already has the answer. */
  #notify(origin: string, accounts: ProviderAccount[], except?: number) {
    for (const tabId of this.#tabs.get(origin) ?? []) {
      if (tabId !== except) this.deps.sendToTab(tabId, { type: "provider:event", origin, event: "accountsChanged", data: accounts });
    }
  }
}
