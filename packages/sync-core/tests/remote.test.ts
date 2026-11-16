import { afterEach, expect, test, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CHUNK_SIZE, canonicalizePersistedRevisionEnvelope, parsePersistedRevisionEnvelope } from "@nanosync/protocol";
import { ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase } from "../../server-metadata/src/index.ts";
import { LocalFilesystem } from "../../server-object-storage/src/index.ts";
import { createServerHandler, objectKey } from "../../server-core/src/index.ts";
import { encryptChunk, encryptManifest, HttpRemote, referenceSetMac, RemoteError, type ChunkJournal, type RemoteOptions } from "../src/index.ts";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const deviceId = "123e4567-e89b-42d3-a456-426614174002";
const rootId = "123e4567-e89b-42d3-a456-426614174003";
const genesisId = "123e4567-e89b-42d3-a456-426614174001";
const nextId = "123e4567-e89b-42d3-a456-426614174005";
const thirdId = "123e4567-e89b-42d3-a456-426614174006";
const token = "a".repeat(43);
const master = new Uint8Array(32).fill(7);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

async function setup() {
  const root = await mkdtemp(join(tmpdir(), "nanosync-remote-")); roots.push(root);
  const database = new ServerMetadataDatabase(":memory:");
  database.writeTransaction(tx => tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vaultId]));
  const filesystem = new LocalFilesystem(root);
  // Constructor-started staging recovery must settle before any test can tear down the root.
  await filesystem.list();
  const catalog = new ObjectCatalogRepository(database), revisions = new RevisionRepository(database);
  let revoked = false;
  const handle = createServerHandler({ filesystem, catalog, revisions, authorize: async request => {
    if (revoked || request.headers.get("authorization") !== `Bearer ${token}`) throw new Error("unauthorized");
    return { vaultId, deviceId, principalId: rootId };
  } });
  const calls: string[] = [];
  const transport: RemoteOptions["fetch"] = async input => {
    const request = input as Request; calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return handle(request);
  };
  const remote = (fetcher = transport, journal?: ChunkJournal, retries = 2) => new HttpRemote({ baseUrl: "http://local", token, fetch: fetcher, journal, retries });
  const genesisManifest = { version: 1 as const, vaultId, revisionId: genesisId, parents: [], creatingDeviceId: deviceId,
    entries: [{ id: rootId, parentId: null, name: "", kind: "directory" as const }] };
  const encrypted = await encryptManifest(genesisManifest, master);
  const genesis = parsePersistedRevisionEnvelope({ protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId: genesisId, parents: [],
    creatingDeviceId: deviceId, createdAt: "2026-01-01T00:00:00.000Z", encryptedManifestObjectId: encrypted.reference.objectId,
    references: [encrypted.reference], referenceSetMac: "0".repeat(64) });
  genesis.referenceSetMac = await referenceSetMac(genesis, master) as typeof genesis.referenceSetMac;
  database.writeTransaction(tx => {
    tx.run(`INSERT INTO object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms) VALUES (?, ?, 'manifest', ?, ?, 1, 1)`, [vaultId, encrypted.reference.objectId, encrypted.reference.ciphertextChecksum, encrypted.reference.ciphertextLength]);
    tx.run(`INSERT INTO revisions(vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, accepted_sequence, server_created_at_ms) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 1, 1)`, [vaultId, genesisId, deviceId, genesis.createdAt, encrypted.reference.objectId, genesis.referenceSetMac, canonicalizePersistedRevisionEnvelope(genesis), "0".repeat(64)]);
    tx.run(`INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version) VALUES (?, ?, ?, 'manifest', ?, ?, 1)`, [vaultId, genesisId, encrypted.reference.objectId, encrypted.reference.ciphertextChecksum, encrypted.reference.ciphertextLength]);
    tx.run("UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE singleton = 1", [genesisId]);
  });
  const manifest = (id = nextId) => ({ ...genesisManifest, revisionId: id, parents: [genesisId] });
  return { database, remote, transport, handle, calls, manifest, genesis, filesystem, revoke: () => { revoked = true; } };
}

test("request deadlines remain active while reading bodies and external cancellation reaches fetch", async () => {
  for (const phase of ["fetch", "body"] as const) {
    const timeout = new AbortController(), external = new AbortController(), started = Promise.withResolvers<Request>();
    const deadline = spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    try {
      const client = new HttpRemote({ baseUrl: "http://local", token, signal: external.signal, fetch: async input => {
        const request = input as Request;
        if (phase === "fetch") {
          started.resolve(request);
          return new Promise<Response>((_resolve, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true }));
        }
        return new Response(new ReadableStream({ start(controller) {
          request.signal.addEventListener("abort", () => controller.error(request.signal.reason), { once: true });
          started.resolve(request);
        } }), { headers: { "content-type": "application/json" } });
      } });
      const pending = client.capabilities();
      void pending.catch(() => {});
      const request = await started.promise;
      expect(deadline).toHaveBeenCalledWith(30_000);
      if (phase === "fetch") external.abort(new Error("cancelled request")); else timeout.abort(new Error("cancelled request"));
      await expect(pending).rejects.toThrow("cancelled request");
      expect(request.signal.aborted).toBe(true);
    } finally { deadline.mockRestore(); }
  }
});

test("negotiates, authenticates, publishes immutable frames, replays a lost acceptance and leaves stale head alone", async () => {
  const env = await setup(); const client = env.remote();
  expect((await client.capabilities()).limits.maximumPresenceQuery).toBe(1000);
  expect(await client.head()).toEqual({ revisionId: genesisId, sequence: 1 });
  expect((await client.revision(genesisId, master)).revision).toEqual(env.genesis);
  const chunk = await encryptChunk(new Uint8Array([9, 8, 7]), master, vaultId);
  const next = { ...env.manifest(), entries: [env.manifest().entries[0]!, {
    id: "123e4567-e89b-42d3-a456-426614174004", parentId: rootId, name: "data", kind: "file" as const,
    size: 3, sha256: createHash("sha256").update(new Uint8Array([9, 8, 7])).digest("hex"), executable: false,
    chunks: [{ objectId: chunk.reference.objectId, length: 3 }],
  }] };
  // The manifest parser validates shape, while file SHA-256 is verified when reconstructing the file.
  let lost = false;
  const dropping: RemoteOptions["fetch"] = async input => {
    const response = await env.transport(input);
    if (!lost && new URL((input as Request).url).pathname === "/v1/head/advance") { lost = true; await response.arrayBuffer(); throw new TypeError("lost response"); }
    return response;
  };
  const publisher = env.remote(dropping);
  expect((await publisher.publish(next, [], [chunk], master, genesisId, "2026-01-02T00:00:00.000Z")).status).toBe("alreadyAccepted");
  expect(env.calls.filter(call => call === "POST /v1/head/advance")).toHaveLength(2);
  expect(await client.download(chunk.reference, master, vaultId)).toEqual(new Uint8Array([9, 8, 7]));
  expect((await client.publish(env.manifest(thirdId), [], [], master, genesisId, "2026-01-02T00:00:00.000Z")).status).toBe("staleHead");
  expect((await client.head()).revisionId).toBe(nextId);
  env.revoke();
  await expect(client.head()).rejects.toMatchObject({ code: "UNAUTHORIZED", status: 401 });
});

test("retries truncated frame at chunk boundary, journals only verified bytes, and skips completed chunks", async () => {
  const env = await setup(); const chunk = await encryptChunk(new Uint8Array([1, 2, 3]), master, vaultId);
  await env.remote().upload(chunk, vaultId, `put-${chunk.reference.objectId}`);
  const saved = new Map<string, Uint8Array>();
  const journal: ChunkJournal = {
    get: async (_, ref) => saved.get(ref.ciphertextChecksum) ?? null,
    put: async (_, ref, bytes) => { saved.set(ref.ciphertextChecksum, bytes); },
  };
  let truncated = false, reads = 0;
  const dropping: RemoteOptions["fetch"] = async input => {
    const response = await env.transport(input);
    if ((input as Request).method === "GET" && new URL((input as Request).url).pathname.includes("/objects/chunk/")) {
      reads++;
      if (!truncated) {
        truncated = true;
        await response.body?.cancel();
        return new Response(new Uint8Array(4), { status: 200, headers: response.headers });
      }
    }
    return response;
  };
  const client = env.remote(dropping, journal);
  expect(await Array.fromAsync(client.downloadChunks([chunk.reference], master, vaultId))).toEqual([new Uint8Array([1, 2, 3])]);
  expect(reads).toBe(2);
  expect(await Array.fromAsync(client.downloadChunks([chunk.reference], master, vaultId))).toEqual([new Uint8Array([1, 2, 3])]);
  expect(reads).toBe(2);
  saved.set(chunk.reference.ciphertextChecksum, new Uint8Array([4]));
  expect(await Array.fromAsync(client.downloadChunks([chunk.reference], master, vaultId))).toEqual([new Uint8Array([1, 2, 3])]);
  expect(reads).toBe(3);
  const corrupted: RemoteOptions["fetch"] = async input => {
    const response = await env.transport(input);
    if ((input as Request).method === "GET") {
      const bytes = new Uint8Array(await response.arrayBuffer()); bytes[bytes.length - 1]! ^= 1;
      return new Response(bytes, { headers: response.headers });
    }
    return response;
  };
  await expect(env.remote(corrupted).download(chunk.reference, master, vaultId)).rejects.toThrow();
});

test("cached journal bytes cannot change after authentication starts, including mutable reference and master", async () => {
  const env = await setup(); const chunk = await encryptChunk(new Uint8Array([1, 2, 3]), master, vaultId);
  const cached = new Uint8Array([1, 2, 3]), mutableMaster = master.slice(), reference = { ...chunk.reference };
  const journal: ChunkJournal = {
    get: async () => cached,
    put: async () => { throw new Error("verified cached bytes should not require download"); },
  };
  const next = env.remote(undefined, journal).downloadChunks([reference], mutableMaster, vaultId).next();
  // get() has returned; encryption now crosses Web Crypto's asynchronous key derivation.
  await Promise.resolve(); await Promise.resolve();
  cached.fill(9); mutableMaster.fill(0);
  reference.ciphertextChecksum = "f".repeat(64) as typeof reference.ciphertextChecksum;
  expect((await next).value).toEqual(new Uint8Array([1, 2, 3]));
  expect(env.calls.some(call => call.startsWith("GET /v1/objects/"))).toBe(false);
});

test("downloadChunks freezes later references and the master key at first pull", async () => {
  const env = await setup();
  const first = await encryptChunk(new Uint8Array([1]), master, vaultId);
  const second = await encryptChunk(new Uint8Array([2]), master, vaultId);
  const references = [{ ...first.reference }, { ...second.reference }];
  const mutableMaster = master.slice(), returned = [new Uint8Array([1]), new Uint8Array([2])];
  const journal: ChunkJournal = {
    get: async (_, reference) => returned.find(bytes =>
      reference.objectId === (bytes[0] === 1 ? first.reference.objectId : second.reference.objectId)) ?? null,
    put: async () => { throw new Error("unexpected network read"); },
  };
  const chunks = env.remote(undefined, journal).downloadChunks(references, mutableMaster, vaultId);
  expect((await chunks.next()).value).toEqual(new Uint8Array([1]));
  references[1]!.objectId = "f".repeat(64) as typeof references[1]["objectId"];
  mutableMaster.fill(0);
  expect((await chunks.next()).value).toEqual(new Uint8Array([2]));
});

test("journal put cannot mutate plaintext yielded after a verified download", async () => {
  const env = await setup(), chunk = await encryptChunk(new Uint8Array([3, 4]), master, vaultId);
  await env.remote().upload(chunk, vaultId, "put-clone");
  const journal: ChunkJournal = {
    get: async () => null,
    put: async (_vault, _reference, bytes) => { bytes.fill(9); },
  };
  expect((await env.remote(undefined, journal).downloadChunks([chunk.reference], master, vaultId).next()).value)
    .toEqual(new Uint8Array([3, 4]));
});

test("download snapshots reference and master before negotiation and retains them through retries", async () => {
  const env = await setup(); const chunk = await encryptChunk(new Uint8Array([7, 8]), master, vaultId);
  await env.remote().upload(chunk, vaultId, "initial-upload");
  let unblock!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { unblock = resolve; });
  const waiting = new Promise<void>(resolve => { started = resolve; });
  let gets = 0;
  const transport: RemoteOptions["fetch"] = async input => {
    const pathname = new URL((input as Request).url).pathname;
    if (pathname === "/v1/capabilities") { started(); await gate; }
    if (pathname.startsWith("/v1/objects/chunk/") && (input as Request).method === "GET" && ++gets === 1)
      throw new TypeError("connection dropped");
    return env.transport(input);
  };
  const mutableMaster = master.slice(), reference = { ...chunk.reference };
  const downloading = env.remote(transport).download(reference, mutableMaster, vaultId);
  await waiting;
  mutableMaster.fill(0); reference.objectId = "f".repeat(64) as typeof reference.objectId;
  reference.ciphertextChecksum = "f".repeat(64) as typeof reference.ciphertextChecksum;
  reference.ciphertextLength = 97;
  unblock();
  expect(await downloading).toEqual(new Uint8Array([7, 8]));
  expect(gets).toBe(2);
});

test("rejects strict authorization errors and never retries revocation", async () => {
  const env = await setup(); env.revoke();
  try { await env.remote().presence("chunk", ["a".repeat(64)]); throw new Error("expected denial"); }
  catch (error) { expect(error).toBeInstanceOf(RemoteError); expect((error as RemoteError).code).toBe("UNAUTHORIZED"); }
  expect(env.calls.filter(call => call === "POST /v1/objects/presence")).toHaveLength(1);
});

test("presence sorts and batches IDs at the negotiated 1000 limit", async () => {
  const env = await setup();
  const ids = Array.from({ length: 1001 }, (_, n) => n.toString(16).padStart(64, "0")).reverse();
  const missing = await env.remote().presence("chunk", ids);
  expect(missing.size).toBe(1001);
  expect(env.calls.filter(call => call === "POST /v1/objects/presence")).toHaveLength(2);
});

test("rejects duplicate-key protocol errors instead of accepting ambiguous authorization state", async () => {
  const env = await setup();
  const tampered: RemoteOptions["fetch"] = async input => {
    if (new URL((input as Request).url).pathname === "/v1/head") return new Response(
      '{"protocolVersion":1,"code":"UNAUTHORIZED","code":"UNAVAILABLE","message":"Denied"}',
      { status: 401, headers: { "content-type": "application/json" } });
    return env.transport(input);
  };
  await expect(env.remote(tampered).head()).rejects.toThrow("duplicate JSON key");
});

test("publishes remote-only reused chunks and fails closed when a known chunk disappears", async () => {
  const env = await setup(), client = env.remote();
  const chunk = await encryptChunk(new Uint8Array([1, 2, 3]), master, vaultId);
  const file = { id: "123e4567-e89b-42d3-a456-426614174004", parentId: rootId, name: "data", kind: "file" as const,
    size: 3, sha256: createHash("sha256").update(new Uint8Array([1, 2, 3])).digest("hex"), executable: false,
    chunks: [{ objectId: chunk.reference.objectId, length: 3 }] };
  const first = { ...env.manifest(), entries: [env.manifest().entries[0]!, file] };
  expect((await client.publish(first, [], [chunk], master, genesisId, "2026-01-02T00:00:00.000Z")).status).toBe("accepted");
  const previous = (await client.revision(nextId, master)).revision;
  const known = previous.references.filter(ref => ref.objectType === "chunk");
  const second = { ...first, revisionId: thirdId, parents: [nextId] };
  const before = env.calls.length;
  expect((await client.publish(second, known, [], master, nextId, "2026-01-03T00:00:00.000Z")).status).toBe("accepted");
  expect(env.calls.slice(before).filter(call => call === "POST /v1/objects/presence")).toHaveLength(2);
  expect(env.calls.slice(before).filter(call => call.startsWith("PUT /v1/objects/chunk/"))).toHaveLength(0);

  await env.filesystem.delete(objectKey("chunk", chunk.reference.objectId));
  const third = { ...second, revisionId: "123e4567-e89b-42d3-a456-426614174007", parents: [thirdId] };
  const advanceCount = env.calls.filter(call => call === "POST /v1/head/advance").length;
  await expect(client.publish(third, known, [], master, thirdId, "2026-01-04T00:00:00.000Z")).rejects.toThrow("reused chunk is absent");
  expect(env.calls.filter(call => call === "POST /v1/head/advance")).toHaveLength(advanceCount);
  await expect(client.publish(third, known, [chunk, chunk], master, thirdId, "2026-01-04T00:00:00.000Z")).rejects.toThrow("duplicate");
  expect(env.calls.filter(call => call === "POST /v1/head/advance")).toHaveLength(advanceCount);
  expect((await client.publish(third, known, [chunk], master, thirdId, "2026-01-04T00:00:00.000Z")).status).toBe("accepted");
});

test("50 GB manifest reuses two immutable references without reading file bytes or per-chunk presence", async () => {
  const env = await setup(), client = env.remote();
  const size = 50_000_000_000;
  const fullCount = Math.floor(size / CHUNK_SIZE), tail = size % CHUNK_SIZE;
  const full = await encryptChunk(new Uint8Array(CHUNK_SIZE), master, vaultId);
  const last = await encryptChunk(new Uint8Array(tail), master, vaultId);
  const frames = [full, last].sort((a, b) => a.reference.objectId < b.reference.objectId ? -1 : 1);
  const file = { id: "123e4567-e89b-42d3-a456-426614174004", parentId: rootId, name: "huge", kind: "file" as const,
    size, sha256: "a".repeat(64), executable: false,
    chunks: [...Array.from({ length: fullCount }, () => ({ objectId: full.reference.objectId, length: CHUNK_SIZE })),
      { objectId: last.reference.objectId, length: tail }] };
  const first = { ...env.manifest(), entries: [env.manifest().entries[0]!, file] };
  expect((await client.publish(first, [], frames, master, genesisId, "2026-01-02T00:00:00.000Z")).status).toBe("accepted");
  const refs = (await client.revision(nextId, master)).revision.references.filter(ref => ref.objectType === "chunk");
  const before = env.calls.length;
  expect((await client.publish({ ...first, revisionId: thirdId, parents: [nextId] }, refs, [], master, nextId,
    "2026-01-03T00:00:00.000Z")).status).toBe("accepted");
  expect(env.calls.slice(before).filter(call => call === "POST /v1/objects/presence")).toHaveLength(2);
  expect(env.calls.slice(before).filter(call => call.startsWith("PUT /v1/objects/chunk/"))).toHaveLength(0);
});

test("publishes file-order streamed frames with descending pseudorandom IDs without buffering or sorting ciphertext", async () => {
  const env = await setup(), client = env.remote();
  const a = await encryptChunk(new Uint8Array(CHUNK_SIZE).fill(1), master, vaultId);
  const b = await encryptChunk(new Uint8Array(CHUNK_SIZE).fill(2), master, vaultId);
  const frames = [a, b].sort((left, right) => left.reference.objectId > right.reference.objectId ? -1 : 1);
  expect(frames[0]!.reference.objectId > frames[1]!.reference.objectId).toBe(true);
  const hash = createHash("sha256");
  hash.update(new Uint8Array(CHUNK_SIZE).fill(frames[0] === a ? 1 : 2));
  hash.update(new Uint8Array(CHUNK_SIZE).fill(frames[1] === a ? 1 : 2));
  const file = { id: "123e4567-e89b-42d3-a456-426614174004", parentId: rootId, name: "ordered", kind: "file" as const,
    size: 2 * CHUNK_SIZE, sha256: hash.digest("hex"), executable: false,
    chunks: frames.map(frame => ({ objectId: frame.reference.objectId, length: CHUNK_SIZE })) };
  async function* fileOrder() { yield frames[0]!; yield frames[1]!; }
  expect((await client.publish({ ...env.manifest(), entries: [env.manifest().entries[0]!, file] }, [], fileOrder(),
    master, genesisId, "2026-01-02T00:00:00.000Z")).status).toBe("accepted");
  const published = (await client.revision(nextId, master)).revision.references.filter(ref => ref.objectType === "chunk");
  expect(published.map(ref => ref.objectId)).toEqual(frames.map(frame => frame.reference.objectId).reverse());
  expect(env.calls.filter(call => call === "POST /v1/objects/presence")).toHaveLength(2);
  expect(env.calls.filter(call => call.startsWith("PUT /v1/objects/chunk/"))).toHaveLength(2);
});

test("rejects an advertised idempotency key limit below 128-bit hex keys", async () => {
  const env = await setup();
  const limited: RemoteOptions["fetch"] = async input => {
    const response = await env.transport(input);
    if (new URL((input as Request).url).pathname !== "/v1/capabilities") return response;
    const caps = await response.json(); caps.limits.maximumIdempotencyKeyLength = 31;
    return new Response(JSON.stringify(caps), { headers: { "content-type": "application/json" } });
  };
  await expect(env.remote(limited).capabilities()).rejects.toThrow("collision-resistant idempotency keys");
  expect(env.calls.filter(call => call.startsWith("PUT "))).toHaveLength(0);
});

test("rejects forged frame checksum, AEAD and chunk identity before publication", async () => {
  const env = await setup(), client = env.remote();
  const chunk = await encryptChunk(new Uint8Array([5]), master, vaultId);
  const file = { id: "123e4567-e89b-42d3-a456-426614174004", parentId: rootId, name: "f", kind: "file" as const,
    size: 1, sha256: createHash("sha256").update(new Uint8Array([5])).digest("hex"), executable: false,
    chunks: [{ objectId: chunk.reference.objectId, length: 1 }] };
  const manifest = { ...env.manifest(), entries: [env.manifest().entries[0]!, file] };
  const tampered = { frame: chunk.frame.slice(), reference: { ...chunk.reference } };
  tampered.frame[tampered.frame.length - 1]! ^= 1;
  tampered.reference.ciphertextChecksum = createHash("sha256").update(tampered.frame).digest("hex") as typeof tampered.reference.ciphertextChecksum;
  await expect(client.publish(manifest, [], [tampered], master, genesisId, "2026-01-02T00:00:00.000Z")).rejects.toThrow();
  expect(env.calls.filter(call => call.startsWith("PUT /v1/objects/chunk/"))).toHaveLength(0);
  const badId = { frame: chunk.frame.slice(), reference: { ...chunk.reference } };
  badId.frame[32] = badId.frame[32]! ^ 1;
  badId.reference.objectId = Buffer.from(badId.frame.subarray(32, 64)).toString("hex") as typeof badId.reference.objectId;
  badId.reference.ciphertextChecksum = createHash("sha256").update(badId.frame).digest("hex") as typeof badId.reference.ciphertextChecksum;
  const wrongManifest = { ...manifest, entries: [manifest.entries[0]!, { ...file, chunks: [{ objectId: badId.reference.objectId, length: 1 }] }] };
  await expect(client.publish(wrongManifest, [], [badId], master, genesisId, "2026-01-02T00:00:00.000Z")).rejects.toThrow();
});

test("upload snapshots frame and reference before async negotiation and every retry", async () => {
  const env = await setup(); const chunk = await encryptChunk(new Uint8Array([9, 9]), master, vaultId);
  const original = { frame: chunk.frame.slice(), reference: { ...chunk.reference } };
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let first = true;
  const transport: RemoteOptions["fetch"] = async input => {
    if (new URL((input as Request).url).pathname === "/v1/capabilities") await gate;
    if ((input as Request).method === "PUT" && first) {
      first = false;
      await (input as Request).arrayBuffer();
      throw new TypeError("lost upload response");
    }
    return env.transport(input);
  };
  const uploading = env.remote(transport).upload(chunk, vaultId, `put-${chunk.reference.objectId}`);
  chunk.frame.fill(0); chunk.reference.ciphertextChecksum = "f".repeat(64) as typeof chunk.reference.ciphertextChecksum;
  release();
  expect(await uploading).toBe("stored");
  expect(await env.remote().download(original.reference, master, vaultId)).toEqual(new Uint8Array([9, 9]));
});


test("permanently deleted vault is terminal, not a retried outage", async () => {
  const env = await setup();
  const { VaultRepository } = await import('../../server-metadata/src/index.ts');
  new VaultRepository(env.database).markDeleted(vaultId,{origin:'server-local',actorId:null},10);
  try {
    await env.remote().presence('chunk',['a'.repeat(64)]);
    throw Error('expected deleted vault');
  } catch (error) {
    expect(error).toMatchObject({status:410,code:'VAULT_DELETED'});
    expect((error as Error).message).toContain('Local files and keys are preserved');
  }
  expect(env.calls.filter(call => call === 'POST /v1/objects/presence')).toHaveLength(1);
  env.database.close();
});
