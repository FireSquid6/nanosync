import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_JSON_METADATA_BYTES, OBJECT_TYPE_CODES } from "@nanosync/protocol";
import { BootstrapRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase, type PasswordVerifierRecord } from "@nanosync/server-metadata";
import { LocalFilesystem, ObjectStorageError, type Filesystem } from "@nanosync/server-object-storage";
import { Argon2idPasswordHasher, createServerHandler, objectKey, passwordVerifierPhc, type PasswordHasher } from "../src/index.ts";

const roots: string[] = [];
const vaultId = "123e4567-e89b-12d3-a456-426614174000";
const otherVaultId = "223e4567-e89b-12d3-a456-426614174000";
const principalId = "323e4567-e89b-12d3-a456-426614174000";
const deviceId = "423e4567-e89b-12d3-a456-426614174000";
const otherDeviceId = "523e4567-e89b-12d3-a456-426614174000";
const revisionId = "623e4567-e89b-12d3-a456-426614174000";
const manifestId = "a".repeat(64);
const bootstrapSecret = "operator-bootstrap-secret";

afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

const fakeRecord = (): PasswordVerifierRecord => ({ algorithm: "argon2id", version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 1, salt: new Uint8Array(16).fill(4), hash: new Uint8Array(32).fill(5) });
const fakeHasher: PasswordHasher = { hash: async () => fakeRecord() };
const wrap = { version: 1, algorithm: "A256GCM", nonce: "AQEBAQEBAQEBAQEB", ciphertext: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIC" };
const initializeBody = { protocolVersion: 1, principalId, vaultId, initialDeviceId: deviceId, password: "not stored plaintext", recoveryWrap: wrap };

interface Environment {
  root: string;
  filesystem: LocalFilesystem;
  database: ServerMetadataDatabase;
  catalog: ObjectCatalogRepository;
  revisions: RevisionRepository;
  bootstrap: BootstrapRepository;
  handle: (request: Request) => Promise<Response>;
}
interface SetupOptions {
  path?: string;
  authorizeBootstrap?: ((request: Request) => Promise<boolean>) | null;
  hasher?: PasswordHasher;
}
async function setup(options: SetupOptions = {}): Promise<Environment> {
  const root = await mkdtemp(join(tmpdir(), "nanosync-bootstrap-")); roots.push(root);
  const filesystem = new LocalFilesystem(root); await filesystem.existsBatch([]);
  const database = new ServerMetadataDatabase(options.path ?? ":memory:");
  const catalog = new ObjectCatalogRepository(database), revisions = new RevisionRepository(database), bootstrap = new BootstrapRepository(database);
  const handle = makeHandler({ filesystem, catalog, revisions, bootstrap }, options.authorizeBootstrap === undefined ? async () => true : options.authorizeBootstrap ?? undefined, options.hasher ?? fakeHasher);
  return { root, filesystem, database, catalog, revisions, bootstrap, handle };
}
function makeHandler(parts: { filesystem: Filesystem; catalog: ObjectCatalogRepository; revisions: RevisionRepository; bootstrap: BootstrapRepository }, authorizeBootstrap: ((request: Request) => Promise<boolean>) | undefined, hasher: PasswordHasher = fakeHasher) {
  return createServerHandler({ ...parts, authorizeBootstrap, passwordHasher: hasher, authorize: async () => { throw new Error("normal authorization unavailable"); }, clock: () => 100 });
}
function jsonRequest(path: string, value: unknown, headers: Record<string, string> = { "content-type": "application/json" }): Request {
  return new Request(`http://local${path}`, { method: "POST", headers, body: JSON.stringify(value) });
}
function hexBytes(hex: string): Uint8Array { return Uint8Array.from(hex.match(/../g) ?? [], (part) => Number.parseInt(part, 16)); }
function uuidBytes(uuid: string): Uint8Array { return hexBytes(uuid.replaceAll("-", "")); }
function manifestFrame(): Uint8Array {
  const bytes = new Uint8Array(109), view = new DataView(bytes.buffer); bytes.set(new TextEncoder().encode("NSOBJ001")); view.setUint16(8, 1); view.setUint16(10, 1); view.setUint8(12, OBJECT_TYPE_CODES.manifest); view.setUint8(13, 12); bytes.set(uuidBytes(vaultId), 16); bytes.set(hexBytes(manifestId), 32); view.setBigUint64(64, 1n); view.setBigUint64(72, 1n); bytes.fill(7, 80); return bytes;
}
function upload(bytes = manifestFrame(), key = "bootstrap-manifest"): Request {
  return new Request(`http://local/v1/bootstrap/objects/manifest/${manifestId}`, { method: "PUT", body: bytes, headers: { "content-length": String(bytes.length), "x-nanosync-protocol-version": "1", "x-nanosync-object-format-version": "1", "x-nanosync-ciphertext-sha256": createHash("sha256").update(bytes).digest("hex"), "idempotency-key": key } });
}
function genesis(checksum: string, options: { length?: number; creator?: string; vault?: string } = {}) {
  const vault = options.vault ?? vaultId;
  return { protocolVersion: 1, revisionFormatVersion: 1, vaultId: vault, revisionId, parents: [], creatingDeviceId: options.creator ?? deviceId, createdAt: "2026-01-01T00:00:00.000Z", encryptedManifestObjectId: manifestId, references: [{ objectId: manifestId, objectType: "manifest", ciphertextChecksum: checksum, ciphertextLength: options.length ?? 109, objectFormatVersion: 1 }], referenceSetMac: "b".repeat(64) };
}
function completion(envelope: ReturnType<typeof genesis>, vault = envelope.vaultId): Request { return jsonRequest("/v1/bootstrap/complete", { protocolVersion: 1, vaultId: vault, genesisRevision: envelope }); }
async function data(response: Response): Promise<unknown> { return response.json(); }
async function initialize(env: Environment): Promise<void> { expect((await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody))).status).toBe(201); }
function head(env: Environment): { current_head_revision_id: string | null; current_sequence: number } | null { return env.database.get("SELECT current_head_revision_id, current_sequence FROM server_state"); }
function expectRetryable(env: Environment): void { expect(env.bootstrap.status()).toBe("initializedWithoutHead"); expect(head(env)).toEqual({ current_head_revision_id: null, current_sequence: 0 }); }

describe("bootstrap authorization, status, and routes", () => {
  test("reports only safe status and fails closed without accepted authorization", async () => {
    for (const authorize of [null, async () => false, async () => { throw new Error(bootstrapSecret); }]) {
      const env = await setup({ authorizeBootstrap: authorize });
      expect(await data(await env.handle(new Request("http://local/v1/bootstrap/status")))).toEqual({ protocolVersion: 1, status: "uninitialized" });
      const response = await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody));
      expect(response.status).toBe(401);
      const responseText = JSON.stringify(await data(response));
      expect(responseText).toBe('{"protocolVersion":1,"code":"UNAUTHORIZED","message":"Bootstrap authorization is required"}');
      for (const secret of [bootstrapSecret, initializeBody.password, wrap.nonce, wrap.ciphertext]) expect(responseText).not.toContain(secret);
      expect(env.bootstrap.status()).toBe("uninitialized");
    }
  });

  test("returns unavailable when the bootstrap repository dependency is absent", async () => {
    const env = await setup();
    const handle = createServerHandler({ filesystem: env.filesystem, catalog: env.catalog, revisions: env.revisions, authorize: async () => { throw new Error(); } });
    const response = await handle(new Request("http://local/v1/bootstrap/status"));
    expect(response.status).toBe(503); expect(await data(response)).toEqual({ protocolVersion: 1, code: "UNAVAILABLE", message: "Bootstrap service is unavailable" });
  });

  test("exposes exactly PUT on a syntactically valid bootstrap object path", async () => {
    const env = await setup(); await initialize(env);
    const validPath = `http://local/v1/bootstrap/objects/manifest/${manifestId}`;
    for (const method of ["GET", "POST", "DELETE"]) {
      const response = await env.handle(new Request(validPath, { method }));
      expect(response.status).toBe(405); expect(response.headers.get("allow")).toBe("PUT");
    }
    for (const path of ["/v1/bootstrap/objects", "/v1/bootstrap/objects/", "/v1/bootstrap/objects/presence", `/v1/bootstrap/objects/manifest/${manifestId}/extra`]) {
      expect((await env.handle(new Request(`http://local${path}`, { method: "POST" }))).status).toBe(404);
    }
    expect((await env.handle(upload())).status).toBe(201);
  });
});

describe("bootstrap lifecycle", () => {
  test("initializes once, stores no plaintext password, streams an object, atomically seals, and disables every mutation", async () => {
    const env = await setup(); await initialize(env);
    expect(env.bootstrap.status()).toBe("initializedWithoutHead");
    expect(JSON.stringify(env.database.all("SELECT * FROM accounts"))).not.toContain(initializeBody.password);
    expect(env.bootstrap.passwordVerifier()).toEqual(fakeRecord());
    const bytes = manifestFrame(), digest = createHash("sha256").update(bytes).digest("hex");
    expect(await data(await env.handle(upload(bytes)))).toEqual({ protocolVersion: 1, status: "stored" });
    expect(await data(await env.handle(completion(genesis(digest))))).toEqual({ protocolVersion: 1, status: "accepted", revisionId, sequence: 1 });
    expect(await data(await env.handle(new Request("http://local/v1/bootstrap/status")))).toEqual({ protocolVersion: 1, status: "sealed" });
    expect(head(env)).toEqual({ current_head_revision_id: revisionId, current_sequence: 1 });
    expect((await env.handle(upload(bytes, "after-seal"))).status).toBe(403);
    expect((await env.handle(completion(genesis(digest)))).status).toBe(403);
    expect((await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody))).status).toBe(409);
  });

  test("has one deterministic winner under initialize and completion races", async () => {
    const env = await setup();
    const initialization = await Promise.all([env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody)), env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody))]);
    expect(initialization.map((item) => item.status).sort()).toEqual([201, 409]);
    const bytes = manifestFrame(), digest = createHash("sha256").update(bytes).digest("hex"); await env.handle(upload(bytes));
    const completionResults = await Promise.all([env.handle(completion(genesis(digest))), env.handle(completion(genesis(digest)))]);
    expect(completionResults.map((item) => item.status).sort()).toEqual([200, 409]);
  });

  test("rolls back genesis/head/seal together after an injected SQL failure and permits retry", async () => {
    const env = await setup(); await initialize(env); const bytes = manifestFrame(), digest = createHash("sha256").update(bytes).digest("hex"); await env.handle(upload(bytes));
    env.database.writeTransaction((tx) => tx.run("CREATE TRIGGER injected_bootstrap_failure BEFORE UPDATE ON bootstrap_state BEGIN SELECT RAISE(ABORT, 'injected'); END"));
    const failed = await env.handle(completion(genesis(digest))); expect(failed.status).toBe(500); expect(await data(failed)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" }); expectRetryable(env);
    expect(env.database.get<{ count: number }>("SELECT count(*) AS count FROM revisions")?.count).toBe(0);
    env.database.writeTransaction((tx) => tx.run("DROP TRIGGER injected_bootstrap_failure"));
    expect((await env.handle(completion(genesis(digest)))).status).toBe(200);
  });

  test("persists validated initialized lifecycle across reopen", async () => {
    const dbRoot = await mkdtemp(join(tmpdir(), "nanosync-bootstrap-db-")); roots.push(dbRoot); const path = join(dbRoot, "metadata.sqlite");
    const env = await setup({ path }); await initialize(env); env.database.close();
    const reopened = new ServerMetadataDatabase(path), bootstrap = new BootstrapRepository(reopened);
    expect(bootstrap.status()).toBe("initializedWithoutHead"); expect(bootstrap.passwordVerifier()).toEqual(fakeRecord()); reopened.close();
  });
});

describe("genesis rejection and retry", () => {
  test("returns exact safe outcomes for identity, catalog, and physical storage failures", async () => {
    const env = await setup(); await initialize(env); const bytes = manifestFrame(), digest = createHash("sha256").update(bytes).digest("hex"); await env.handle(upload(bytes));

    let response = await env.handle(completion(genesis(digest, { vault: otherVaultId }), otherVaultId));
    expect(response.status).toBe(409); expect(await data(response)).toEqual({ protocolVersion: 1, code: "CONFLICT", message: "Genesis revision is invalid" }); expectRetryable(env);

    response = await env.handle(completion(genesis(digest, { creator: otherDeviceId })));
    expect(response.status).toBe(409); expect(await data(response)).toEqual({ protocolVersion: 1, code: "CONFLICT", message: "Genesis revision is invalid" }); expectRetryable(env);

    response = await env.handle(completion(genesis("f".repeat(64))));
    expect(response.status).toBe(200); expect(await data(response)).toEqual({ protocolVersion: 1, status: "missingObjects", objectIds: [manifestId] }); expectRetryable(env);

    response = await env.handle(completion(genesis(digest, { length: 110 })));
    expect(response.status).toBe(200); expect(await data(response)).toEqual({ protocolVersion: 1, status: "missingObjects", objectIds: [manifestId] }); expectRetryable(env);

    await env.filesystem.delete(objectKey("manifest", manifestId));
    response = await env.handle(completion(genesis(digest)));
    expect(response.status).toBe(200); expect(await data(response)).toEqual({ protocolVersion: 1, status: "missingObjects", objectIds: [manifestId] }); expectRetryable(env);

    const wrongBytes = new Uint8Array(110).fill(9), wrongDigest = createHash("sha256").update(wrongBytes).digest("hex");
    await env.filesystem.putIfAbsent(objectKey("manifest", manifestId), new Blob([wrongBytes]).stream(), wrongDigest);
    response = await env.handle(completion(genesis(digest)));
    expect(response.status).toBe(200); expect(await data(response)).toEqual({ protocolVersion: 1, status: "missingObjects", objectIds: [manifestId] }); expectRetryable(env);

    await env.filesystem.delete(objectKey("manifest", manifestId)); await env.handle(upload(bytes, "repair-storage"));
    const failedFilesystem: Filesystem = { ...env.filesystem, putIfAbsent: env.filesystem.putIfAbsent.bind(env.filesystem), open: env.filesystem.open.bind(env.filesystem), existsBatch: env.filesystem.existsBatch.bind(env.filesystem), delete: env.filesystem.delete.bind(env.filesystem), list: env.filesystem.list.bind(env.filesystem), stat: async () => { throw new ObjectStorageError("UNSAFE_PATH", "internal secret path"); } };
    const failedHandler = makeHandler({ filesystem: failedFilesystem, catalog: env.catalog, revisions: env.revisions, bootstrap: env.bootstrap }, async () => true);
    response = await failedHandler(completion(genesis(digest)));
    expect(response.status).toBe(500); expect(await data(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" }); expectRetryable(env);

    expect((await env.handle(completion(genesis(digest)))).status).toBe(200);
    expect(env.bootstrap.status()).toBe("sealed");
  });
});

describe("strict transport and corruption handling", () => {
  test("rejects content type, duplicate, unsupported, declared oversized, and streamed oversized JSON exactly", async () => {
    const env = await setup();
    expect((await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody, {}))).status).toBe(400);
    expect((await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody, { "content-type": "text/plain" }))).status).toBe(400);
    const duplicate = JSON.stringify(initializeBody).replace('{"protocolVersion":1', '{"protocolVersion":1,"protocolVersion":1');
    expect((await env.handle(new Request("http://local/v1/bootstrap/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: duplicate }))).status).toBe(400);
    let response = await env.handle(jsonRequest("/v1/bootstrap/initialize", { ...initializeBody, protocolVersion: 2 }));
    expect(response.status).toBe(400); expect(await data(response)).toEqual({ protocolVersion: 1, code: "UNSUPPORTED_PROTOCOL_VERSION", message: "Bootstrap request is invalid" });
    response = await env.handle(jsonRequest("/v1/bootstrap/initialize", { ...initializeBody, recoveryWrap: { ...wrap, version: 2 } }));
    expect(response.status).toBe(400); expect(await data(response)).toEqual({ protocolVersion: 1, code: "UNSUPPORTED_FORMAT_VERSION", message: "Bootstrap request is invalid" });
    response = await env.handle(new Request("http://local/v1/bootstrap/initialize", { method: "POST", headers: { "content-type": "application/json", "content-length": String(MAX_JSON_METADATA_BYTES + 1) }, body: "x" }));
    expect(response.status).toBe(413);
    response = await env.handle(new Request("http://local/v1/bootstrap/initialize", { method: "POST", headers: { "content-type": "application/json" }, body: new Uint8Array(MAX_JSON_METADATA_BYTES + 1) }));
    expect(response.status).toBe(413); expect(env.bootstrap.status()).toBe("uninitialized");
  });

  test("classifies unsupported genesis versions as format failures without parser detail", async () => {
    const env = await setup(); await initialize(env); const digest = createHash("sha256").update(manifestFrame()).digest("hex");
    for (const genesisRevision of [{ ...genesis(digest), revisionFormatVersion: 2 }, { ...genesis(digest), protocolVersion: 2 }]) {
      const response = await env.handle(completion(genesisRevision as ReturnType<typeof genesis>));
      expect(response.status).toBe(400);
      expect(await data(response)).toEqual({ protocolVersion: 1, code: "UNSUPPORTED_FORMAT_VERSION", message: "Bootstrap request is invalid" });
    }
    expectRetryable(env);
  });

  test("zeros the temporary password bytes when hashing throws and writes no state", async () => {
    let supplied: Uint8Array | undefined;
    const hasher: PasswordHasher = { hash: async (password) => { supplied = password; throw new Error(`hash failed: ${initializeBody.password}`); } };
    const env = await setup({ hasher }); const response = await env.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody));
    expect(response.status).toBe(500); expect(await data(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
    expect(supplied).toBeDefined(); expect([...supplied!].every((byte) => byte === 0)).toBe(true); expect(env.bootstrap.status()).toBe("uninitialized");
  });

  test("turns partial and lifecycle/head-corrupt persisted state into generic errors and blocks initialization", async () => {
    const partial = await setup(); partial.database.writeTransaction((tx) => tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vaultId]));
    let response = await partial.handle(new Request("http://local/v1/bootstrap/status"));
    expect(response.status).toBe(500); expect(await data(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
    expect((await partial.handle(jsonRequest("/v1/bootstrap/initialize", initializeBody))).status).toBe(500);

    const missingIdentity = await setup(); await initialize(missingIdentity); missingIdentity.database.writeTransaction((tx) => tx.run("DELETE FROM recovery_wraps"));
    response = await missingIdentity.handle(new Request("http://local/v1/bootstrap/status")); expect(response.status).toBe(500); expect(await data(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });

    const lifecycle = await setup(); await initialize(lifecycle);
    lifecycle.database.writeTransaction((tx) => { tx.run("DROP TRIGGER bootstrap_seal_once"); tx.run("UPDATE bootstrap_state SET lifecycle = 'sealed', sealed_at_ms = 101"); });
    response = await lifecycle.handle(new Request("http://local/v1/bootstrap/status")); expect(response.status).toBe(500); expect(await data(response)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
  });
});

test("real Argon2id baseline uses a 16-byte salt and interoperates with Bun verification", async () => {
  const verifier = await new Argon2idPasswordHasher().hash(new TextEncoder().encode("integration password"));
  expect(verifier).toMatchObject({ algorithm: "argon2id", version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 1 });
  expect(verifier.salt).toHaveLength(16); expect(verifier.hash).toHaveLength(32);
  expect(await Bun.password.verify("integration password", passwordVerifierPhc(verifier))).toBe(true);
  expect(await Bun.password.verify("wrong", passwordVerifierPhc(verifier))).toBe(false);
});
