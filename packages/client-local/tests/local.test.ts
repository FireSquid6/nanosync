import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, chmodSync, lstatSync, readdirSync, readFileSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";
import { ClientLocal } from "../src/index.ts";
import { encryptChunk, encryptRandomized } from "@nanosync/sync-core";
import { parseAdvanceHeadRequest, parseIdempotencyKey } from "@nanosync/protocol";

const vault = "d4cb8e11-806e-46a4-b181-4fc39315533b";
const device = "2957f275-108f-4c6e-8e1d-d9150d9d97ba";
const rev = "61e6f2c5-eb66-4b09-92ab-bc58c12cf668";
const other = "0269d767-61c9-4d43-9470-3596814718ed";
const master = new Uint8Array(32).fill(7);
const dirs: string[] = [];
function directory() { const dir = mkdtempSync(join(tmpdir(), "nanosync-client-")); chmodSync(dir, 0o700); dirs.push(dir); return dir; }
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

test("reopens durable identity, heads, entries, work and watcher suppression without rolling back", () => {
  const dir = directory(); let db = new ClientLocal(dir, vault, device);
  expect(db.pragmas()).toEqual({ synchronous: 2, version: 3 });
  const entry = { id: other, path: "notes/plan.md", kind: "file" as const, fingerprint: "a".repeat(64), hydration: "evicted" as const, revision: rev };
  db.upsertEntry(entry);
  db.enqueueOperation(rev, "evict", entry.id);
  db.enqueueTransfer(rev, "b".repeat(64), "download");
  db.addConflict(other, other, rev);
  db.suppress(entry.path, entry.fingerprint, rev);
  db.recordHead("observed", { revisionId: rev, sequence: 1 });
  db.recordHead("accepted", { revisionId: rev, sequence: 1 });
  db.recordHead("applied", { revisionId: rev, sequence: 1 });
  db.transition("operations", rev, "running"); db.close();
  db = new ClientLocal(dir, vault, device);
  expect(db.entry(other)).toEqual(entry);
  expect(db.head("applied")).toEqual({ revisionId: rev, sequence: 1 });
  expect(db.listWork("operations")[0]?.state).toBe("running");
  db.enqueueOperation(rev, "evict", other);
  expect(db.consumeSuppression(entry.path, "b".repeat(64))).toBe(false);
  expect(db.consumeSuppression(entry.path, entry.fingerprint)).toBe(true);
  expect(db.consumeSuppression(entry.path, entry.fingerprint)).toBe(false);
  expect(() => db.recordHead("observed", { revisionId: null, sequence: 0 })).toThrow();
  expect(() => db.recordHead("accepted", { revisionId: other, sequence: 1 })).toThrow();
  expect(() => db.recordHead("applied", { revisionId: other, sequence: 2 })).toThrow();
  expect(() => new ClientLocal(dir, vault, other)).toThrow(/identity/);
  db.close();
});

test("frozen proposal keeps identical manifest and request across reopen; cannot be overwritten", async () => {
  const dir = directory(); const encrypted = await encryptRandomized("manifest", new Uint8Array([1, 2, 3]), master, vault);
  const request = parseAdvanceHeadRequest({ protocolVersion: 1, vaultId: vault, expectedRevisionId: other, idempotencyKey: "safe-key", proposedRevision: {
    protocolVersion: 1, revisionFormatVersion: 1, vaultId: vault, revisionId: rev, parents: [other], creatingDeviceId: device,
    createdAt: "2026-09-29T12:00:00.000Z", encryptedManifestObjectId: encrypted.reference.objectId,
    references: [encrypted.reference], referenceSetMac: "0".repeat(64),
  } });
  let db = new ClientLocal(dir, vault, device);
  db.freezeProposal(request, encrypted.frame);
  encrypted.frame.fill(0);
  db.close(); db = new ClientLocal(dir, vault, device);
  const frozen = db.proposal()!;
  expect(frozen.request).toEqual(request);
  expect(frozen.encryptedManifestFrame[0]).not.toBe(0);
  expect(frozen.state).toBe("prepared");
  expect(() => db.clearProposal()).toThrow();
  expect(() => db.freezeProposal({ ...request, idempotencyKey: parseIdempotencyKey("different") }, frozen.encryptedManifestFrame)).toThrow();
  db.acceptProposal(1); db.acceptProposal(1);
  expect(() => db.acceptProposal(2)).toThrow();
  db.close(); db = new ClientLocal(dir, vault, device);
  expect(db.proposal()!.acceptedSequence).toBe(1);
  db.clearProposal(); expect(db.proposal()).toBeNull(); db.close();
  expect(readFileSync(join(dir, "local.sqlite")).includes(master)).toBe(false);
});

test("bounded private chunk cache repairs orphan, missing and truncated files", async () => {
  const dir = directory(), plain = new Uint8Array([5, 4, 3]);
  const encrypted = await encryptChunk(plain, master, vault);
  let db = new ClientLocal(dir, vault, device, 4 * 1024 * 1024);
  await expect(db.put(vault, encrypted.reference, new Uint8Array([1]))).rejects.toThrow();
  await db.put(vault, encrypted.reference, plain);
  const file = join(dir, "chunks", encrypted.reference.objectId);
  expect(lstatSync(file).mode & 0o777).toBe(0o600);
  expect(await db.get(vault, encrypted.reference)).toEqual(plain);
  db.close();
  writeFileSync(file, new Uint8Array([1]), { mode: 0o600 });
  writeFileSync(join(dir, "chunks", ".stage-abandoned"), plain, { mode: 0o600 });
  db = new ClientLocal(dir, vault, device);
  expect(readdirSync(join(dir, "chunks"))).toEqual([]);
  expect(await db.get(vault, encrypted.reference)).toBeNull();
  await db.put(vault, encrypted.reference, plain);
  db.close(); unlinkSync(file);
  db = new ClientLocal(dir, vault, device);
  expect(await db.get(vault, encrypted.reference)).toBeNull(); db.close();
});

test("fails closed on unsafe modes, symlinks, altered migration and future schema", () => {
  const dir = directory(); let db = new ClientLocal(dir, vault, device); db.close();
  chmodSync(join(dir, "local.sqlite"), 0o644);
  expect(() => new ClientLocal(dir, vault, device)).toThrow(/unsafe/);
  chmodSync(join(dir, "local.sqlite"), 0o600);
  const sql = new Database(join(dir, "local.sqlite"));
  sql.run("UPDATE migrations SET checksum=? WHERE version=1", ["x".repeat(64)]); sql.close();
  expect(() => new ClientLocal(dir, vault, device)).toThrow(/checksum/);
  const future = directory(); db = new ClientLocal(future, vault, device); db.close();
  const raw = new Database(join(future, "local.sqlite")); raw.exec("PRAGMA user_version=99"); raw.close();
  expect(() => new ClientLocal(future, vault, device)).toThrow(/unsupported/);
  const symlinkDir = directory();
  symlinkSync(join(dir, "local.sqlite"), join(symlinkDir, "local.sqlite"));
  expect(() => new ClientLocal(symlinkDir, vault, device)).toThrow(/unsafe/);
});

test("migrates an interrupted pre-v2 installation and rejects modified schema", () => {
  const dir = directory(); let db = new ClientLocal(dir, vault, device); db.close();
  const filename = join(dir, "local.sqlite"); let sql = new Database(filename);
  sql.exec("DROP TABLE file_identity; DROP TABLE suppression; DELETE FROM migrations WHERE version>=2; PRAGMA user_version=1"); sql.close();
  db = new ClientLocal(dir, vault, device);
  expect(db.pragmas().version).toBe(3);
  db.enqueueOperation(rev, "scan");
  db.suppress("hello", "a".repeat(64), rev);
  db.close();
  sql = new Database(filename); sql.exec("CREATE TABLE intruder(x TEXT)"); sql.close();
  expect(() => new ClientLocal(dir, vault, device)).toThrow(/schema/);
});

test("rejects unsafe cache files rather than following or deleting them", async () => {
  const dir = directory(); let db = new ClientLocal(dir, vault, device); db.close();
  symlinkSync(join(dir, "local.sqlite"), join(dir, "chunks", ".stage-bad"));
  expect(() => new ClientLocal(dir, vault, device)).toThrow(/unsafe/);
});
