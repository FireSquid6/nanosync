import { test, expect } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile, chmod, mkdir, copyFile, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MaintenanceRepository, ServerMetadataDatabase, selectRetention } from "@nanosync/server-metadata";
import { LocalFilesystem, ObjectStorageError } from "@nanosync/server-object-storage";
import { PeriodicIntegrityScanner, ServerMaintenance } from "../src/maintenance.ts";
import { objectKey } from "../src/object-service.ts";

const vault = "12345678-1234-1234-9234-123456789abc";
const DAY = 86_400_000;
const now = Date.parse("2026-09-29T00:00:00.000Z");
function frame(id: string, vaultId = vault): Uint8Array {
  const bytes = new Uint8Array(97);
  bytes.set(new TextEncoder().encode("NSOBJ001"), 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(8, 1); view.setUint16(10, 1); view.setUint8(12, 1);
   bytes.set(Buffer.from(vaultId.replaceAll("-", ""), "hex"), 16);
  bytes.set(Buffer.from(id, "hex"), 32);
  view.setBigUint64(64, 1n); view.setBigUint64(72, 1n);
  return bytes;
}

test("catalog pagination, integrity, and offline GC isolate vaults with the same object ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-multi-maintenance-"));
  const db = new ServerMetadataDatabase(":memory:");
  const second = "22345678-1234-1234-9234-123456789abc", id = "a".repeat(64);
  try {
    const storage = new LocalFilesystem(join(root, "objects"));
    const repo = new MaintenanceRepository(db), service = new ServerMaintenance(repo, storage);
    db.writeTransaction(tx => {
      tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES(1,?,NULL,0)", [vault]);
      tx.run("INSERT INTO server_state(singleton,vault_id,name,current_head_revision_id,current_sequence) VALUES(NULL,?,'other',NULL,0)", [second]);
    });
    for (const vaultId of [vault, second]) {
      const bytes = frame(id, vaultId), checksum = createHash("sha256").update(bytes).digest("hex");
      await storage.putIfAbsent(objectKey("chunk", id, vaultId === vault ? undefined : vaultId), new Blob([bytes]).stream(), checksum);
      db.writeTransaction(tx => tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms) VALUES(?,?,'chunk',?,97,1,0)", [vaultId,id,checksum]));
    }
    const first = repo.catalog("", 1)[0]!;
    expect(repo.catalog(`${first.vault_id}:${first.object_id}`, 1)[0]?.vault_id).not.toBe(first.vault_id);
    expect(await service.scan(now)).toEqual({verified: 2, missing: 0, corrupt: 0});
    db.writeTransaction(tx => tx.run("INSERT INTO upload_sessions(vault_id,session_id,principal_id,device_id,object_id,object_type,state,created_at_ms,updated_at_ms,expires_at_ms) VALUES(?,?,?,?,?,'chunk','active',1,1,?)", [second, second, second, second, id, now]));
    expect(repo.markCandidates(now)).toBe(1);
    const deleted = await service.collectOffline({assertExclusiveOffline() {}}, now + DAY);
    expect(deleted.deleted).toBe(1);
    expect(await storage.existsBatch([objectKey("chunk",id),objectKey("chunk",id,second)])).toEqual([false,true]);
    expect(repo.catalog().map(row => String(row.vault_id))).toEqual([second]);
  } finally { db.close(); await rm(root,{recursive:true,force:true}); }
});

test("UTC retention boundaries, daily and monthly newest by server time", () => {
  const row = (n: number, time: number) => ({ revision_id: String(n), accepted_sequence: n, server_created_at_ms: time });
  const rows = [row(1, now - 3 * DAY), row(2, now - 3 * DAY - 1), row(3, now - 3 * DAY - 2),
    row(4, now - 30 * DAY), row(5, now - 30 * DAY - 1), row(6, now - 365 * DAY), row(7, now - 365 * DAY - 1),
    { ...row(8, now), accepted_sequence: null }];
  const chosen = selectRetention(rows, now);
  expect([...chosen].sort()).toEqual(["1", "2", "4", "6"]);
});

test("retention protects accepted timestamps beyond JS Date range and future dates", () => {
  const max = Number.MAX_SAFE_INTEGER;
  const row = (id: string, time: number) => ({ revision_id: id, accepted_sequence: 1, server_created_at_ms: time });
  expect([...selectRetention([row("unrepresentable", max), row("future", now + DAY)], now)].sort()).toEqual(["future", "unrepresentable"]);
  expect([...selectRetention([row("unrepresentable-past", max - 10 * DAY)], max)]).toEqual(["unrepresentable-past"]);
  const far = Date.UTC(10_000, 0, 12);
  expect([...selectRetention([row("jan", far - 5 * DAY), row("dec", far - 23 * DAY)], far)].sort()).toEqual(["dec", "jan"]);
  const db = new ServerMetadataDatabase(":memory:");
  try {
    const repo = new MaintenanceRepository(db);
    db.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES (1,?,NULL,0)", [vault]);
      tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms) VALUES (?,?,'manifest',?,109,1,0)", [vault, "a".repeat(64), "b".repeat(64)]);
      tx.run("INSERT INTO revisions(vault_id,revision_id,creating_device_id,client_created_at,manifest_object_id,protocol_version,revision_format_version,reference_set_mac,canonical_envelope_json,request_digest,accepted_sequence,server_created_at_ms) VALUES (?,?,?,'2026-01-01T00:00:00.000Z',?,1,1,?,'{}',?,NULL,?)", [vault, "22345678-1234-1234-9234-123456789abc", vault, "a".repeat(64), "c".repeat(64), "d".repeat(64), max]);
      tx.run("INSERT INTO revision_objects(vault_id,revision_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version) VALUES (?,?,?,'manifest',?,109,1)", [vault, "22345678-1234-1234-9234-123456789abc", "a".repeat(64), "b".repeat(64)]);
      tx.run("UPDATE revisions SET accepted_sequence = 1 WHERE vault_id = ?", [vault]);
    });
    expect(repo.retentionDryRun(now).selected).toEqual(["22345678-1234-1234-9234-123456789abc"]);
    expect(repo.retentionDryRun(now).protected).toEqual(["22345678-1234-1234-9234-123456789abc"]);
  } finally { db.close(); }
});

test("offline GC protects head, prepared merges, active transfers, races and retries failed deletes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-maintenance-"));
  const db = new ServerMetadataDatabase(":memory:");
  try {
    const storage = new LocalFilesystem(join(root, "objects"));
    const repo = new MaintenanceRepository(db);
    const service = new ServerMaintenance(repo, storage);
    db.writeTransaction((tx) => tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES (1,?,NULL,0)", [vault]));
    const ids = ["a", "b", "c", "d", "e"].map((c) => c.repeat(64));
    for (const id of ids) {
      const bytes = frame(id);
      const checksum = createHash("sha256").update(bytes).digest("hex");
      await storage.putIfAbsent(objectKey("chunk", id), new Blob([bytes]).stream(), checksum);
      db.writeTransaction((tx) => tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms) VALUES (?,?,'chunk',?,97,1,?)", [vault, id, checksum, now - 3 * DAY]));
    }
    expect(await service.scan(now)).toEqual({ verified: 5, missing: 0, corrupt: 0 });
    db.writeTransaction((tx) => tx.run("INSERT INTO upload_sessions(vault_id,session_id,principal_id,device_id,object_id,object_type,state,created_at_ms,updated_at_ms,expires_at_ms) VALUES (?,?,?,?,?,'chunk','active',1,1,?)", [vault, "12345678-1234-1234-9234-123456789abd", vault, vault, ids[1]!, now]));
    expect(repo.markCandidates(now)).toBe(4);
    expect(service.gcDryRun(now).eligible).toBe(0);
    // A newly referenced manifest protects its object even after candidate marking.
    db.writeTransaction((tx) => tx.run("INSERT INTO revisions(vault_id,revision_id,creating_device_id,client_created_at,manifest_object_id,protocol_version,revision_format_version,reference_set_mac,canonical_envelope_json,request_digest,server_created_at_ms) VALUES (?,?,?,'2026-01-01T00:00:00.000Z',?,1,1,?,'{}',?,?)", [vault, "22345678-1234-1234-9234-123456789abc", vault, ids[2]!, "f".repeat(64), "f".repeat(64), now]));
    // A prepared revision's manifest is protected, even without a revision_objects row yet.
    expect(repo.eligible(vault, ids[2]!, now + DAY)).toBeNull();
    const report = repo.retentionDryRun(now);
    expect(report.protected).toContain("22345678-1234-1234-9234-123456789abc");
    expect(report.deletableRevisions).toBe(0);
    let exclusive = false;
    const control = { assertExclusiveOffline: () => { if (!exclusive) throw Error("online"); } };
    await expect(service.collectOffline(control, now)).rejects.toThrow("online");
    exclusive = true;
    const first = await service.collectOffline(control, now + DAY - 1);
    expect(first.deleted).toBe(0);
    // Fail one deletion; candidate remains for restart/retry.
    const failing = new ServerMaintenance(repo, { putIfAbsent: storage.putIfAbsent.bind(storage), open: storage.open.bind(storage), stat: storage.stat.bind(storage), existsBatch: storage.existsBatch.bind(storage), list: storage.list.bind(storage), delete: async () => { throw Error("I/O"); } });
    expect((await failing.collectOffline(control, now + DAY)).failed).toBeGreaterThan(0);
    expect(repo.candidates().length).toBeGreaterThan(0);
    const done = await service.collectOffline(control, now + DAY);
    expect(done.deleted).toBe(3);
    expect(await storage.existsBatch(ids.map((id) => objectKey("chunk", id)))).toEqual([false, true, true, false, false]);
    expect(repo.candidates()).toEqual([]);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("integrity scan reports missing and corruption without deleting catalog records", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-maintenance-"));
  const db = new ServerMetadataDatabase(":memory:");
  try {
    const storage = new LocalFilesystem(join(root, "objects"));
    const repo = new MaintenanceRepository(db);
    const id = "a".repeat(64), bytes = frame(id);
    db.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES (1,?,NULL,0)", [vault]);
      tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms) VALUES (?,?,'chunk',?,97,1,0)", [vault, id, createHash("sha256").update(bytes).digest("hex")]);
    });
    const service = new ServerMaintenance(repo, storage);
    expect((await service.scan(now)).missing).toBe(1);
    await storage.putIfAbsent(objectKey("chunk", id), new Blob([bytes]).stream(), createHash("sha256").update(bytes).digest("hex"));
    expect((await service.scan(now)).verified).toBe(1);
    const path = join(root, "objects", objectKey("chunk", id));
    await writeFile(path, new Uint8Array(97)); await chmod(path, 0o600);
    expect((await service.scan(now)).corrupt).toBe(1);
    expect(repo.catalog()[0]?.integrity_status).toBe("corrupt");
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});

test("an async scan cannot overwrite an upload's newer integrity reset", async () => {
  const db = new ServerMetadataDatabase(":memory:");
  try {
    const id = "a".repeat(64);
    db.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES (1,?,NULL,0)", [vault]);
      tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms,integrity_status,integrity_checked_at_ms) VALUES (?,?,'chunk',?,97,1,0,'missing',1)", [vault, id, "b".repeat(64)]);
    });
    let reached!: () => void;
    const entered = new Promise<void>((resolve) => { reached = resolve; });
    const repo = new MaintenanceRepository(db);
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    const delayed = { open: async () => { reached(); await wait; throw new ObjectStorageError("NOT_FOUND", "missing"); } };
    const scan = new ServerMaintenance(repo, delayed as unknown as LocalFilesystem).scanBatch(now);
    await entered;
    // An accepted retry repairs the object and resets its status before the old scan finishes.
    db.writeTransaction((tx) => tx.run("UPDATE object_catalog SET integrity_status = 'unchecked', integrity_checked_at_ms = NULL WHERE object_id = ?", [id]));
    release();
    expect((await scan).counts).toEqual({ verified: 0, missing: 0, corrupt: 0 });
    expect(repo.catalog()[0]).toMatchObject({ integrity_status: "unchecked", integrity_checked_at_ms: null });
  } finally { db.close(); }
});

test("periodic scanner bounds each tick, is single-flight, reports failures and cancels safely", async () => {
  let calls = 0, release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const errors: unknown[] = [], batches: number[] = [];
  const scanner = new PeriodicIntegrityScanner({
    scanBatch: async (_time: number, cursor: string, limit: number, signal: AbortSignal) => {
      calls++;
      expect(limit).toBe(2);
      if (calls === 1) { await blocked; if (signal.aborted) throw Error("cancelled"); }
      if (calls === 2) throw Error("disk failed");
      return { cursor: cursor + "a", done: false, counts: { verified: 1, missing: 0, corrupt: 0 } };
    },
  } as unknown as ServerMaintenance, { intervalMs: 60_000, batchSize: 2, clock: () => now,
    onError: (error) => { errors.push(error); throw Error("monitor failed"); }, onBatch: (result) => { batches.push(result.verified); } });
  scanner.start();
  const first = scanner.tick(); // shares the blocked first call
  expect(calls).toBe(1);
  release();
  await first;
  await scanner.tick();
  await scanner.tick();
  expect(errors).toHaveLength(1);
  expect(batches).toEqual([1, 1]);
  expect(calls).toBe(3);
  await scanner.stop();
  await scanner.tick();
  expect(calls).toBe(3);
});

test("periodic scanner stops an in-flight batch without launching another", async () => {
  let calls = 0, cancelled = false;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const scanner = new PeriodicIntegrityScanner({
    scanBatch: async (_time: number, _cursor: string, _limit: number, signal: AbortSignal) => {
      calls++; entered();
      await new Promise<void>((resolve) => signal.addEventListener("abort", () => { cancelled = true; resolve(); }, { once: true }));
      throw Error("cancelled");
    },
  } as unknown as ServerMaintenance, { intervalMs: 1, onError: () => { throw Error("cancel must not report as failure"); } });
  scanner.start();
  await started;
  await Bun.sleep(5);
  expect(calls).toBe(1);
  await scanner.stop();
  expect(cancelled).toBe(true);
  await Bun.sleep(5);
  expect(calls).toBe(1);
});

test("offline staged backup restores private metadata and verifies copied ciphertext", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-backup-"));
  try {
    const source = join(root, "source"), stage = join(root, "stage");
    await mkdir(source, { mode: 0o700 }); await mkdir(stage, { mode: 0o700 });
    const original = new ServerMetadataDatabase(join(source, "metadata.sqlite"));
    const id = "a".repeat(64), bytes = frame(id), hash = createHash("sha256").update(bytes).digest("hex");
    const storage = new LocalFilesystem(join(source, "objects"));
    await storage.putIfAbsent(objectKey("chunk", id), new Blob([bytes]).stream(), hash);
    original.writeTransaction((tx) => {
      tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES (1,?,NULL,0)", [vault]);
      tx.run("INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms) VALUES (?,?,'chunk',?,97,1,0)", [vault, id, hash]);
    });
    // Quiesced snapshot: close SQLite (including WAL), then copy DB and immutable object.
    original.close();
    await copyFile(join(source, "metadata.sqlite"), join(stage, "metadata.sqlite"));
    await chmod(join(stage, "metadata.sqlite"), 0o600);
    const stagedStorage = new LocalFilesystem(join(stage, "objects"));
    await stagedStorage.putIfAbsent(objectKey("chunk", id), new Blob([bytes]).stream(), hash);
    const restored = new ServerMetadataDatabase(join(stage, "metadata.sqlite"));
    try {
      const maintenance = new ServerMaintenance(new MaintenanceRepository(restored), stagedStorage);
      expect(restored.pragmas().userVersion).toBe(6);
      expect(await maintenance.scan(now)).toEqual({ verified: 1, missing: 0, corrupt: 0 });
      await stagedStorage.delete(objectKey("chunk", id));
      expect((await maintenance.scan(now)).missing).toBe(1);
    } finally { restored.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("permanent cleanup reclaims uncataloged ciphertext, survives restart, and isolates namespaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-delete-"));
  const path = join(root, "metadata.sqlite"), second = "22345678-1234-1234-9234-123456789abc";
  let db = new ServerMetadataDatabase(path);
  try {
    const storage = new LocalFilesystem(join(root, "objects"));
    db.writeTransaction(tx => {
      for (const id of [vault, second]) tx.run("INSERT INTO server_state(singleton,vault_id,name,current_sequence) VALUES(NULL,?,?,0)", [id,id]);
    });
    const { VaultRepository } = await import('@nanosync/server-metadata');
    new VaultRepository(db).markDeleted(vault, {origin:'server-local',actorId:null}, now);
    for (const id of [vault, second]) {
      const bytes = frame('a'.repeat(64), id);
      await storage.putIfAbsent(objectKey('chunk','a'.repeat(64),id), new Blob([bytes]).stream(), createHash('sha256').update(bytes).digest('hex'));
    }
    const extra = frame('b'.repeat(64), vault);
    await storage.putIfAbsent(objectKey('chunk','b'.repeat(64),vault), new Blob([extra]).stream(), createHash('sha256').update(extra).digest('hex'));
    const broken = Object.create(storage);
    let deletes = 0;
    broken.delete = async (key: string) => {
      if (++deletes === 2) throw Error('disk unavailable');
      return storage.delete(key);
    };
    await expect(new ServerMaintenance(new MaintenanceRepository(db), broken).cleanupDeleted()).rejects.toThrow('disk unavailable');
    db.close(); db = new ServerMetadataDatabase(path);
    const service = new ServerMaintenance(new MaintenanceRepository(db), storage);
    await service.cleanupDeleted(); await service.cleanupDeleted();
    expect(await storage.existsBatch([objectKey('chunk','a'.repeat(64),vault),objectKey('chunk','a'.repeat(64),second)])).toEqual([false,true]);
    expect(new VaultRepository(db).deletions()[0]?.cleanupState).toBe('complete');
    expect(db.get<{name:null;current_sequence:number}>('SELECT name,current_sequence FROM server_state WHERE vault_id=?',[vault])).toEqual({name:null,current_sequence:0});
  } finally { db.close(); await rm(root,{recursive:true,force:true}); }
});


test("restart reclaims SIGKILL-interrupted staging before deletion completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-crashed-upload-"));
  const storageRoot = join(root, "objects");
  const dbPath = join(root, "metadata.sqlite");
  let db = new ServerMetadataDatabase(dbPath);
  const modulePath = new URL("../../server-object-storage/src/index.ts", import.meta.url).href;
  const child = Bun.spawn([process.execPath, "--eval", `
    import { LocalFilesystem } from ${JSON.stringify(modulePath)};
    const storage = new LocalFilesystem(${JSON.stringify(storageRoot)});
    const stream = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(4096)); } });
    void storage.putIfAbsent(${JSON.stringify(objectKey("chunk", "a".repeat(64)))}, stream, "0".repeat(64));
    setInterval(() => {}, 1000);
  `], { stdout: "pipe", stderr: "pipe" });
  try {
    let staged = false;
    for (let attempt = 0; attempt < 300; attempt++) {
      const names = await readdir(join(storageRoot, ".nanosync-tmp")).catch(() => []);
      for (const name of names) {
        if ((await stat(join(storageRoot, ".nanosync-tmp", name))).size === 4096) staged = true;
      }
      if (staged) break;
      await Bun.sleep(10);
    }
    expect(staged).toBe(true);
    await expect(new LocalFilesystem(storageRoot).list()).rejects.toMatchObject({ code: "UNSAFE_PATH" });
    const activeNames = await readdir(join(storageRoot, ".nanosync-tmp"));
    expect(activeNames).toHaveLength(1);
    expect((await stat(join(storageRoot, ".nanosync-tmp", activeNames[0]!))).size).toBe(4096);
    child.kill("SIGKILL");
    await child.exited;
    db.writeTransaction(tx => tx.run("INSERT INTO server_state(singleton,vault_id,current_head_revision_id,current_sequence) VALUES(1,?,NULL,0)", [vault]));
    const { VaultRepository } = await import("@nanosync/server-metadata");
    new VaultRepository(db).markDeleted(vault, { origin: "server-local", actorId: null }, 20);
    db.close();
    db = new ServerMetadataDatabase(dbPath);
    const storage = new LocalFilesystem(storageRoot);
    const metadata = new MaintenanceRepository(db);
    await new ServerMaintenance(metadata, storage).cleanupDeleted();
    expect(metadata.deletedVaults()[0]?.cleanupState).toBe("complete");
    expect(await readdir(join(storageRoot, ".nanosync-tmp"))).toEqual([]);
    expect((await storage.list()).keys).toEqual([]);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    db.close(); await rm(root, { recursive: true, force: true });
  }
});

test("failed deleted-vault cleanup reports failure without starving later vaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-cleanup-isolation-"));
  const db = new ServerMetadataDatabase(":memory:");
  const second = "22345678-1234-1234-9234-123456789abc";
  try {
    const storage = new LocalFilesystem(join(root, "objects"));
    const { VaultRepository } = await import("@nanosync/server-metadata");
    const vaults = new VaultRepository(db);
    for (const id of [vault, second]) {
      db.writeTransaction(tx => tx.run("INSERT INTO server_state(singleton,vault_id,name,current_sequence) VALUES(NULL,?,?,0)", [id, id]));
      const bytes = frame("a".repeat(64), id);
      await storage.putIfAbsent(objectKey("chunk", "a".repeat(64), id), new Blob([bytes]).stream(), createHash("sha256").update(bytes).digest("hex"));
      vaults.markDeleted(id, { origin: "server-local", actorId: null }, now);
    }
    const failing = Object.create(storage) as LocalFilesystem;
    failing.list = async (prefix, options) => {
      if (prefix === `objects/v1/${vault}`) throw Error("unreadable namespace");
      return storage.list(prefix, options);
    };
    const service = new ServerMaintenance(new MaintenanceRepository(db), failing);
    for (let pass = 0; pass < 2; pass++) {
      await expect(service.cleanupDeleted()).rejects.toThrow("unreadable namespace");
      expect(vaults.deletions().find(row => row.vaultId === vault)?.cleanupState).toBe("pending");
      expect(vaults.deletions().find(row => row.vaultId === second)?.cleanupState).toBe("complete");
      expect(await storage.existsBatch([objectKey("chunk", "a".repeat(64), vault), objectKey("chunk", "a".repeat(64), second)])).toEqual([true, false]);
    }
    await new ServerMaintenance(new MaintenanceRepository(db), storage).cleanupDeleted();
    expect(vaults.deletions().every(row => row.cleanupState === "complete")).toBe(true);
  } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
