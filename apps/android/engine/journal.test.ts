import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { encryptChunk } from "../../../packages/sync-core/src/index.ts";
import { Journal } from "./journal.ts";
import { TestHost } from "./host.test-helper.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanosync-android-journal-")); roots.push(root);
  const privateRoot = join(root, "private"), host = new TestHost(join(root, "files"), privateRoot, async () => new Response());
  return { host, privateRoot, files: () => readdirSync(privateRoot).filter(name => name !== "state") };
}
const vault = "123e4567-e89b-42d3-a456-426614174000", key = new Uint8Array(32).fill(7);
test("durable chunk cache is bounded and replaced stages are reclaimed only after checkpoint", async () => {
  const e = fixture(), journal = new Journal(e.host.runtime.bridge, 4096);
  const bytes = new Uint8Array(4096).fill(1), first = await encryptChunk(bytes, key, vault);
  await journal.put(vault, first.reference, bytes); expect(e.files()).toHaveLength(1);
  const oldId = e.files()[0];
  await journal.put(vault, first.reference, bytes);
  expect(e.files()).toHaveLength(1); expect(e.files()[0]).not.toBe(oldId);
  const secondBytes = new Uint8Array(4096).fill(2), second = await encryptChunk(secondBytes, key, vault);
  await journal.put(vault, second.reference, secondBytes);
  expect(e.files()).toHaveLength(1);
  expect(await journal.get(vault, first.reference)).toBeNull();
  expect(await journal.get(vault, second.reference)).toEqual(secondBytes);
});
test("garbage deletion failure is retryable across fresh journal instances without losing referenced cache", async () => {
  const e = fixture(), journal = new Journal(e.host.runtime.bridge, 4096);
  const bytes = new Uint8Array(4096).fill(1), object = await encryptChunk(bytes, key, vault);
  await journal.put(vault, object.reference, bytes);
  e.host.failure = method => { if (method === "stageDelete") throw new Error("injected cleanup failure"); };
  await journal.put(vault, object.reference, bytes);
  expect(e.files()).toHaveLength(2);
  e.host.failure = undefined;
  const fresh = new Journal(e.host.runtime.bridge, 4096); await fresh.collectGarbage();
  expect(e.files()).toHaveLength(1); expect(await fresh.get(vault, object.reference)).toEqual(bytes);
});
