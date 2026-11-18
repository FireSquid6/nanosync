import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseManifest } from "../../../packages/sync-core/src/index.ts";
import { Journal } from "./journal.ts";
import { Scanner } from "./scanner.ts";
import { TestHost } from "./host.test-helper.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanosync-scan-reuse-")); roots.push(root);
  const files = join(root, "files"), host = new TestHost(files, join(root, "private"), async () => { throw new Error("unexpected HTTP"); });
  const journal = new Journal(host.runtime.bridge), scanner = new Scanner(host.runtime.bridge, journal), key = new Uint8Array(32).fill(7);
  const device = crypto.randomUUID();
  const genesis = parseManifest({ version: 1, vaultId: crypto.randomUUID(), revisionId: crypto.randomUUID(), parents: [], creatingDeviceId: device,
    entries: [{ id: crypto.randomUUID(), parentId: null, name: "", kind: "directory" }] });
  writeFileSync(join(files, "unchanged"), "known bytes"); writeFileSync(join(files, "changed"), "old bytes");
  const first = await scanner.plan(genesis, crypto.randomUUID(), device, key); await first.commit(); host.calls = [];
  const known = new Set(first.manifest.entries.flatMap(e => e.chunks?.map(c => c.objectId) ?? []));
  return { files, host, scanner, key, device, prior: first.manifest, known };
}

test("unchanged scans and fully known publication perform native digest guards but no content reads", async () => {
  const e = await fixture();
  const plan = await e.scanner.plan(e.prior, crypto.randomUUID(), e.device, e.key);
  expect(plan.manifest.entries).toEqual(e.prior.entries);
  expect(await Array.fromAsync(plan.chunks(e.known))).toEqual([]); await plan.commit();
  expect(e.host.calls.filter(c => c.method === "read")).toHaveLength(0);
  expect(e.host.calls.filter(c => c.method === "digest").map(c => c.args.path)).toContain("unchanged");
  expect(e.host.calls.filter(c => c.method === "digest").map(c => c.args.path)).toContain("changed");
});

test("publishing one changed file does not reread the other known file", async () => {
  const e = await fixture(); writeFileSync(join(e.files, "changed"), "new content");
  const plan = await e.scanner.plan(e.prior, crypto.randomUUID(), e.device, e.key);
  expect(await Array.fromAsync(plan.chunks(e.known))).toHaveLength(1); await plan.commit();
  expect(e.host.calls.filter(c => c.method === "read").map(c => c.args.path)).not.toContain("unchanged");
  expect(e.host.calls.filter(c => c.method === "read").map(c => c.args.path)).toContain("changed");
});

test("repair reopens only a file with missing refs and validates reused content before commit", async () => {
  const e = await fixture();
  // A replaced inode with identical content can reuse authenticated chunk IDs.
  writeFileSync(join(e.files, "replacement"), "known bytes"); renameSync(join(e.files, "replacement"), join(e.files, "unchanged"));
  const plan = await e.scanner.plan(e.prior, crypto.randomUUID(), e.device, e.key);
  const missing = e.prior.entries.find(entry => entry.name === "unchanged")!.chunks![0]!.objectId;
  const available = new Set(e.known); available.delete(missing);
  const repaired = await Array.fromAsync(plan.chunks(available));
  expect(repaired.map(object => String(object.reference.objectId))).toEqual([missing]);
  expect(e.host.calls.filter(c => c.method === "read").map(c => c.args.path)).not.toContain("changed");
  writeFileSync(join(e.files, "unchanged"), "concurrent edit");
  await expect(plan.commit()).rejects.toThrow("changed");
  await expect(Array.fromAsync(plan.chunks(available))).rejects.toThrow("changed");
});
