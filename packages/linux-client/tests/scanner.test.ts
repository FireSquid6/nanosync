import { afterEach, expect, test, spyOn } from "bun:test";
import * as fs from "node:fs";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, linkSync, symlinkSync, rmSync, rmdirSync, unlinkSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClientLocal } from "@nanosync/client-local";
import { LinuxScanner, LinuxWatcher } from "../src/index.ts";
import type { ManifestV1 } from "@nanosync/sync-core";

const vault = randomUUID(), device = randomUUID(), key = new Uint8Array(32);
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup() {
  const root = mkdtempSync(join(tmpdir(), "nanosync-linux-")); roots.push(root);
  const folder = join(root, "data"), state = join(root, "state");
  mkdirSync(folder, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const local = new ClientLocal(state, vault, device);
  const prior: ManifestV1 = { version: 1, vaultId: vault, revisionId: randomUUID(), parents: [], creatingDeviceId: device,
    entries: [{ id: randomUUID(), parentId: null, name: "", kind: "directory" }] };
  const scanner = new LinuxScanner(folder, local);
  return { root, folder, local, prior, scanner };
}
function entry(plan: Awaited<ReturnType<LinuxScanner["plan"]>>, name: string) { return plan.manifest.entries.find(e => e.name === name)!; }
test("root connection marker is never scanned or published", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    writeFileSync(join(folder, ".nanosync"), JSON.stringify({ version: 1, connectionId: randomUUID() }), { mode: 0o600 });
    expect(scanner.snapshot().map(item => item.path)).toEqual([""]);
    const plan = await scanner.plan(prior, randomUUID(), device, key);
    expect(plan.manifest.entries).toHaveLength(1);
  } finally { local.close(); }
});
test("rename and atomic temp replacement keep stable IDs; changed content is streamed in natural order", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    writeFileSync(join(folder, "a"), "first");
    const first = await scanner.plan(prior, randomUUID(), device, key);
    expect(entry(first, "a").chunks).toHaveLength(1);
    const frames = []; for await (const frame of first.chunks()) frames.push(frame);
    expect(String(frames[0]?.reference.objectId)).toBe(String(entry(first, "a").chunks![0]?.objectId));
    first.commit();
    renameSync(join(folder, "a"), join(folder, "b"));
    const second = await scanner.plan(first.manifest, randomUUID(), device, key);
    expect(entry(second, "b").id).toBe(entry(first, "a").id);
    second.commit();
    writeFileSync(join(folder, "tmp"), "replacement");
    renameSync(join(folder, "tmp"), join(folder, "b"));
    const third = await scanner.plan(second.manifest, randomUUID(), device, key);
    expect(entry(third, "b").id).toBe(entry(second, "b").id);
    expect(third.manifest.entries.some(e => e.kind === "tombstone" && e.id === entry(second, "b").id)).toBe(false);
  } finally { local.close(); }
});
test("scan preserves immutable conflict lineage on unchanged, renamed and deleted entries", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    writeFileSync(join(folder, "conflict"), "kept", { mode: 0o600 });
    const initial = await scanner.plan(prior, randomUUID(), device, key); initial.commit();
    const original = entry(initial, "conflict");
    const lineage = { sourceEntryId: randomUUID(), sourceRevisionId: prior.revisionId };
    const accepted: ManifestV1 = { ...initial.manifest, entries: initial.manifest.entries.map(e =>
      e.id === original.id ? { ...e, conflict: lineage } : e) };
    const unchanged = await scanner.plan(accepted, randomUUID(), device, key);
    expect(entry(unchanged, "conflict").conflict).toEqual(lineage);
    renameSync(join(folder, "conflict"), join(folder, "moved"));
    const moved = await scanner.plan(accepted, randomUUID(), device, key);
    expect(entry(moved, "moved").conflict).toEqual(lineage);
    unlinkSync(join(folder, "moved"));
    const deleted = await scanner.plan(accepted, randomUUID(), device, key);
    expect(deleted.manifest.entries.find(e => e.id === original.id)).toMatchObject({ kind: "tombstone", deletedKind: "file" });
  } finally { local.close(); }
});
test("rejects symlinks, hardlinks, special files, and mutation after planning", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    symlinkSync("/etc/passwd", join(folder, "escape"));
    expect(() => scanner.snapshot()).toThrow(); unlinkSync(join(folder, "escape"));
    writeFileSync(join(folder, "a"), "one"); linkSync(join(folder, "a"), join(folder, "b"));
    expect(() => scanner.snapshot()).toThrow(); unlinkSync(join(folder, "b"));
    const plan = await scanner.plan(prior, randomUUID(), device, key);
    writeFileSync(join(folder, "a"), "two");
    await expect(async () => { for await (const _ of plan.chunks()) {} }).toThrow();
  } finally { local.close(); }
});
test("debounce and stable snapshot; deletion versus evicted retention and suppression", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    const watcher = new LinuxWatcher(scanner, { debounceMs: 10, stabilityMs: 20 });
    expect(watcher.ready(0)).toBe(false); expect(watcher.ready(10)).toBe(false);
    expect(watcher.ready(29)).toBe(false); expect(watcher.ready(30)).toBe(true);
    writeFileSync(join(folder, "a"), "one");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    unlinkSync(join(folder, "a"));
    local.upsertEntry({ id: entry(first, "a").id, path: "a", kind: "file", fingerprint: entry(first, "a").sha256!, hydration: "evicted", revision: first.manifest.revisionId });
    const retained = await scanner.plan(first.manifest, randomUUID(), device, key);
    expect(entry(retained, "a").kind).toBe("file");
    local.upsertEntry({ id: entry(first, "a").id, path: "a", kind: "file", fingerprint: entry(first, "a").sha256!, hydration: "downloaded", revision: first.manifest.revisionId });
    const deleted = await scanner.plan(first.manifest, randomUUID(), device, key);
    expect(entry(deleted, "a").kind).toBe("tombstone");
    writeFileSync(join(folder, "a"), "one");
    const op = randomUUID(); local.enqueueOperation(op, "apply"); local.suppress("a", entry(first, "a").sha256!, op);
    const ignored = await scanner.plan(first.manifest, randomUUID(), device, key);
    expect(ignored.suppressed).toEqual(["a"]);
  } finally { local.close(); }
});
test("50 GB sparse file is accepted at the boundary without reading it; larger files fail", () => {
  const { folder, local, scanner } = setup();
  try {
    const path = join(folder, "sparse"); writeFileSync(path, "");
    truncateSync(path, 50_000_000_000);
    expect(scanner.snapshot().find(e => e.path === "sparse")?.stat.size).toBe(50_000_000_000n);
    truncateSync(path, 50_000_000_001);
    expect(() => scanner.snapshot()).toThrow(/unsafe/);
  } finally { local.close(); }
});
test("delete, commit and recreate archives old tombstone without resurrecting its ID", async () => {
  const { folder, local, scanner, prior } = setup();
  try {
    writeFileSync(join(folder, "name"), "original");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    unlinkSync(join(folder, "name"));
    const deleted = await scanner.plan(first.manifest, randomUUID(), device, key); deleted.commit();
    expect(local.entry(entry(first, "name").id)?.kind).toBe("tombstone");
    writeFileSync(join(folder, "name"), "replacement");
    const recreated = await scanner.plan(deleted.manifest, randomUUID(), device, key);
    expect(entry(recreated, "name").id).not.toBe(entry(first, "name").id);
    const old = recreated.manifest.entries.find(e => e.id === entry(first, "name").id)!;
    expect(old.kind).toBe("tombstone");
    expect(old.name).toContain(`deleted ${old.id}`);
    recreated.commit();
    expect(local.entry(old.id)?.path).toBe(old.name);
    expect(local.entry(entry(recreated, "name").id)?.path).toBe("name");
    const again = await scanner.plan(recreated.manifest, randomUUID(), device, key);
    expect(again.manifest.entries.find(e => e.id === old.id)?.name).toBe(old.name);
  } finally { local.close(); }
});
test("deleting a directory reparents its prior child tombstone and retires omitted local descendants", async () => {
  const { folder, local, scanner, prior } = setup();
  try {
    mkdirSync(join(folder, "dir")); writeFileSync(join(folder, "dir", "gone"), "one");
    writeFileSync(join(folder, "dir", "other"), "two");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    unlinkSync(join(folder, "dir", "gone"));
    const second = await scanner.plan(first.manifest, randomUUID(), device, key); second.commit();
    unlinkSync(join(folder, "dir", "other"));
    rmdirSync(join(folder, "dir"));
    const third = await scanner.plan(second.manifest, randomUUID(), device, key);
    const oldChild = third.manifest.entries.find(e => e.id === entry(first, "gone").id)!;
    expect(oldChild.kind).toBe("tombstone");
    expect(oldChild.parentId).toBe(prior.entries[0]!.id);
    expect(oldChild.name).toContain("deleted");
    third.commit();
    expect(local.entry(entry(first, "other").id)).toBeNull();
    mkdirSync(join(folder, "dir"));
    const fourth = await scanner.plan(third.manifest, randomUUID(), device, key);
    expect(entry(fourth, "dir").id).not.toBe(entry(first, "dir").id);
  } finally { local.close(); }
});
test("evicted name collision fails visibly instead of resurrecting or replacing remote-only ID", async () => {
  const { folder, local, scanner, prior } = setup();
  try {
    writeFileSync(join(folder, "remote"), "remote");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    unlinkSync(join(folder, "remote"));
    local.upsertEntry({ id: entry(first, "remote").id, path: "remote", kind: "file", fingerprint: entry(first, "remote").sha256!, hydration: "evicted", revision: first.manifest.revisionId });
    writeFileSync(join(folder, "remote"), "new local file");
    await expect(scanner.plan(first.manifest, randomUUID(), device, key)).rejects.toThrow(/evicted name collision/);
    expect(local.entry(entry(first, "remote").id)?.hydration).toBe("evicted");
  } finally { local.close(); }
});
test("archival name truncates at 255 bytes and retries occupied deterministic suffix", async () => {
  const { folder, local, scanner, prior } = setup();
  try {
    const long = "x".repeat(255);
    writeFileSync(join(folder, long), "original");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    unlinkSync(join(folder, long));
    const deleted = await scanner.plan(first.manifest, randomUUID(), device, key); deleted.commit();
    const suffix = ` (deleted ${entry(first, long).id})`;
    const reserved = long.slice(0, 255 - Buffer.byteLength(suffix)) + suffix;
    writeFileSync(join(folder, reserved), "occupant");
    writeFileSync(join(folder, long), "replacement");
    const plan = await scanner.plan(deleted.manifest, randomUUID(), device, key);
    const tombstone = plan.manifest.entries.find(e => e.id === entry(first, long).id)!;
    expect(tombstone.kind).toBe("tombstone");
    expect(tombstone.name).not.toBe(reserved);
    expect(tombstone.name).toContain("-1)");
    expect(Buffer.byteLength(tombstone.name)).toBeLessThanOrEqual(255);
    plan.commit();
    expect(local.entry(tombstone.id)?.path).toBe(tombstone.name);
  } finally { local.close(); }
});

test("idle plans reuse content without file reads or crypto, including known publication", async () => {
  const { folder, local, prior, scanner } = setup();
  const reads = spyOn(fs, "readSync"), encrypts = spyOn(crypto.subtle, "encrypt"), digests = spyOn(crypto.subtle, "digest");
  try {
    writeFileSync(join(folder, "a"), "cached content");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(encrypts.mock.calls.length).toBeGreaterThan(0);
    reads.mockClear(); encrypts.mockClear(); digests.mockClear();
    const idle = await scanner.plan(first.manifest, randomUUID(), device, key);
    expect(entry(idle, "a").sha256).toBe(entry(first, "a").sha256);
    const known = new Set(entry(first, "a").chunks!.map(c => c.objectId));
    for await (const _ of idle.chunks(known)) { throw new Error("known chunk emitted"); }
    expect(reads).toHaveBeenCalledTimes(0);
    expect(encrypts).toHaveBeenCalledTimes(0);
    expect(digests).toHaveBeenCalledTimes(0);
    const repaired = []; for await (const frame of idle.chunks()) repaired.push(frame);
    expect(repaired).toHaveLength(1);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(encrypts).toHaveBeenCalledTimes(1);
  } finally { reads.mockRestore(); encrypts.mockRestore(); digests.mockRestore(); local.close(); }
});

test("a small edit publishes only unknown chunks without reencrypting known chunks", async () => {
  const { folder, local, prior, scanner } = setup();
  const encrypts = spyOn(crypto.subtle, "encrypt");
  try {
    const bytes = Buffer.alloc(4 * 1024 * 1024 + 1, 7);
    writeFileSync(join(folder, "large"), bytes);
    writeFileSync(join(folder, "unchanged"), "untouched");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    const known = new Set(first.manifest.entries.flatMap(e => e.chunks?.map(c => c.objectId) ?? []));
    bytes[bytes.length - 1] = 8; writeFileSync(join(folder, "large"), bytes);
    const edited = await scanner.plan(first.manifest, randomUUID(), device, key);
    encrypts.mockClear();
    const frames = []; for await (const frame of edited.chunks(known)) frames.push(frame);
    expect(frames).toHaveLength(1);
    expect(String(frames[0]!.reference.objectId)).toBe(entry(edited, "large").chunks![1]!.objectId);
    expect(encrypts).toHaveBeenCalledTimes(1);
  } finally { encrypts.mockRestore(); local.close(); }
});

test("known-chunk shortcuts still reject edits, replacements and symlinks after planning", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    writeFileSync(join(folder, "a"), "one");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    const known = new Set(entry(first, "a").chunks!.map(c => c.objectId));
    const idle = await scanner.plan(first.manifest, randomUUID(), device, key);
    writeFileSync(join(folder, "a"), "two");
    await expect(async () => { for await (const _ of idle.chunks(known)) {} }).toThrow();
    expect(() => idle.commit()).toThrow();
    writeFileSync(join(folder, "replacement"), "one"); renameSync(join(folder, "replacement"), join(folder, "a"));
    await expect(async () => { for await (const _ of idle.chunks(known)) {} }).toThrow();
    unlinkSync(join(folder, "a")); symlinkSync("/etc/passwd", join(folder, "a"));
    await expect(async () => { for await (const _ of idle.chunks(known)) {} }).toThrow();
  } finally { local.close(); }
});

test("cached chunk identities are isolated by master bytes, vault and scanner instance", async () => {
  const { folder, local, prior, scanner } = setup();
  const reads = spyOn(fs, "readSync");
  try {
    writeFileSync(join(folder, "a"), "isolated");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    reads.mockClear();
    await scanner.plan(first.manifest, randomUUID(), device, key.slice());
    expect(reads).toHaveBeenCalledTimes(0);
    const otherKey = key.slice(); otherKey[0] = 1;
    const rekeyed = await scanner.plan(first.manifest, randomUUID(), device, otherKey);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(entry(rekeyed, "a").chunks![0]!.objectId).not.toBe(entry(first, "a").chunks![0]!.objectId);
    reads.mockClear();
    const moved = await scanner.plan({ ...first.manifest, vaultId: randomUUID() }, randomUUID(), device, otherKey);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
    expect(entry(moved, "a").chunks![0]!.objectId).not.toBe(entry(rekeyed, "a").chunks![0]!.objectId);
    reads.mockClear();
    await new LinuxScanner(folder, local).plan(first.manifest, randomUUID(), device, key);
    expect(reads.mock.calls.length).toBeGreaterThan(0);
  } finally { reads.mockRestore(); local.close(); }
});

test("cache stamps do not round away nanosecond-only timestamp changes", async () => {
  const { folder, local, prior, scanner } = setup();
  try {
    writeFileSync(join(folder, "a"), "precision");
    const first = await scanner.plan(prior, randomUUID(), device, key); first.commit();
    const snapshot = scanner.snapshot.bind(scanner);
    for (const field of ["mtimeNs", "ctimeNs"] as const) {
      // Simulate a one-nanosecond inventory change while millisecond fields stay identical.
      const snapshots = spyOn(scanner, "snapshot").mockImplementation(() => {
        const found = snapshot();
        for (const file of found) if (file.kind === "file") file.stat[field] += 1n;
        return found;
      });
      try {
        await expect(scanner.plan(first.manifest, randomUUID(), device, key)).rejects.toThrow(/file changed/);
      } finally { snapshots.mockRestore(); }
    }
  } finally { local.close(); }
});

test('scanner pins its original root across calls instead of accepting a replacement', () => {
  const { folder, local, scanner } = setup();
  renameSync(folder, folder + '-original');
  mkdirSync(folder, { mode: 0o700 });
  expect(() => scanner.snapshot()).toThrow(/root/);
  rmSync(folder, { recursive: true }); renameSync(folder + '-original', folder);
  local.close();
});
