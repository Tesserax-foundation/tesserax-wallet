/**
 * The content script, in the isolated world of every page: it carries the requests of
 * `window.tesserax` to the background, and its answers and events back to the page.
 */

import { extensionApi as api } from "../lib/platform";
import { ERRORS, TO_CONTENT, TO_PAGE, type ProviderEvent } from "./protocol";

const post = (message: Record<string, unknown>) => window.postMessage({ target: TO_PAGE, ...message }, location.origin);

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const data = event.data as { target?: string; id?: unknown; method?: unknown; params?: unknown } | null;
  if (data?.target !== TO_CONTENT || typeof data.id !== "string") return;
  const id = data.id;
  Promise.resolve(api.runtime.sendMessage({ type: "provider:request", method: data.method, params: data.params })).then(
    (response: { result?: unknown; error?: unknown } | undefined) => post({ id, ...(response ?? { error: { code: ERRORS.internal, message: "The wallet does not answer" } }) }),
    () => post({ id, error: { code: ERRORS.internal, message: "The wallet is unavailable: reload the page" } }),
  );
});

api.runtime.onMessage.addListener((message: ProviderEvent) => {
  if (message?.type === "provider:event" && message.origin === location.origin) post({ event: message.event, data: message.data });
});
