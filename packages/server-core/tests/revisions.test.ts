import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalizeAdvanceHeadIdentity, canonicalizePersistedRevisionEnvelope, canonicalizeRevisionEnvelope,
  parseAdvanceHeadRequest, parsePersistedRevisionEnvelope,
  type RevisionEnvelope,
} from "@nanosync/protocol";
import { ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase } from "@nanosync/server-metadata";
import { LocalFilesystem, ObjectStorageError, type Filesystem } from "@nanosync/server-object-storage";
import { REVISION_STAT_CONCURRENCY, createServerHandler, objectKey } from "../src/index.ts";

const roots: string[] = [];
const vaultId = "123e4567-e89b-12d3-a456-426614174000";
const deviceId = "223e4567-e89b-12d3-a456-426614174000";
const otherDevice = "323e4567-e89b-12d3-a456-426614174000";
const principalId = "423e4567-e89b-12d3-a456-426614174000";
const genesisId = "523e4567-e89b-12d3-a456-426614174000";
const checksum = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");
const objectId = (n: number) => n.toString(16).padStart(64, "0");
const revisionId = (n: number) => `${n.toString(16).padStart(8, "0")}-1234-1234-9234-123456789abc`;

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(path = ":memory:", authorize: () => Promise<any> = async () => ({ vaultId, deviceId, principalId })) {
  const root = await mkdtemp(join(tmpdir(), "nanosync-revisions-")); roots.push(root);
  const filesystem = new LocalFilesystem(root);
  const database = new ServerMetadataDatabase(path);
  database.writeTransaction((tx) => tx.run("INSERT OR IGNORE INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vaultId]));
  const catalog = new ObjectCatalogRepository(database), revisions = new RevisionRepository(database);
  const handle = createServerHandler({ filesystem, catalog, revisions, authorize, clock: () => 1_000 });
  return { root, filesystem, database, catalog, revisions, handle };
}

async function addObject(env: Awaited<ReturnType<typeof setup>>, id: string, type: "manifest" | "chunk" = "manifest", bytes = new Uint8Array(type === "chunk" ? 97 : 109).fill(3)) {
  const digest = checksum(bytes);
  await env.filesystem.putIfAbsent(objectKey(type, id), new Blob([bytes]).stream(), digest);
  env.database.writeTransaction((tx) => tx.run(`INSERT INTO object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms) VALUES (?, ?, ?, ?, ?, 1, 1)`, [vaultId, id, type, digest, bytes.byteLength]));
  return { objectId: id, objectType: type, ciphertextChecksum: digest, ciphertextLength: bytes.byteLength, objectFormatVersion: 1 } as const;
}

function addCatalogObject(env: Awaited<ReturnType<typeof setup>>, id: string, type: "manifest" | "chunk", digest: string, length: number): void {
  env.database.writeTransaction((tx) => tx.run(`INSERT INTO object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms) VALUES (?, ?, ?, ?, ?, 1, 1)`, [vaultId, id, type, digest, length]));
}

function withStat(base: Filesystem, stat: Filesystem["stat"]): Filesystem {
  return {
    putIfAbsent: base.putIfAbsent.bind(base), open: base.open.bind(base), stat,
    existsBatch: base.existsBatch.bind(base), delete: base.delete.bind(base), list: base.list.bind(base),
  };
}

function handlerWith(env: Awaited<ReturnType<typeof setup>>, filesystem: Filesystem, authorize: () => Promise<any> = async () => ({ vaultId, deviceId, principalId })) {
  return createServerHandler({ filesystem, catalog: env.catalog, revisions: env.revisions, authorize, clock: () => 1_000 });
}

async function bootstrap(env: Awaited<ReturnType<typeof setup>>) {
  const manifest = await addObject(env, objectId(1));
  const genesis = parsePersistedRevisionEnvelope({
    protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId: genesisId, parents: [], creatingDeviceId: deviceId,
    createdAt: "2026-01-01T00:00:00.000Z", encryptedManifestObjectId: manifest.objectId, references: [manifest], referenceSetMac: "a".repeat(64),
  });
  env.database.writeTransaction((tx) => {
    tx.run(`INSERT INTO revisions(vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, accepted_sequence, server_created_at_ms) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 1, 1)`, [vaultId, genesisId, deviceId, genesis.createdAt, manifest.objectId, genesis.referenceSetMac, canonicalizePersistedRevisionEnvelope(genesis), "0".repeat(64)]);
    tx.run(`INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version) VALUES (?, ?, ?, ?, ?, ?, 1)`, [vaultId, genesisId, manifest.objectId, manifest.objectType, manifest.ciphertextChecksum, manifest.ciphertextLength]);
    tx.run("UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE singleton = 1", [genesisId]);
  });
}

async function proposal(env: Awaited<ReturnType<typeof setup>>, n: number, parents: string[], creatingDeviceId = deviceId): Promise<RevisionEnvelope> {
  const manifest = await addObject(env, objectId(n + 10));
  return {
    protocolVersion: 1, revisionFormatVersion: 1, vaultId: vaultId as any, revisionId: revisionId(n) as any,
    parents: [...parents].sort() as any, creatingDeviceId: creatingDeviceId as any, createdAt: "2026-01-02T00:00:00.000Z",
    encryptedManifestObjectId: manifest.objectId as any, references: [manifest] as any, referenceSetMac: "b".repeat(64) as any,
  };
}
function request(envelope: RevisionEnvelope, expectedRevisionId: string | null, idempotencyKey: string, raw?: string) {
  const body = raw ?? JSON.stringify({ protocolVersion: 1, vaultId, expectedRevisionId, proposedRevision: envelope, idempotencyKey });
  return new Request("http://local/v1/head/advance", { method: "POST", headers: { "content-type": "application/json" }, body });
}
async function body(response: Response): Promise<any> { return response.json(); }

describe("revision head HTTP", () => {
  test("reports initialized state, accepts once, replays, and retrieves canonical immutable data", async () => {
    const env = await setup();
    expect(await body(await env.handle(new Request("http://local/v1/head")))).toEqual({ protocolVersion: 1, status: "initializedWithoutHead", revisionId: null, sequence: 0 });
    await bootstrap(env); const next = await proposal(env, 1, [genesisId]);
    expect(await body(await env.handle(request(next, genesisId, "publish")))).toEqual({ status: "accepted", revisionId: next.revisionId, sequence: 2 });
    next.createdAt = "2026-09-09T00:00:00.000Z";
    expect(await body(await env.handle(request({ ...next, createdAt: "2026-01-02T00:00:00.000Z" }, genesisId, "publish")))).toEqual({ status: "alreadyAccepted", revisionId: next.revisionId, sequence: 2 });
    expect(await body(await env.handle(new Request("http://local/v1/head")))).toEqual({ protocolVersion: 1, status: "head", revisionId: next.revisionId, sequence: 2 });
    const fetched = await body(await env.handle(new Request(`http://local/v1/revisions/${next.revisionId}`)));
    expect(fetched.sequence).toBe(2); expect(fetched.revision.createdAt).toBe("2026-01-02T00:00:00.000Z");
    const conflict = await env.handle(request({ ...next, createdAt: "2026-01-03T00:00:00.000Z" }, genesisId, "publish"));
    expect(conflict.status).toBe(409); expect((await body(conflict)).code).toBe("IDEMPOTENCY_KEY_REUSE");
  });

  test("serializes concurrent proposals with one winner and preserves stale ancestry for merge", async () => {
    const env = await setup(); await bootstrap(env);
    const left = await proposal(env, 2, [genesisId]), right = await proposal(env, 3, [genesisId]);
    const results = await Promise.all([env.handle(request(left, genesisId, "left")), env.handle(request(right, genesisId, "right"))]).then(async (items) => Promise.all(items.map(body)));
    expect(results.map((item) => item.status).sort()).toEqual(["accepted", "staleHead"]);
    const winner = results.find((item) => item.status === "accepted")!.revisionId;
    const stale = winner === left.revisionId ? right : left;
    expect((await body(await env.handle(new Request(`http://local/v1/revisions/${stale.revisionId}`)))).sequence).toBeNull();
    const merge = await proposal(env, 4, [winner, stale.revisionId]);
    expect((await body(await env.handle(request(merge, winner, "merge")))).status).toBe("accepted");
    const rows = env.database.all<{ revision_id: string; accepted_sequence: number | null }>("SELECT revision_id, accepted_sequence FROM revisions ORDER BY revision_id");
    expect(rows.filter((row) => row.revision_id === left.revisionId || row.revision_id === right.revisionId)).toHaveLength(2);
    expect(rows.filter((row) => (row.revision_id === left.revisionId || row.revision_id === right.revisionId) && row.accepted_sequence !== null)).toHaveLength(1);
  });

  test("sorts absent and size-mismatched cataloged objects, keeps head, and accepts the same-key retry after repair", async () => {
    const env = await setup(); await bootstrap(env);
    const next = await proposal(env, 5, [genesisId]);
    const bytes = new Uint8Array(97).fill(4), digest = checksum(bytes), absentId = objectId(2), wrongSizeId = objectId(3);
    const reference = (id: string) => ({ objectId: id, objectType: "chunk" as const, ciphertextChecksum: digest, ciphertextLength: 97, objectFormatVersion: 1 as const });
    addCatalogObject(env, absentId, "chunk", digest, 97);
    const wrongBytes = new Uint8Array(98).fill(8);
    await env.filesystem.putIfAbsent(objectKey("chunk", wrongSizeId), new Blob([wrongBytes]).stream(), checksum(wrongBytes));
    addCatalogObject(env, wrongSizeId, "chunk", digest, 97);
    next.references = [reference(wrongSizeId) as any, ...next.references, reference(absentId) as any].sort((a, b) => a.objectId.localeCompare(b.objectId));
    let result = await body(await env.handle(request(next, genesisId, "retry")));
    expect(result).toEqual({ status: "missingObjects", objectIds: [absentId, wrongSizeId] });
    expect(env.revisions.head(vaultId as any)).toEqual({ revisionId: genesisId as any, sequence: 1 });
    await env.filesystem.putIfAbsent(objectKey("chunk", absentId), new Blob([bytes]).stream(), digest);
    await env.filesystem.delete(objectKey("chunk", wrongSizeId));
    await env.filesystem.putIfAbsent(objectKey("chunk", wrongSizeId), new Blob([bytes]).stream(), digest);
    result = await body(await env.handle(request(next, genesisId, "retry")));
    expect(result.status).toBe("accepted");
  });

  test("bounds stat concurrency separately from storage existence batches", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 20, [genesisId]);
    const references = [...next.references];
    for (let index = 0; index < REVISION_STAT_CONCURRENCY + 8; index++) references.push(await addObject(env, objectId(1_000 + index), "chunk") as any);
    next.references = references.sort((a, b) => a.objectId.localeCompare(b.objectId));
    let active = 0, maximum = 0;
    const filesystem = withStat(env.filesystem, async (key) => {
      active++; maximum = Math.max(maximum, active);
      try { await Bun.sleep(2); return await env.filesystem.stat(key); }
      finally { active--; }
    });
    expect((await body(await handlerWith(env, filesystem)(request(next, genesisId, "bounded")))).status).toBe("accepted");
    expect(maximum).toBeLessThanOrEqual(REVISION_STAT_CONCURRENCY);
    expect(maximum).toBeGreaterThan(1);
  });

  test("classifies only NOT_FOUND stat races as missing and hides other storage failures", async () => {
    const missing = await setup(); await bootstrap(missing); const missingProposal = await proposal(missing, 21, [genesisId]);
    const target = objectKey("manifest", missingProposal.encryptedManifestObjectId);
    const raced = withStat(missing.filesystem, async (key) => {
      if (key === target) throw new ObjectStorageError("NOT_FOUND", "injected race", key);
      return missing.filesystem.stat(key);
    });
    expect(await body(await handlerWith(missing, raced)(request(missingProposal, genesisId, "race")))).toEqual({ status: "missingObjects", objectIds: [missingProposal.encryptedManifestObjectId] });
    expect(missing.revisions.head(vaultId as any)).toEqual({ revisionId: genesisId as any, sequence: 1 });

    const unsafe = await setup(); await bootstrap(unsafe); const unsafeProposal = await proposal(unsafe, 22, [genesisId]);
    const failed = withStat(unsafe.filesystem, async (key) => { throw new ObjectStorageError("UNSAFE_PATH", "secret internal path", key); });
    const response = await handlerWith(unsafe, failed)(request(unsafeProposal, genesisId, "unsafe"));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
    expect(unsafe.revisions.head(vaultId as any)).toEqual({ revisionId: genesisId as any, sequence: 1 });
  });

  test("treats catalog integrity failures as missing and permits same-key repair", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 11, [genesisId]);
    const id = next.encryptedManifestObjectId;
    env.database.writeTransaction((tx) => tx.run("UPDATE object_catalog SET integrity_status = 'corrupt', integrity_checked_at_ms = 2 WHERE vault_id = ? AND object_id = ?", [vaultId, id]));
    expect(await body(await env.handle(request(next, genesisId, "integrity")))).toEqual({ status: "missingObjects", objectIds: [id] });
    env.database.writeTransaction((tx) => tx.run("UPDATE object_catalog SET integrity_status = 'unchecked', integrity_checked_at_ms = NULL WHERE vault_id = ? AND object_id = ?", [vaultId, id]));
    expect((await body(await env.handle(request(next, genesisId, "integrity")))).status).toBe("accepted");
  });

  test("rejects nonexistent parents, structural authorization mismatches, genesis, and revision collisions without moving head", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 6, [genesisId]);
    expect(await body(await env.handle(request(next, null, "genesis")))).toEqual({ status: "invalidRevision", reasonCode: "GENESIS_REQUIRES_BOOTSTRAP" });
    const wrongDevice = await proposal(env, 7, [genesisId], otherDevice);
    expect((await body(await env.handle(request(wrongDevice, genesisId, "device")))).reasonCode).toBe("CREATING_DEVICE_MISMATCH");
    const otherVault = "623e4567-e89b-12d3-a456-426614174000";
    const vaultMismatch = { ...next, vaultId: otherVault };
    const vaultRequest = new Request("http://local/v1/head/advance", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, vaultId: otherVault, expectedRevisionId: genesisId, proposedRevision: vaultMismatch, idempotencyKey: "vault" }) });
    expect((await body(await env.handle(vaultRequest))).reasonCode).toBe("VAULT_MISMATCH");
    expect((await body(await env.handle(request(next, revisionId(99), "expected")))).reasonCode).toBe("EXPECTED_PARENT_MISMATCH");
    const missingParent = await proposal(env, 8, [revisionId(99)]);
    expect((await body(await env.handle(request(missingParent, revisionId(99), "parent")))).reasonCode).toBe("PARENT_NOT_FOUND");
    expect((await body(await env.handle(request(next, genesisId, "first")))).status).toBe("accepted");
    const collision = { ...next, createdAt: "2026-01-03T00:00:00.000Z" };
    expect((await body(await env.handle(request(collision, genesisId, "collision")))).reasonCode).toBe("REVISION_ID_CONFLICT");
    expect((await body(await env.handle(new Request("http://local/v1/head")))).revisionId).toBe(next.revisionId);
  });

  test("isolates an authenticated context for another valid vault without leaking revision IDs", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 23, [genesisId]);
    const otherVault = "623e4567-e89b-12d3-a456-426614174000";
    const isolated = handlerWith(env, env.filesystem, async () => ({ vaultId: otherVault, deviceId, principalId }));
    for (const input of [
      new Request("http://local/v1/head"),
      new Request(`http://local/v1/revisions/${genesisId}`),
      request(next, genesisId, "isolated"),
    ]) {
      const response = await isolated(input);
      expect(response.status).toBe(403);
      expect(await body(response)).toEqual({ protocolVersion: 1, code: "FORBIDDEN", message: "Authenticated vault is not available" });
    }
    expect(env.revisions.head(vaultId as any)).toEqual({ revisionId: genesisId as any, sequence: 1 });
  });

  test("rolls back revision, head, sequence, and idempotency together on injected failure", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 9, [genesisId]);
    env.database.writeTransaction((tx) => tx.run(`CREATE TRIGGER fail_revision_idempotency BEFORE INSERT ON idempotency_records WHEN NEW.operation = 'advance-head-v1' BEGIN SELECT RAISE(ABORT, 'injected'); END`));
    expect((await env.handle(request(next, genesisId, "failure"))).status).toBe(500);
    expect(env.revisions.head(vaultId as any)).toEqual({ revisionId: genesisId as any, sequence: 1 });
    expect(env.database.get<{ count: number }>("SELECT count(*) AS count FROM revisions WHERE revision_id = ?", [next.revisionId])?.count).toBe(0);
    expect(env.database.get<{ count: number }>("SELECT count(*) AS count FROM idempotency_records WHERE operation = 'advance-head-v1'")?.count).toBe(0);
  });

  test("protects routes and safely rejects malformed, duplicate, unsupported, and unknown requests", async () => {
    const unauthorized = await setup(":memory:", async () => { throw new Error("no"); });
    expect((await unauthorized.handle(new Request("http://local/v1/head"))).status).toBe(401);
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 10, [genesisId]);
    const duplicate = `{"protocolVersion":1,"protocolVersion":1,"vaultId":"${vaultId}","expectedRevisionId":"${genesisId}","proposedRevision":${canonicalizeRevisionEnvelope(next)},"idempotencyKey":"x"}`;
    expect((await env.handle(request(next, genesisId, "x", duplicate))).status).toBe(400);
    const unsupported = JSON.stringify({ protocolVersion: 2, vaultId, expectedRevisionId: genesisId, proposedRevision: next, idempotencyKey: "x" });
    expect((await env.handle(request(next, genesisId, "x", unsupported))).status).toBe(400);
    expect((await env.handle(new Request("http://local/v1/head", { method: "POST" }))).status).toBe(405);
    expect((await env.handle(new Request("http://local/v1/revisions/not-an-id"))).status).toBe(400);
    expect((await env.handle(new Request(`http://local/v1/revisions/${revisionId(77)}`))).status).toBe(404);
    const oversized = new Request("http://local/v1/head/advance", { method: "POST", headers: { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) }, body: new ReadableStream<Uint8Array>() as any });
    expect((await env.handle(oversized)).status).toBe(413);
  });

  test("turns a corrupted persisted advance result into a generic internal error", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 14, [genesisId]);
    const parsed = parseAdvanceHeadRequest({ protocolVersion: 1, vaultId, expectedRevisionId: genesisId, proposedRevision: next, idempotencyKey: "corrupt" });
    const digest = createHash("sha256").update(canonicalizeAdvanceHeadIdentity(parsed)).digest("hex");
    env.database.writeTransaction((tx) => tx.run(`INSERT INTO idempotency_records(principal_id, device_id, operation, idempotency_key, request_digest, outcome, result_json, created_at_ms, expires_at_ms) VALUES (?, ?, 'advance-head-v1', 'corrupt', ?, 'accepted', ?, 1, 2)`, [principalId, deviceId, digest, `{"status":"accepted","revisionId":"${next.revisionId}","sequence":2,"extra":true}`]));
    const response = await env.handle(request(next, genesisId, "corrupt"));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
  });

  test("rejects valid but noncanonical persisted revision JSON without exposing it", async () => {
    const env = await setup(); await bootstrap(env); const next = await proposal(env, 24, [genesisId]);
    expect((await body(await env.handle(request(next, genesisId, "stored-before-corruption")))).status).toBe("accepted");
    env.database.writeTransaction((tx) => {
      // Test-only corruption injection: production keeps this immutable trigger installed.
      tx.run("DROP TRIGGER revision_immutable");
      tx.run("UPDATE revisions SET canonical_envelope_json = ? WHERE vault_id = ? AND revision_id = ?", [JSON.stringify(next, null, 2), vaultId, next.revisionId]);
    });
    const response = await env.handle(new Request(`http://local/v1/revisions/${next.revisionId}`));
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
  });

  test("reopens on-disk state with head, prepared revision, sequence, and idempotency intact", async () => {
    const databaseRoot = await mkdtemp(join(tmpdir(), "nanosync-revision-db-")); roots.push(databaseRoot);
    const path = join(databaseRoot, "metadata.sqlite");
    const env = await setup(path); await bootstrap(env);
    const accepted = await proposal(env, 12, [genesisId]), stale = await proposal(env, 13, [genesisId]);
    expect((await body(await env.handle(request(accepted, genesisId, "durable-accepted")))).status).toBe("accepted");
    expect((await body(await env.handle(request(stale, genesisId, "durable-stale")))).status).toBe("staleHead");
    env.database.close();

    const database = new ServerMetadataDatabase(path), catalog = new ObjectCatalogRepository(database), revisions = new RevisionRepository(database);
    const handle = createServerHandler({ filesystem: env.filesystem, catalog, revisions, authorize: async () => ({ vaultId, deviceId, principalId }) });
    expect(await body(await handle(new Request("http://local/v1/head")))).toMatchObject({ revisionId: accepted.revisionId, sequence: 2 });
    expect((await body(await handle(new Request(`http://local/v1/revisions/${stale.revisionId}`)))).sequence).toBeNull();
    expect(await body(await handle(request(accepted, genesisId, "durable-accepted")))).toEqual({ status: "alreadyAccepted", revisionId: accepted.revisionId, sequence: 2 });
    expect((await body(await handle(request(stale, genesisId, "durable-stale")))).status).toBe("staleHead");
    database.close();
  });
});
