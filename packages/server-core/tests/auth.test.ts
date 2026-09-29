import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthenticationRepository, BootstrapRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase, type PasswordVerifierRecord } from "@nanosync/server-metadata";
import { LocalFilesystem } from "@nanosync/server-object-storage";
import { AuthenticationService, createServerHandler, type PasswordHasher } from "../src/index.ts";
import { Argon2idPasswordHasher } from "../src/index.ts";
import { hashRaw } from "@node-rs/argon2";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const vaultId = "123e4567-e89b-12d3-a456-426614174000";
const principalId = "223e4567-e89b-12d3-a456-426614174000";
const initialId = "323e4567-e89b-12d3-a456-426614174000";
const secondId = "423e4567-e89b-12d3-a456-426614174000";
const backupAdminId = "623e4567-e89b-12d3-a456-426614174000";
const revisionId = "523e4567-e89b-12d3-a456-426614174000";
const manifestId = "a".repeat(64), checksum = "b".repeat(64);
const bootstrapProof = "independent-operator-proof";
const verifier = (): PasswordVerifierRecord => ({ algorithm: "argon2id", version: 19, memoryKiB: 65_536, iterations: 3, parallelism: 1, salt: new Uint8Array(16).fill(1), hash: new Uint8Array(32).fill(2) });
const password: PasswordHasher = { hash: async () => verifier(), verify: async (bytes) => new TextDecoder().decode(bytes) === "correct password" };

async function setup(authorizeBootstrap: ((request: Request) => Promise<boolean>) | null = async (request) => request.headers.get("x-nanosync-bootstrap-authorization") === bootstrapProof && request.headers.get("authorization") === null) {
  const root = await mkdtemp(join(tmpdir(), "nanosync-auth-")); roots.push(root);
  const filesystem = new LocalFilesystem(root); await filesystem.existsBatch([]);
  const database = new ServerMetadataDatabase(":memory:"); const bootstrap = new BootstrapRepository(database);
  bootstrap.initialize({ protocolVersion: 1, principalId: principalId as any, vaultId: vaultId as any, initialDeviceId: initialId as any, password: "discarded", recoveryWrap: { version: 1, algorithm: "A256GCM", nonce: Buffer.alloc(12, 1).toString("base64url"), ciphertext: Buffer.alloc(48, 2).toString("base64url") } }, verifier(), 1);
  database.writeTransaction((tx) => tx.run("INSERT INTO object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms) VALUES (?, ?, 'manifest', ?, 109, 1, 2)", [vaultId, manifestId, checksum]));
  bootstrap.complete(vaultId as any, { protocolVersion: 1, revisionFormatVersion: 1, vaultId: vaultId as any, revisionId: revisionId as any, parents: [], creatingDeviceId: initialId as any, createdAt: "2026-01-01T00:00:00.000Z", encryptedManifestObjectId: manifestId as any, references: [{ objectId: manifestId as any, objectType: "manifest", ciphertextChecksum: checksum as any, ciphertextLength: 109, objectFormatVersion: 1 }], referenceSetMac: "c".repeat(64) as any }, 3);
  let now = 10, randomCounter = 1;
  const auth = new AuthenticationService(new AuthenticationRepository(database), { pepper: new Uint8Array(32).fill(9), password, clock: () => now, random: () => new Uint8Array(32).fill(randomCounter++) });
  const catalog = new ObjectCatalogRepository(database), revisions = new RevisionRepository(database);
  const handle = createServerHandler({ filesystem, catalog, revisions, bootstrap, authentication: auth, authorizeBootstrap: authorizeBootstrap ?? undefined });
  return { database, handle, auth, setNow: (value: number) => { now = value; } };
}
function post(path: string, body: unknown, token?: string, extraHeaders: Record<string, string> = {}): Request { return new Request(`http://local${path}`, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...extraHeaders }, body: JSON.stringify(body) }); }
async function json(response: Response): Promise<any> { return response.json(); }
async function login(handle: (request: Request) => Promise<Response>): Promise<string> { const response = await handle(post("/v1/auth/password", { protocolVersion: 1, password: "correct password" })); expect(response.headers.get("cache-control")).toBe("no-store"); return (await json(response)).sessionToken; }
function enrollment(deviceId: string) { return { protocolVersion: 1, deviceId, displayName: deviceId === initialId ? "Initial laptop" : "Phone", platform: "linux", clientVersion: "1.0.0", fingerprint: Buffer.alloc(32, deviceId === initialId ? 3 : 4).toString("base64url") }; }

describe("production authentication lifecycle", () => {
  test("requires a strong external pepper and verifies/upgrades a real legacy Argon2id record", async () => {
    const { database } = await setup();
    expect(() => new AuthenticationService(new AuthenticationRepository(database), { pepper: new Uint8Array(31), password })).toThrow();
    expect(() => new AuthenticationService(new AuthenticationRepository(database), { pepper: new Uint8Array(65), password })).toThrow();
    const salt = new Uint8Array(16).fill(8), passwordBytes = new TextEncoder().encode("legacy password");
    const hash = await hashRaw(passwordBytes, { algorithm: 2 as any, version: 1 as any, memoryCost: 8192, timeCost: 1, parallelism: 1, outputLen: 32, salt });
    database.writeTransaction((tx) => tx.run("UPDATE accounts SET password_memory_kib=8192,password_iterations=1,password_salt=?,password_hash=?,password_updated_at_ms=2 WHERE singleton=1", [salt, hash]));
    const service = new AuthenticationService(new AuthenticationRepository(database), { pepper: new Uint8Array(32).fill(5), password: new Argon2idPasswordHasher(), clock: () => 100, random: () => new Uint8Array(32).fill(6) });
    await expect(service.login("wrong password")).rejects.toMatchObject({ status: 401, code: "UNAUTHORIZED" });
    const success = await service.login("legacy password"); expect(success.status).toBe(200);
    expect(database.get<{ password_memory_kib: number; password_iterations: number; password_parallelism: number; salt_bytes: number; hash_bytes: number }>("SELECT password_memory_kib,password_iterations,password_parallelism,length(password_salt) AS salt_bytes,length(password_hash) AS hash_bytes FROM accounts")).toEqual({ password_memory_kib: 65_536, password_iterations: 3, password_parallelism: 1, salt_bytes: 16, hash_bytes: 32 });
    const stale = { algorithm: "argon2id" as const, version: 19 as const, memoryKiB: 8192, iterations: 1, parallelism: 1, salt, hash: Uint8Array.from(hash) };
    expect(() => new AuthenticationRepository(database).loginSucceeded(new Uint8Array(32).fill(99), 101, stale)).toThrow(expect.objectContaining({ code: "UNAUTHORIZED" }));
    passwordBytes.fill(0);
  });
  test("activates bootstrap administrator and approves, protects, recovers, and revokes a second device", async () => {
    const { database, handle } = await setup();
    const first = await login(handle);
    expect((await handle(post("/v1/auth/enrollments", enrollment(initialId), first))).status).toBe(401);
    expect((await handle(post("/v1/auth/enrollments", enrollment(initialId), first, { "x-nanosync-bootstrap-authorization": "wrong" }))).status).toBe(401);
    let response = await handle(post("/v1/auth/enrollments", enrollment(initialId), first, { "x-nanosync-bootstrap-authorization": bootstrapProof }));
    expect(await json(response)).toMatchObject({ status: "approved", deviceId: initialId });
    expect(await json(await handle(post("/v1/auth/enrollments", enrollment(initialId), first)))).toMatchObject({ status: "approved" });
    expect((await handle(new Request("http://local/v1/head", { headers: { authorization: `Bearer ${first}` } }))).status).toBe(200);
    expect((await handle(post(`/v1/admin/devices/${initialId}/revoke`, { protocolVersion: 1 }, first))).status).toBe(403);

    const second = await login(handle);
    const duplicateEnrollment = await Promise.all([handle(post("/v1/auth/enrollments", enrollment(secondId), second)), handle(post("/v1/auth/enrollments", enrollment(secondId), second))]);
    expect(await Promise.all(duplicateEnrollment.map(json))).toEqual([{ protocolVersion: 1, status: "pending", deviceId: secondId }, { protocolVersion: 1, status: "pending", deviceId: secondId }]);
    expect((await handle(new Request("http://local/v1/head", { headers: { authorization: `Bearer ${second}` } }))).status).toBe(401);
    expect((await handle(post(`/v1/admin/enrollments/${secondId}/approve`, { protocolVersion: 1 }, second))).status).toBe(401);
    const approvals = await Promise.all([handle(post(`/v1/admin/enrollments/${secondId}/approve`, { protocolVersion: 1 }, first)), handle(post(`/v1/admin/enrollments/${secondId}/approve`, { protocolVersion: 1 }, first))]);
    expect(await Promise.all(approvals.map(json))).toEqual([{ protocolVersion: 1, status: "approved", deviceId: secondId }, { protocolVersion: 1, status: "approved", deviceId: secondId }]);
    expect((await handle(new Request("http://local/v1/head", { headers: { authorization: `Bearer ${second}` } }))).status).toBe(200);
    expect((await handle(new Request("http://local/v1/admin/devices", { headers: { authorization: `Bearer ${second}` } }))).status).toBe(403);
    response = await handle(new Request("http://local/v1/recovery-wrap", { headers: { authorization: `Bearer ${second}` } }));
    expect(response.headers.get("cache-control")).toBe("no-store"); expect((await json(response)).recoveryWrap).toMatchObject({ version: 1, algorithm: "A256GCM" });

    expect((await handle(post(`/v1/admin/devices/${secondId}/revoke`, { protocolVersion: 1 }, first))).status).toBe(200);
    expect((await handle(new Request("http://local/v1/head", { headers: { authorization: `Bearer ${second}` } }))).status).toBe(401);
    expect(database.get<{ credential_digest: Uint8Array | null }>("SELECT credential_digest FROM devices WHERE device_id=?", [secondId])?.credential_digest).toBeNull();
    expect(JSON.stringify(database.all("SELECT * FROM audit_events"))).not.toContain(first);
    expect(JSON.stringify(database.all("SELECT * FROM audit_events"))).not.toContain(second);
  });

  test("expires an unbound password session at the exact boundary", async () => {
    const { handle, setNow } = await setup(); const token = await login(handle);
    setNow(600_010);
    expect((await handle(post("/v1/auth/enrollments", enrollment(initialId), token))).status).toBe(401);
    expect((await handle(new Request("http://local/v1/auth/enrollments/status", { headers: { authorization: `Bearer ${token}` } }))).status).toBe(401);
  });

  test("expiration removes an abandoned pending device and permits clean re-enrollment", async () => {
    const { database, handle, setNow } = await setup(); const first = await login(handle);
    await handle(post("/v1/auth/enrollments", enrollment(initialId), first, { "x-nanosync-bootstrap-authorization": bootstrapProof }));
    const abandoned = await login(handle); await handle(post("/v1/auth/enrollments", enrollment(secondId), abandoned));
    setNow(86_400_010);
    expect((await handle(new Request("http://local/v1/auth/enrollments/status", { headers: { authorization: `Bearer ${abandoned}` } }))).status).toBe(401);
    const replacement = await login(handle);
    expect((await handle(post("/v1/auth/enrollments", enrollment(secondId), replacement))).status).toBe(202);
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM enrollment_requests WHERE device_id=?", [secondId])?.count).toBe(1);
  });

  test("fails initial activation closed when the bootstrap authorizer is absent or throws", async () => {
    for (const authorizer of [null, async () => false, async () => { throw new Error("operator secret"); }]) {
      const env = await setup(authorizer); const token = await login(env.handle);
      const response = await env.handle(post("/v1/auth/enrollments", enrollment(initialId), token, { "x-nanosync-bootstrap-authorization": bootstrapProof }));
      expect(response.status).toBe(401); expect(JSON.stringify(await json(response))).not.toContain("operator secret");
      expect(env.database.get<{ state: string }>("SELECT state FROM devices WHERE device_id=?", [initialId])?.state).toBe("pending");
    }
  });

  test("persists lockout and rejects malformed bearer forms and self revocation", async () => {
    const { database, handle } = await setup();
    for (let index = 0; index < 5; index++) await handle(post("/v1/auth/password", { protocolVersion: 1, password: "wrong" }));
    const limited = await handle(post("/v1/auth/password", { protocolVersion: 1, password: "correct password" }));
    expect(limited.status).toBe(429); expect((await json(limited)).code).toBe("RATE_LIMITED");
    expect(database.get<{ locked_until_ms: number }>("SELECT locked_until_ms FROM authentication_rate_limit")!.locked_until_ms).toBeGreaterThan(10);

    for (const authorization of [undefined, "bearer " + "A".repeat(43), "Bearer bad", `Bearer ${"A".repeat(43)}, Bearer ${"A".repeat(43)}`]) {
      const response = await handle(new Request("http://local/v1/head", { headers: authorization ? { authorization } : {} })); expect(response.status).toBe(401);
    }
  });

  test("a concurrent successful verification cannot commit after failures establish lockout", async () => {
    const { database } = await setup();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const entered = new Promise<void>((resolve) => { started = resolve; });
    const controlled: PasswordHasher = { hash: async () => verifier(), verify: async (bytes) => { const value = new TextDecoder().decode(bytes); if (value === "correct password") { started(); await gate; return true; } return false; } };
    const service = new AuthenticationService(new AuthenticationRepository(database), { pepper: new Uint8Array(32).fill(7), password: controlled, clock: () => 100, random: () => new Uint8Array(32).fill(8) });
    const successful = service.login("correct password"); await entered;
    await Promise.allSettled(Array.from({ length: 5 }, () => service.login("wrong")));
    release();
    await expect(successful).rejects.toMatchObject({ code: "LOCKED" });
    expect(database.get<{ count: number }>("SELECT count(*) AS count FROM password_sessions")?.count).toBe(0);
  });

  test("transactional admin operations reject an actor revoked after authentication", async () => {
    const { database, handle } = await setup(); const first = await login(handle);
    expect((await handle(post("/v1/auth/enrollments", enrollment(initialId), first, { "x-nanosync-bootstrap-authorization": bootstrapProof }))).status).toBe(200);
    const second = await login(handle); expect((await handle(post("/v1/auth/enrollments", enrollment(secondId), second))).status).toBe(202);
    database.writeTransaction((tx) => {
      tx.run("INSERT INTO devices(device_id,principal_id,vault_id,state,role,credential_digest,is_initial,created_at_ms,approved_at_ms) VALUES(?,?,?,'active','administrator',?,0,20,20)", [backupAdminId, principalId, vaultId, new Uint8Array(32).fill(77)]);
      tx.run("UPDATE devices SET state='revoked',credential_digest=NULL,revoked_at_ms=21 WHERE device_id=?", [initialId]);
    });
    const repository = new AuthenticationRepository(database);
    expect(() => repository.approve(initialId as any, secondId as any, 22)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
    database.writeTransaction((tx) => tx.run("UPDATE devices SET state='active',credential_digest=?,approved_at_ms=22 WHERE device_id=?", [new Uint8Array(32).fill(78), secondId]));
    expect(() => repository.revoke(initialId as any, secondId as any, 23)).toThrow(expect.objectContaining({ code: "FORBIDDEN" }));
  });
});
