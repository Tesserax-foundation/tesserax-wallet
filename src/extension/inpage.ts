/**
 * `window.tesserax`, in the world of every page: the provider web applications call.
 *
 * ```ts
 * const [account] = await window.tesserax.request({ method: "tesserax_requestAccounts" });
 * const { txHash } = await window.tesserax.request({
 *   method: "tesserax_transfer",
 *   params: { from: account.address, to: "te…", amount: "1.5" },
 * });
 * ```
 */

import { TO_CONTENT, TO_PAGE } from "./protocol";

class ProviderRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

type Listener = (data: unknown) => void;

if (!("tesserax" in window)) {
  const waiting = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const listeners = new Map<string, Set<Listener>>();

  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as { target?: string; id?: string; result?: unknown; error?: { code: number; message: string }; event?: string } | null;
    if (data?.target !== TO_PAGE) return;
    if (data.event) {
      for (const listener of listeners.get(data.event) ?? []) listener((data as { data?: unknown }).data);
      return;
    }
    const request = data.id ? waiting.get(data.id) : undefined;
    if (!request) return;
    waiting.delete(data.id!);
    if (data.error) request.reject(new ProviderRpcError(data.error.code, data.error.message));
    else request.resolve(data.result);
  });

  const provider = Object.freeze({
    isTesserax: true,
    version: "0.1.0",
    request({ method, params }: { method: string; params?: Record<string, string> }): Promise<unknown> {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        waiting.set(id, { resolve, reject });
        window.postMessage({ target: TO_CONTENT, id, method, params }, location.origin);
      });
    },
    /** `accountsChanged`: the accounts the site may use changed, or it was disconnected (`[]`). */
    on(event: string, listener: Listener) {
      const set = listeners.get(event) ?? new Set();
      set.add(listener);
      listeners.set(event, set);
    },
    removeListener(event: string, listener: Listener) {
      listeners.get(event)?.delete(listener);
    },
  });

  Object.defineProperty(window, "tesserax", { value: provider, writable: false, configurable: false, enumerable: true });
  window.dispatchEvent(new Event("tesserax#initialized"));
}
