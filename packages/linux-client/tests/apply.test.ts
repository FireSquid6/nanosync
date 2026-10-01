import { afterEach, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocal } from "@nanosync/client-local";
import { parseManifest, type HttpRemote } from "@nanosync/sync-core";
import { applyNewFiles } from "../src/apply.ts";

const vault = "d4cb8e11-806e-46a4-b181-4fc39315533b", device = "2957f275-108f-4c6e-8e1d-d9150d9d97ba";
const rev = "61e6f2c5-eb66-4b09-92ab-bc58c12cf668", rootId = "0269d767-61c9-4d43-9470-3596814718ed";
const fileId = "11111111-1111-4111-8111-111111111111", sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const dirId = "22222222-2222-4222-8222-222222222222", nextRev = "33333333-3333-4333-8333-333333333333";
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const base = mkdtempSync(join(tmpdir(), "nanosync-apply-")); dirs.push(base);
  const root = join(base, "data"), privateDir = join(base, "private");
  // ClientLocal owns the private directory; the data root is an ordinary directory.
  mkdirSync(root); chmodSync(root, 0o700);
  const local = new ClientLocal(privateDir, vault, device);
  local.recordHead("accepted", { revisionId: rev, sequence: 1 });
  const manifest = parseManifest({ version: 1, vaultId: vault, revisionId: rev, parents: [], creatingDeviceId: device,
    entries: [{ id: rootId, parentId: null, name: "", kind: "directory" },
      { id: fileId, parentId: rootId, name: "note", kind: "file", size: 0, sha256: sha, executable: false, chunks: [] }] });
  const remote = { manifest: async () => ({ manifest, revision: { references: [] } }),
    async *downloadChunks() {} } as unknown as HttpRemote;
  return { root, local, manifest, remote };
}
test("creates private verified file and commits journal after durable installation", async () => {
  const { root, local, manifest, remote } = setup();
  await applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32));
  expect(readFileSync(join(root, "note")).length).toBe(0);
  expect(lstatSync(join(root, "note")).mode & 0o777).toBe(0o600);
  expect(local.head("applied").revisionId).toBe(rev);
  expect(local.matchesSuppression("note", sha)).toBe(true);
  local.close();
});
test("does not replace a symlink or confuse an unexpected deletion with eviction", async () => {
  const { root, local, manifest, remote } = setup();
  symlinkSync("outside", join(root, "note"));
  await expect(applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32))).rejects.toThrow();
  expect(lstatSync(join(root, "note")).isSymbolicLink()).toBe(true);
  rmSync(join(root, "note"));
  local.recordScan([{ id: fileId, path: "note", kind: "file", fingerprint: sha, hydration: "downloaded", revision: rev }],
    [{ entryId: fileId, device: "1", inode: "2" }]);
  await expect(applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32))).rejects.toThrow(/unexpected local deletion/);
  expect(local.pendingApplies()).toEqual([]);
  local.close();
});

test("nested download and verified replacement retain identity; old plaintext survives failed download", async () => {
  const { root, local, manifest } = setup();
  mkdirSync(join(root, "folder")); writeFileSync(join(root, "folder", "note"), "old");
  chmodSync(join(root, "folder"), 0o700); chmodSync(join(root, "folder", "note"), 0o600);
  const old = createHash("sha256").update("old").digest("hex"), fresh = createHash("sha256").update("new").digest("hex");
  const directory = statSync(join(root, "folder")), file = statSync(join(root, "folder", "note"));
  local.recordScan([
    { id: rootId, path: "", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev },
    { id: dirId, path: "folder", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev },
    { id: fileId, path: "folder/note", kind: "file", fingerprint: old, hydration: "downloaded", revision: rev },
  ], [{ entryId: dirId, device: String(directory.dev), inode: String(directory.ino) },
    { entryId: fileId, device: String(file.dev), inode: String(file.ino) },
    { entryId: rootId, device: String(statSync(root).dev), inode: String(statSync(root).ino) }]);
  local.recordHead("accepted", { revisionId: nextRev, sequence: 2 });
  const reference = { objectId: "a".repeat(64), objectType: "chunk", ciphertextChecksum: "b".repeat(64), ciphertextLength: 99, objectFormatVersion: 1 };
  const next = parseManifest({ ...manifest, revisionId: nextRev, parents: [rev], entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" }, { id: dirId, parentId: rootId, name: "folder", kind: "directory" },
    { id: fileId, parentId: dirId, name: "note", kind: "file", size: 3, sha256: fresh, executable: false,
      chunks: [{ objectId: reference.objectId, length: 3 }] }] });
  let tampered = true;
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [reference] } }),
    async *downloadChunks() { yield Buffer.from(tampered ? "bad" : "new"); } } as unknown as HttpRemote;
  await expect(applyNewFiles(root, local, remote, next, 2, new Uint8Array(32))).rejects.toThrow(/digest/);
  expect(readFileSync(join(root, "folder/note"), "utf8")).toBe("old");
  expect(local.pendingApplies()).toEqual([]);
  tampered = false;
  await applyNewFiles(root, local, remote, next, 2, new Uint8Array(32));
  expect(readFileSync(join(root, "folder/note"), "utf8")).toBe("new");
  expect(local.entry(fileId)?.path).toBe("folder/note");
  local.close();
});

test("moves nested directory and file by stable identity, then tombstones and evicts durably", async () => {
  const { root, local, manifest } = setup();
  mkdirSync(join(root, "before")); writeFileSync(join(root, "before/item"), "content");
  chmodSync(join(root, "before"), 0o700); chmodSync(join(root, "before/item"), 0o600);
  const sum = createHash("sha256").update("content").digest("hex"), rootStat = statSync(root);
  const directory = statSync(join(root, "before")), file = statSync(join(root, "before/item"));
  local.recordScan([
    { id: rootId, path: "", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev },
    { id: dirId, path: "before", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev },
    { id: fileId, path: "before/item", kind: "file", fingerprint: sum, hydration: "downloaded", revision: rev },
  ], [
    { entryId: rootId, device: String(rootStat.dev), inode: String(rootStat.ino) },
    { entryId: dirId, device: String(directory.dev), inode: String(directory.ino) },
    { entryId: fileId, device: String(file.dev), inode: String(file.ino) },
  ]);
  local.recordHead("accepted", { revisionId: nextRev, sequence: 2 });
  const moved = parseManifest({ ...manifest, revisionId: nextRev, parents: [rev], entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "after", kind: "directory" },
    { id: fileId, parentId: dirId, name: "renamed", kind: "file", size: 7, sha256: sum, executable: false, chunks: [
      { objectId: "a".repeat(64), length: 7 }] },
  ] });
  const remote = { manifest: async () => ({ manifest: moved, revision: { references: [] } }),
    presence: async () => new Set(), async *downloadChunks() {} } as unknown as HttpRemote;
  await applyNewFiles(root, local, remote, moved, 2, new Uint8Array(32));
  expect(statSync(join(root, "after")).ino).toBe(directory.ino);
  expect(statSync(join(root, "after/renamed")).ino).toBe(file.ino);
  expect(lstatSync(join(root, "after/renamed")).isFile()).toBe(true);
  const deletedRev = "44444444-4444-4444-8444-444444444444";
  const tombstone = parseManifest({ ...moved, revisionId: deletedRev, parents: [nextRev], entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "after", kind: "directory" },
    { id: fileId, parentId: dirId, name: "renamed", kind: "tombstone", deletedKind: "file" },
  ] });
  local.recordHead("accepted", { revisionId: deletedRev, sequence: 3 });
  const deletionRemote = { ...remote, manifest: async () => ({ manifest: tombstone, revision: { references: [] } }) } as unknown as HttpRemote;
  await applyNewFiles(root, local, deletionRemote, tombstone, 3, new Uint8Array(32));
  expect(local.entry(fileId)?.kind).toBe("tombstone");
  expect(() => lstatSync(join(root, "after/renamed"))).toThrow();
  local.close();
});

test("reopens and replays a durable intent after filesystem operations finish but journal commit fails", async () => {
  const { root, local, manifest, remote } = setup();
  const original = local.finishApply.bind(local);
  let interrupted = true;
  local.finishApply = (...args) => { if (interrupted) throw new Error("injected interruption"); return original(...args); };
  await expect(applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32))).rejects.toThrow(/interruption/);
  expect(local.pendingApplies()).toHaveLength(1);
  expect(readFileSync(join(root, "note")).length).toBe(0);
  interrupted = false;
  local.close();
  const reopened = new ClientLocal(join(root, "..", "private"), vault, device);
  await applyNewFiles(root, reopened, remote, manifest, 1, new Uint8Array(32));
  expect(reopened.pendingApplies()).toEqual([]);
  expect(reopened.head("applied").revisionId).toBe(rev);
  reopened.close();
});

test("creates nested directories and retains remote-only entries without hydration", async () => {
  const { root, local, manifest } = setup();
  const remoteOnly = "55555555-5555-4555-8555-555555555555";
  const next = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "nested", kind: "directory" },
    { id: fileId, parentId: dirId, name: "note", kind: "file", size: 0, sha256: sha, executable: false, chunks: [] },
    { id: remoteOnly, parentId: dirId, name: "offline", kind: "file", size: 0, sha256: sha, executable: false, chunks: [] },
  ] });
  local.upsertEntry({ id: remoteOnly, path: "nested/offline", kind: "file", fingerprint: sha, hydration: "evicted", revision: rev });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [] } }),
    async *downloadChunks() {} } as unknown as HttpRemote;
  await applyNewFiles(root, local, remote, next, 1, new Uint8Array(32));
  expect(lstatSync(join(root, "nested")).isDirectory()).toBe(true);
  expect(lstatSync(join(root, "nested/note")).isFile()).toBe(true);
  expect(local.entry(remoteOnly)?.hydration).toBe("evicted");
  expect(() => lstatSync(join(root, "nested/offline"))).toThrow();
  local.close();
});

test("evicts accepted empty file and retains a remote-only manifest entry", async () => {
  const { root, local, manifest, remote } = setup();
  await applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32));
  const next = parseManifest({ ...manifest, revisionId: nextRev, parents: [rev] });
  local.recordHead("accepted", { revisionId: nextRev, sequence: 2 });
  const evictRemote = { manifest: async () => ({ manifest: next, revision: { references: [] } }),
    presence: async () => { throw new Error("empty file has no remote chunks"); }, async *downloadChunks() {} } as unknown as HttpRemote;
  await applyNewFiles(root, local, evictRemote, next, 2, new Uint8Array(32), { evictIds: new Set([fileId]) });
  expect(local.entry(fileId)?.hydration).toBe("evicted");
  expect(() => lstatSync(join(root, "note"))).toThrow();
  local.close();
});

test("refuses nonempty eviction when authenticated chunk is not remotely present", async () => {
  const { root, local, manifest } = setup();
  writeFileSync(join(root, "note"), "retained");
  chmodSync(join(root, "note"), 0o600);
  const st = statSync(join(root, "note")), hash = createHash("sha256").update("retained").digest("hex");
  local.recordScan([{ id: fileId, path: "note", kind: "file", fingerprint: hash, hydration: "downloaded", revision: rev }],
    [{ entryId: fileId, device: String(st.dev), inode: String(st.ino) }]);
  local.recordHead("accepted", { revisionId: nextRev, sequence: 2 });
  const ref = { objectId: "a".repeat(64), ciphertextLength: 104, objectType: "chunk" };
  const next = parseManifest({ ...manifest, revisionId: nextRev, parents: [rev], entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: fileId, parentId: rootId, name: "note", kind: "file", size: 8, sha256: hash, executable: false,
      chunks: [{ objectId: ref.objectId, length: 8 }] },
  ] });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [ref] } }),
    presence: async () => new Set([ref.objectId]) } as unknown as HttpRemote;
  await expect(applyNewFiles(root, local, remote, next, 2, new Uint8Array(32), { evictIds: new Set([fileId]) })).rejects.toThrow(/durable/);
  expect(readFileSync(join(root, "note"), "utf8")).toBe("retained");
  expect(local.pendingApplies()).toEqual([]);
  local.close();
});

test("replays intent interrupted before any filesystem mutation", async () => {
  const { root, local, manifest, remote } = setup();
  const original = local.transition.bind(local); let fail = true;
  local.transition = (...args) => { if (fail) throw new Error("injected pre-mutation interruption"); return original(...args); };
  await expect(applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32))).rejects.toThrow(/interruption/);
  expect(local.pendingApplies()[0]?.state).toBe("pending");
  expect(() => lstatSync(join(root, "note"))).toThrow();
  fail = false;
  await applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32));
  expect(local.pendingApplies()).toEqual([]);
  expect(lstatSync(join(root, "note")).isFile()).toBe(true);
  local.close();
});

test("replays a nested created directory after its final rename but before journal commit", async () => {
  const { root, local, manifest } = setup();
  const next = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "created", kind: "directory" },
    { id: fileId, parentId: dirId, name: "note", kind: "file", size: 0, sha256: sha, executable: false, chunks: [] },
  ] });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [] } }),
    async *downloadChunks() {} } as unknown as HttpRemote;
  const finish = local.finishApply.bind(local); let fail = true;
  local.finishApply = (...args) => { if (fail) throw new Error("after directory rename"); return finish(...args); };
  await expect(applyNewFiles(root, local, remote, next, 1, new Uint8Array(32))).rejects.toThrow(/after directory rename/);
  expect(local.pendingApplies()).toHaveLength(1);
  fail = false;
  await applyNewFiles(root, local, remote, next, 1, new Uint8Array(32));
  expect(lstatSync(join(root, "created/note")).isFile()).toBe(true);
  expect(local.pendingApplies()).toEqual([]);
  local.close();
});

test("replays a moved existing directory without losing its inode", async () => {
  const { root, local, manifest } = setup();
  mkdirSync(join(root, "old"));
  chmodSync(join(root, "old"), 0o700);
  const st = statSync(join(root, "old"));
  local.recordScan([{ id: dirId, path: "old", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev }],
    [{ entryId: dirId, device: String(st.dev), inode: String(st.ino) }]);
  const next = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "moved", kind: "directory" },
  ] });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [] } }) } as unknown as HttpRemote;
  const finish = local.finishApply.bind(local); let fail = true;
  local.finishApply = (...args) => { if (fail) throw new Error("moved but not committed"); return finish(...args); };
  await expect(applyNewFiles(root, local, remote, next, 1, new Uint8Array(32))).rejects.toThrow(/not committed/);
  fail = false;
  await applyNewFiles(root, local, remote, next, 1, new Uint8Array(32));
  expect(statSync(join(root, "moved")).ino).toBe(st.ino);
  expect(local.pendingApplies()).toEqual([]);
  local.close();
});

test("rejects edited local plaintext and nested symlink parent without deleting either", async () => {
  const { root, local, manifest, remote } = setup();
  writeFileSync(join(root, "note"), "edited");
  chmodSync(join(root, "note"), 0o600);
  const stat = statSync(join(root, "note"));
  local.recordScan([{ id: fileId, path: "note", kind: "file", fingerprint: sha, hydration: "downloaded", revision: rev }],
    [{ entryId: fileId, device: String(stat.dev), inode: String(stat.ino) }]);
  await expect(applyNewFiles(root, local, remote, manifest, 1, new Uint8Array(32))).rejects.toThrow(/content conflict/);
  expect(readFileSync(join(root, "note"), "utf8")).toBe("edited");
  local.recordScan([], []);
  rmSync(join(root, "note"));
  symlinkSync("outside", join(root, "unsafe"));
  const nested = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "unsafe", kind: "directory" },
    { id: fileId, parentId: dirId, name: "note", kind: "file", size: 0, sha256: sha, executable: false, chunks: [] },
  ] });
  const nestedRemote = { manifest: async () => ({ manifest: nested, revision: { references: [] } }),
    async *downloadChunks() {} } as unknown as HttpRemote;
  await expect(applyNewFiles(root, local, nestedRemote, nested, 1, new Uint8Array(32))).rejects.toThrow();
  expect(lstatSync(join(root, "unsafe")).isSymbolicLink()).toBe(true);
  expect(local.pendingApplies()).toEqual([]);
  local.close();
});

test("removes a deleted directory subtree after intent while keeping its tombstone", async () => {
  const { root, local, manifest } = setup();
  mkdirSync(join(root, "gone")); chmodSync(join(root, "gone"), 0o700);
  writeFileSync(join(root, "gone/note"), "x"); chmodSync(join(root, "gone/note"), 0o600);
  const folder = statSync(join(root, "gone")), leaf = statSync(join(root, "gone/note"));
  const hash = createHash("sha256").update("x").digest("hex");
  local.recordScan([
    { id: dirId, path: "gone", kind: "directory", fingerprint: null, hydration: "downloaded", revision: rev },
    { id: fileId, path: "gone/note", kind: "file", fingerprint: hash, hydration: "downloaded", revision: rev },
  ], [
    { entryId: dirId, device: String(folder.dev), inode: String(folder.ino) },
    { entryId: fileId, device: String(leaf.dev), inode: String(leaf.ino) },
  ]);
  const next = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "gone", kind: "tombstone", deletedKind: "directory" },
  ] });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [] } }) } as unknown as HttpRemote;
  await applyNewFiles(root, local, remote, next, 1, new Uint8Array(32));
  expect(() => lstatSync(join(root, "gone"))).toThrow();
  expect(local.entry(dirId)?.kind).toBe("tombstone");
  expect(local.entry(fileId)).toBeNull();
  local.close();
});

test("replays nested descendants staged beneath a moved ancestor but rejects unknown staged children", async () => {
  const { root, local, manifest } = setup();
  const innerId = "66666666-6666-4666-8666-666666666666";
  mkdirSync(join(root, "outer")); chmodSync(join(root, "outer"), 0o700);
  mkdirSync(join(root, "outer/inner")); chmodSync(join(root, "outer/inner"), 0o700);
  writeFileSync(join(root, "outer/inner/note"), "saved"); chmodSync(join(root, "outer/inner/note"), 0o600);
  const outer = statSync(join(root, "outer")), inner = statSync(join(root, "outer/inner"));
  const file = statSync(join(root, "outer/inner/note")), hash = createHash("sha256").update("saved").digest("hex");
  const oldEntries = [
    { id: dirId, path: "outer", kind: "directory" as const, fingerprint: null, hydration: "downloaded" as const, revision: rev },
    { id: innerId, path: "outer/inner", kind: "directory" as const, fingerprint: null, hydration: "downloaded" as const, revision: rev },
    { id: fileId, path: "outer/inner/note", kind: "file" as const, fingerprint: hash, hydration: "downloaded" as const, revision: rev },
  ];
  local.recordScan(oldEntries, [
    { entryId: dirId, device: String(outer.dev), inode: String(outer.ino) },
    { entryId: innerId, device: String(inner.dev), inode: String(inner.ino) },
    { entryId: fileId, device: String(file.dev), inode: String(file.ino) },
  ]);
  const next = parseManifest({ ...manifest, entries: [
    { id: rootId, parentId: null, name: "", kind: "directory" },
    { id: dirId, parentId: rootId, name: "renamed", kind: "directory" },
    { id: innerId, parentId: dirId, name: "inner", kind: "directory" },
    { id: fileId, parentId: innerId, name: "note", kind: "file", size: 5, sha256: hash, executable: false,
      chunks: [{ objectId: "a".repeat(64), length: 5 }] },
  ] });
  const remote = { manifest: async () => ({ manifest: next, revision: { references: [] } }) } as unknown as HttpRemote;
  const transition = local.transition.bind(local);
  local.transition = () => { throw new Error("interrupt after prepare"); };
  await expect(applyNewFiles(root, local, remote, next, 1, new Uint8Array(32))).rejects.toThrow(/after prepare/);
  const intent = local.pendingApplies()[0]!;
  const plan = JSON.parse(local.applyPlan(intent.id)!) as { operationId: string; old: { entry: { id: string; path: string } }[] };
  expect(plan.old.map(item => item.entry.path)).toContain("outer/inner/note");
  const stage = `.nanosync-${plan.operationId}-${dirId}-old`;
  renameSync(join(root, "outer"), join(root, stage)); // crash immediately after the directory rename
  local.transition = transition;
  writeFileSync(join(root, stage, "inner/unknown"), "unexpected");
  chmodSync(join(root, stage, "inner/unknown"), 0o600);
  await expect(applyNewFiles(root, local, remote, next, 1, new Uint8Array(32))).rejects.toThrow(/unexpected entry/);
  expect(local.pendingApplies()).toHaveLength(1);
  rmSync(join(root, stage, "inner/unknown"));
  const innerStage = `.nanosync-${plan.operationId}-${innerId}-old`;
  renameSync(join(root, stage, "inner"), join(root, innerStage)); // second staged ancestor, file still nested inside it
  local.close();
  const reopened = new ClientLocal(join(root, "..", "private"), vault, device);
  await applyNewFiles(root, reopened, remote, next, 1, new Uint8Array(32));
  expect(readFileSync(join(root, "renamed/inner/note"), "utf8")).toBe("saved");
  expect(statSync(join(root, "renamed")).ino).toBe(outer.ino);
  expect(statSync(join(root, "renamed/inner")).ino).toBe(inner.ino);
  expect(statSync(join(root, "renamed/inner/note")).ino).toBe(file.ino);
  expect(reopened.pendingApplies()).toEqual([]);
  reopened.close();
});
