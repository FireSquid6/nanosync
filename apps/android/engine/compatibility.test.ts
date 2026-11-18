import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function browserChild(script: string) {
  const root = mkdtempSync(join(tmpdir(), "nanosync-webview-compat-")); roots.push(root);
  for (const entry of ["compatibility", "runtime"]) {
    const result = await Bun.build({ entrypoints: [resolve(import.meta.dir, `${entry}.ts`)], target: "browser", format: "esm" });
    if (!result.success) throw new AggregateError(result.logs);
    await Bun.write(join(root, `${entry}.mjs`), result.outputs[0]!);
  }
  const runner = join(root, "check.mjs"); await Bun.write(runner, script);
  const child = Bun.spawn([process.execPath, runner], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  return stdout;
}

test("browser bundle supports absent Android 12 convenience APIs without replacing WebCrypto", async () => {
  const core = resolve(import.meta.dir, "../../../packages/sync-core/src/index.ts");
  const stdout = await browserChild(`
    import assert from "node:assert/strict";
    const realCrypto = globalThis.crypto;
    let csprngCalls = 0;
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {
      subtle: realCrypto.subtle,
      getRandomValues(bytes) { csprngCalls++; return realCrypto.getRandomValues(bytes); }
    }});
    delete Object.hasOwn;
    delete globalThis.structuredClone;
    const compatibility = await import("./compatibility.mjs");
    assert.deepEqual(compatibility.nativeConveniences, { randomUUID: false, structuredClone: false, objectHasOwn: false });
    assert.deepEqual(compatibility.missingRuntimeFeatures(), []);
    assert.equal(crypto.subtle, realCrypto.subtle);
    const inherited = Object.create({ inherited: true }); inherited.own = undefined;
    assert.equal(Object.hasOwn(inherited, "inherited"), false);
    assert.equal(Object.hasOwn(inherited, "own"), true);
    assert.equal(Object.hasOwn(Object.create(null), "toString"), false);
    const original = { nested: [{ bytes: new Uint8Array([0, 255]) }] }; original.self = original;
    const copy = structuredClone(original); copy.nested[0].bytes[0] = 42;
    assert.equal(original.nested[0].bytes[0], 0); assert.equal(copy.self, copy);
    // No non-cryptographic fallback in browser UUID generation. core-js may use
    // Math.random for internal property-key uniqueness during module loading only.
    const oldRandom = Math.random; Math.random = () => { throw new Error("insecure UUID RNG"); };
    const ids = new Set(Array.from({ length: 100 }, () => compatibility.randomUUID()));
    Math.random = oldRandom;
    assert.equal(ids.size, 100); assert.equal(csprngCalls, 100);
    for (const id of ids) assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array()));
    assert.equal(Buffer.from(digest).toString("hex"), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    const core = await import(${JSON.stringify(core)});
    const bytes = new Uint8Array([1, 0, 255]), key = new Uint8Array(32).fill(7), vault = "123e4567-e89b-42d3-a456-426614174000";
    const object = await core.encryptChunk(bytes, key, vault);
    assert.deepEqual(await core.decryptObject(object.frame, key, vault, object.reference), bytes);
    console.log("browser compatibility and native crypto verified");
  `);
  expect(stdout.trim()).toBe("browser compatibility and native crypto verified");
});

test("runtime diagnostics identify genuinely missing cryptographic APIs and never substitute them", async () => {
  await browserChild(`
    import assert from "node:assert/strict";
    const { install } = await import("./runtime.mjs");
    Object.defineProperty(globalThis, "crypto", { configurable: true, value: {} });
    let error;
    const host = { sync() { throw new Error("unexpected native access"); }, request() { throw new Error("unexpected native access"); }, event() {}, finish() { throw new Error("unexpected success"); }, fail(message) { error = message; } };
    await install(host, {}).run({ server: {}, vault: {} });
    assert.equal(error, "WebView missing required APIs: crypto.subtle, crypto.getRandomValues");
    assert.equal(crypto.subtle, undefined); assert.equal(crypto.getRandomValues, undefined);
  `);
});
