import { expect, test } from "bun:test";
import { Bridge, nativeFetch, toBase64, fromBase64 } from "./bridge.ts";

test("binary encoding is chunk bounded and preserves non-ASCII bytes", () => {
  const bytes = crypto.getRandomValues(new Uint8Array(65536));
  expect(fromBase64(toBase64(bytes))).toEqual(bytes);
});
test("native HTTP never delegates fetch or permits another origin", async () => {
  const calls: unknown[] = [];
  const bridge = new Bridge({ sync: () => '{"ok":true,"value":{}}', request(method, json, id) {
    calls.push([method, JSON.parse(json)]);
    queueMicrotask(() => bridge.complete(id, { ok: true, value: { status: 200, headers: { "content-type": "application/octet-stream" }, bodyBase64: "AP8=" } }));
  }, event() {}, finish() {}, fail() {} });
  const fetcher = nativeFetch(bridge, "https://example.org");
  expect(new Uint8Array(await (await fetcher("https://example.org/v1/test")).arrayBuffer())).toEqual(new Uint8Array([0, 255]));
  expect(calls).toEqual([["http", { path: "/v1/test", method: "GET", headers: {} }]]);
  await expect(fetcher("https://other.org/v1/test")).rejects.toThrow();
});
test("bridge errors and timed-out requests reject without accepting late completions", async () => {
  const bridge = new Bridge({ sync: () => '{"ok":false,"error":"denied"}', request() {}, event() {}, finish() {}, fail() {} }, 5);
  expect(() => bridge.sync("journalRead")).toThrow("denied");
  await expect(bridge.call("list")).rejects.toThrow("timed out");
  bridge.complete("unknown", { ok: true, value: null });
});
