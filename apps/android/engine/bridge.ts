export interface NativeHost {
  sync(method: string, json: string): string;
  request(method: string, json: string, id: string): void;
  event(json: string): void;
  finish(json: string): void;
  fail(message: string): void;
}
type Result = { ok: true; value: unknown } | { ok: false; error: string };
function unwrap(result: Result): unknown {
  if (!result || result.ok !== true) throw new Error(result && "error" in result ? String(result.error) : "invalid native response");
  return result.value;
}
export class Bridge {
  private pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
  constructor(readonly host: NativeHost, private timeout = 120_000) {}
  sync<T>(method: string, args: unknown = {}): T { return unwrap(JSON.parse(this.host.sync(method, JSON.stringify(args)))) as T; }
  call<T>(method: string, args: unknown = {}): Promise<T> {
    if (this.pending.size >= 16) return Promise.reject(new Error("too many native requests"));
    const id = crypto.randomUUID();
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`native ${method} timed out`)); }, this.timeout);
      this.pending.set(id, { resolve: value => resolve(value as T), reject, timer });
      try { this.host.request(method, JSON.stringify(args), id); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  complete(id: string, result: Result): void {
    const item = this.pending.get(id); if (!item) return;
    clearTimeout(item.timer); this.pending.delete(id);
    try { item.resolve(unwrap(result)); } catch (error) { item.reject(error as Error); }
  }
}
// At most one protocol frame/request, never a whole file. Avoid argument-list limits.
export const MAX_HTTP_BYTES = 8 * 1024 * 1024;
export function toBase64(bytes: Uint8Array): string {
  if (bytes.length > MAX_HTTP_BYTES) throw new Error("binary frame too large");
  let text = "";
  for (let offset = 0; offset < bytes.length; offset += 16384) text += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(text);
}
export function fromBase64(text: string): Uint8Array {
  if (typeof text !== "string" || text.length > Math.ceil(MAX_HTTP_BYTES / 3) * 4) throw new Error("binary frame too large");
  const decoded = atob(text); return Uint8Array.from(decoded, c => c.charCodeAt(0));
}
async function boundedBody(body: ReadableStream<Uint8Array> | null): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader(), parts: Uint8Array[] = []; let length = 0;
  try {
    while (true) {
      const item = await reader.read(); if (item.done) break;
      length += item.value.length; if (length > MAX_HTTP_BYTES) throw new Error("HTTP body too large");
      parts.push(item.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function nativeFetch(bridge: Bridge, baseUrl: string): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  const base = new URL(baseUrl);
  return async (input, init) => {
    const request = new Request(input, init), url = new URL(request.url);
    if (url.origin !== base.origin || !url.pathname.startsWith("/v1/") || url.username || url.password || url.hash) throw new Error("HTTP outside scoped server");
    const headers: Record<string, string> = {}; request.headers.forEach((v, k) => { headers[k] = v; });
    const bytes = await boundedBody(request.body);
    const response = await bridge.call<{ status: number; headers: Record<string, string>; bodyBase64?: string }>("http", {
      path: url.pathname + url.search, method: request.method, headers, ...(bytes.length ? { bodyBase64: toBase64(bytes) } : {}),
    });
    if (response.status >= 300 && response.status < 400) throw new Error("redirect refused");
    return new Response([204, 205, 304].includes(response.status) ? null : new Uint8Array(fromBase64(response.bodyBase64 ?? "")).buffer, { status: response.status, headers: response.headers });
  };
}
