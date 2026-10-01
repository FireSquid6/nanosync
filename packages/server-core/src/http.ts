import { PROTOCOL_VERSION, type ProtocolErrorCode } from "@nanosync/protocol";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: ProtocolErrorCode, message: string, readonly headers?: ConstructorParameters<typeof Headers>[0], readonly retryAfterSeconds?: number) {
    super(message); this.name = "ApiError";
  }
}

export function json(value: unknown, status = 200, headers?: ConstructorParameters<typeof Headers>[0]): Response {
  const output = new Headers(headers);
  output.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { status, headers: output });
}

export function errorResponse(error: unknown): Response {
  const known = error instanceof ApiError ? error : new ApiError(500, "INTERNAL", "Request failed");
  const message = safePublicMessage(known.message) ? known.message : "Request failed";
  const body: Record<string, unknown> = { protocolVersion: PROTOCOL_VERSION, code: known.code, message };
  if (known.retryAfterSeconds !== undefined) body.retryAfterSeconds = known.retryAfterSeconds;
  return json(body, known.status, known.headers);
}

export async function readStrictJson(request: Request, maximumBytes: number): Promise<unknown> {
  const declared = request.headers.get("content-length");
  if (declared !== null && !/^(0|[1-9]\d*)$/.test(declared)) { cancelBodyNoWait(request.body); throw new ApiError(400, "MALFORMED_REQUEST", "Content-Length is invalid"); }
  const declaredLength = declared === null ? null : Number(declared);
  if (declaredLength !== null && declaredLength > maximumBytes) { cancelBodyNoWait(request.body); throw new ApiError(413, "BODY_LIMIT_EXCEEDED", "JSON body exceeds the request limit"); }
  if (!request.body) throw new ApiError(400, "MALFORMED_REQUEST", "A JSON request body is required");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      if (next.value.byteLength > maximumBytes - length) throw new ApiError(413, "BODY_LIMIT_EXCEEDED", "JSON body exceeds the request limit");
      if (declaredLength !== null && next.value.byteLength > declaredLength - length) throw new ApiError(400, "MALFORMED_REQUEST", "JSON body length does not match Content-Length");
      const copy = new Uint8Array(next.value.byteLength); copy.set(next.value); chunks.push(copy); length += copy.byteLength;
    }
    if (declaredLength !== null && length !== declaredLength) throw new ApiError(400, "MALFORMED_REQUEST", "JSON body length does not match Content-Length");
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let source: string;
    try { source = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { throw new ApiError(400, "MALFORMED_REQUEST", "JSON body is not valid UTF-8"); }
    try { return new StrictJsonParser(source).parse(); }
    catch (error) { if (error instanceof ApiError) throw error; throw new ApiError(400, "MALFORMED_REQUEST", "JSON body is malformed"); }
  } catch (error) {
    cancelReaderNoWait(reader);
    throw error;
  } finally { reader.releaseLock(); }
}

class StrictJsonParser {
  private index = 0;
  constructor(private readonly source: string) {}
  parse(): unknown { const value = this.value(); this.space(); if (this.index !== this.source.length) this.bad(); return value; }
  private value(): unknown {
    this.space(); const char = this.source[this.index];
    if (char === "{") return this.object(); if (char === "[") return this.array(); if (char === '"') return this.string();
    if (this.source.startsWith("true", this.index)) { this.index += 4; return true; }
    if (this.source.startsWith("false", this.index)) { this.index += 5; return false; }
    if (this.source.startsWith("null", this.index)) { this.index += 4; return null; }
    return this.number();
  }
  private object(): Record<string, unknown> {
    this.index++; const result: Record<string, unknown> = Object.create(null); const keys = new Set<string>(); this.space();
    if (this.take("}")) return result;
    while (true) {
      this.space(); if (this.source[this.index] !== '"') this.bad(); const key = this.string();
      if (keys.has(key)) throw new ApiError(400, "MALFORMED_REQUEST", "JSON object contains a duplicate key"); keys.add(key);
      this.space(); if (!this.take(":")) this.bad(); result[key] = this.value(); this.space();
      if (this.take("}")) return result; if (!this.take(",")) this.bad();
    }
  }
  private array(): unknown[] {
    this.index++; const result: unknown[] = []; this.space(); if (this.take("]")) return result;
    while (true) { result.push(this.value()); this.space(); if (this.take("]")) return result; if (!this.take(",")) this.bad(); }
  }
  private string(): string {
    const start = this.index++; let escaped = false;
    while (this.index < this.source.length) {
      const code = this.source.charCodeAt(this.index); const char = this.source[this.index++]!;
      if (!escaped && char === '"') {
        const value = JSON.parse(this.source.slice(start, this.index)) as string;
        if (hasUnpairedSurrogate(value)) this.bad(); return value;
      }
      if (!escaped && code < 0x20) this.bad();
      if (!escaped && char === "\\") escaped = true; else escaped = false;
    }
    return this.bad();
  }
  private number(): number {
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.source.slice(this.index));
    if (!match) return this.bad(); this.index += match[0].length; const value = Number(match[0]);
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) this.bad(); return value;
  }
  private space(): void { while (this.source[this.index] === " " || this.source[this.index] === "\t" || this.source[this.index] === "\r" || this.source[this.index] === "\n") this.index++; }
  private take(value: string): boolean { if (this.source[this.index] !== value) return false; this.index++; return true; }
  private bad(): never { throw new ApiError(400, "MALFORMED_REQUEST", "JSON body is malformed"); }
}
function hasUnpairedSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) { const c = value.charCodeAt(i); if (c >= 0xd800 && c <= 0xdbff) { const n = value.charCodeAt(++i); if (n < 0xdc00 || n > 0xdfff) return true; } else if (c >= 0xdc00 && c <= 0xdfff) return true; } return false;
}
function safePublicMessage(value: string): boolean {
  return value.length > 0 && !hasUnpairedSurrogate(value) && new TextEncoder().encode(value).byteLength <= 512 && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function cancelReaderNoWait(reader: { cancel(reason?: unknown): Promise<void> }): void { try { void reader.cancel().catch(() => undefined); } catch {} }
function cancelBodyNoWait(body: ReadableStream<Uint8Array> | null): void { if (body) try { void body.cancel().catch(() => undefined); } catch {} }
