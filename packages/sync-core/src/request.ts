/** A response-lifetime deadline using baseline Web APIs (including Android 12
 * WebView). Do not require AbortSignal.any/timeout/throwIfAborted or materialize
 * streaming request bodies as Request objects in a custom transport. */
export async function fetchWithDeadline(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  url: string,
  init: RequestInit,
  ownerSignal?: AbortSignal,
  timeoutMs = 30_000,
): Promise<Response> {
  const controller = new AbortController();
  const parents = [...new Set([ownerSignal, init.signal].filter((signal): signal is AbortSignal => !!signal))];
  const listeners: (() => void)[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: Pick<ReadableStreamDefaultReader<Uint8Array>, "read" | "cancel" | "releaseLock"> | undefined;
  let output: ReadableStreamDefaultController<Uint8Array> | undefined;
  let finished = false;
  let failure: unknown;
  const cleanup = () => {
    if (timer !== undefined) clearTimeout(timer);
    for (let i = 0; i < parents.length; i++) parents[i]!.removeEventListener("abort", listeners[i]!);
  };
  const release = () => { try { reader?.releaseLock(); } catch { /* pending cancellation releases it below */ } };
  const abort = (reason: unknown) => {
    if (controller.signal.aborted || finished) return;
    failure = reason;
    controller.abort(reason);
    cleanup();
    if (output) {
      finished = true;
      output.error(reason);
      void reader?.cancel(reason).catch(() => {}).finally(release);
    }
  };
  for (const parent of parents) {
    const listener = () => abort(parent.reason ?? new DOMException("The operation was aborted", "AbortError"));
    listeners.push(listener);
    parent.addEventListener("abort", listener, { once: true });
  }
  for (const parent of parents) if (parent.aborted) abort(parent.reason ?? new DOMException("The operation was aborted", "AbortError"));
  if (controller.signal.aborted) { cleanup(); throw failure; }
  timer = setTimeout(() => abort(new DOMException("Request deadline reached", "TimeoutError")), timeoutMs);
  // Like AbortSignal.timeout, a deadline must not keep a finished CLI alive.
  (timer as typeof timer & { unref?: () => unknown }).unref?.();
  try {
    const response = await fetcher(url, { ...init, signal: controller.signal });
    if (controller.signal.aborted) {
      void response.body?.cancel(failure).catch(() => {});
      throw failure;
    }
    if (!response.body) { finished = true; cleanup(); return response; }
    reader = response.body.getReader();
    const body = new ReadableStream<Uint8Array>({
      start(target) { output = target; },
      async pull(target) {
        try {
          const item = await reader!.read();
          if (finished) return;
          if (item.done) {
            finished = true; cleanup(); release(); target.close();
          } else target.enqueue(item.value);
        } catch (error) {
          if (finished) return;
          finished = true; cleanup(); release(); target.error(error);
        }
      },
      async cancel(reason) {
        finished = true; cleanup();
        try { await reader!.cancel(reason); } finally { release(); }
      },
    });
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  } catch (error) {
    cleanup();
    throw controller.signal.aborted ? failure : error;
  }
}
