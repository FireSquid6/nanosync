import { expect, test } from "bun:test";
import { Bridge, fromBase64, MAX_HTTP_BYTES, nativeFetch } from "./bridge.ts";

test("native transport preserves raw JSON, bytes and streams when old Request has no body support", async () => {
  const ModernRequest = globalThis.Request;
  class OldRequest extends ModernRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.body instanceof ReadableStream) throw new Error("stream Request construction unsupported");
      super(input, init);
      Object.defineProperty(this, "body", { value: undefined });
    }
  }
  const calls: { path: string; method: string; headers: Record<string, string>; bodyBase64?: string }[] = [];
  const bridge = new Bridge({ sync() { return '{"ok":true,"value":{}}'; }, request(_method, json, id) {
    calls.push(JSON.parse(json)); queueMicrotask(() => bridge.complete(id, { ok: true, value: { status: 200, headers: {}, bodyBase64: "" } }));
  }, event() {}, finish() {}, fail() {} });
  globalThis.Request = OldRequest as typeof Request;
  try {
    const transport = nativeFetch(bridge, "https://example.org");
    const json = '{"protocolVersion":1,"text":"日本語"}';
    const frame = new Uint8Array([0, 255, 1, 128]);
    await transport("https://example.org/v1/json", { method: "POST", headers: { "content-type": "application/json" }, body: json });
    await transport(new URL("https://example.org/v1/bytes"), { method: "PUT", body: frame });
    await transport("https://example.org/v1/buffer", { method: "PUT", body: frame.buffer });
    await transport("https://example.org/v1/stream", { method: "PUT", body: new ReadableStream({ start(controller) { controller.enqueue(frame.subarray(0, 2)); controller.enqueue(frame.subarray(2)); controller.close(); } }) });
    const external = new OldRequest("https://example.org/v1/request", {
      method: "POST", headers: { "content-length": String(new TextEncoder().encode(json).length) }, body: json,
    });
    expect(external.body).toBeUndefined();
    await transport(external);
    expect(calls.map(c => c.path)).toEqual(["/v1/json", "/v1/bytes", "/v1/buffer", "/v1/stream", "/v1/request"]);
    expect(calls[0]!.headers["content-type"]).toBe("application/json");
    expect(new TextDecoder().decode(fromBase64(calls[0]!.bodyBase64!))).toBe(json);
    for (const index of [1, 2, 3]) expect(fromBase64(calls[index]!.bodyBase64!)).toEqual(frame);
    expect(new TextDecoder().decode(fromBase64(calls[4]!.bodyBase64!))).toBe(json);
  } finally { globalThis.Request = ModernRequest; }
});

test("native transport rejects oversized bodies before dispatch and cancels an oversized stream", async () => {
  let dispatched = 0, cancelled = false;
  const bridge = new Bridge({ sync() { return '{"ok":true,"value":{}}'; }, request() { dispatched++; }, event() {}, finish() {}, fail() {} });
  const transport = nativeFetch(bridge, "https://example.org");
  await expect(transport("https://example.org/v1/bytes", { method: "PUT", body: new Uint8Array(MAX_HTTP_BYTES + 1) })).rejects.toThrow("HTTP body too large");
  await expect(transport("https://example.org/v1/stream", { method: "PUT", body: new ReadableStream({ start(c) { c.enqueue(new Uint8Array(MAX_HTTP_BYTES)); c.enqueue(new Uint8Array(1)); }, cancel() { cancelled = true; } }) })).rejects.toThrow("HTTP body too large");
  const declaredOversize = new Request("https://example.org/v1/external", { method: "POST", headers: { "content-length": String(MAX_HTTP_BYTES + 1) }, body: "small" });
  Object.defineProperty(declaredOversize, "body", { value: undefined });
  declaredOversize.arrayBuffer = async () => { throw new Error("must reject declared length before reading"); };
  await expect(transport(declaredOversize)).rejects.toThrow("HTTP body too large");
  const actualOversize = new Request("https://example.org/v1/external", { method: "POST", body: new Uint8Array(MAX_HTTP_BYTES + 1) });
  Object.defineProperty(actualOversize, "body", { value: undefined });
  await expect(transport(actualOversize)).rejects.toThrow("HTTP body too large");
  expect(cancelled).toBe(true); expect(dispatched).toBe(0);
});
