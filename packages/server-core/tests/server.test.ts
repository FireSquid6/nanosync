import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OBJECT_TYPE_CODES, parseCapabilityResponse } from "@nanosync/protocol";
import { ObjectCatalogRepository, ServerMetadataDatabase } from "@nanosync/server-metadata";
import { LocalFilesystem } from "@nanosync/server-object-storage";
import { ApiError, createServerConfig, createServerHandler, errorResponse, objectKey } from "../src/index.ts";

const roots: string[] = [];
const vaultId = "123e4567-e89b-12d3-a456-426614174000";
const deviceId = "223e4567-e89b-12d3-a456-426614174000";
const principalId = "323e4567-e89b-12d3-a456-426614174000";
const objectId = "ab" + "0".repeat(62);
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function setup(authorize: (request: Request) => Promise<any> = async () => ({ vaultId, deviceId, principalId }), seed = true) {
  const root = await mkdtemp(join(tmpdir(), "nanosync-core-")); roots.push(root);
  const filesystem = new LocalFilesystem(root); const database = new ServerMetadataDatabase(":memory:");
  await filesystem.existsBatch([]);
  if (seed) database.writeTransaction((tx) => tx.run(
    "INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vaultId],
  ));
  const catalog = new ObjectCatalogRepository(database);
  return { root, filesystem, database, catalog, handle: createServerHandler({ filesystem, catalog, authorize }) };
}
function uuidBytes(uuid: string): Uint8Array { return Uint8Array.from(uuid.replaceAll("-", "").match(/../g)!, (part) => Number.parseInt(part, 16)); }
function frame(type: "chunk" | "manifest" | "revision-private" = "chunk", id = objectId, payloadLength = 5): Uint8Array {
  const nonce = type === "chunk" ? 0 : 12; const bytes = new Uint8Array(80 + nonce + payloadLength + 16); const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("NSOBJ001")); view.setUint16(8, 1); view.setUint16(10, 1); view.setUint8(12, OBJECT_TYPE_CODES[type]); view.setUint8(13, nonce);
  bytes.set(uuidBytes(vaultId), 16); bytes.set(Uint8Array.from(id.match(/../g)!, (part) => Number.parseInt(part, 16)), 32);
  view.setBigUint64(64, BigInt(payloadLength)); view.setBigUint64(72, BigInt(payloadLength)); bytes.fill(7, 80); return bytes;
}
function putRequest(bytes: Uint8Array, key = "upload-1", id = objectId, extra: Record<string, string> = {}): Request {
  const checksum = createHash("sha256").update(bytes).digest("hex");
  return new Request(`http://local/v1/objects/chunk/${id}`, { method: "PUT", body: bytes, headers: {
    "content-length": String(bytes.byteLength), "x-nanosync-protocol-version": "1", "x-nanosync-object-format-version": "1",
    "x-nanosync-ciphertext-sha256": checksum, "idempotency-key": key, ...extra,
  } });
}
async function body(response: Response): Promise<any> { return response.json(); }
async function promptly<T>(promise: Promise<T>): Promise<T> {
  return Promise.race([promise, Bun.sleep(250).then(() => { throw new Error("operation did not settle promptly"); })]);
}

describe("configuration and public boundary", () => {
  test("defaults to loopback and requires acknowledgement for exposure", () => {
    expect(createServerConfig()).toMatchObject({ hostname: "127.0.0.1", port: 7337 });
    expect(() => createServerConfig({ hostname: "0.0.0.0" })).toThrow();
    const warnings: string[] = []; expect(createServerConfig({ hostname: "0.0.0.0", acknowledgeInsecureNonLoopback: true }, (value) => warnings.push(value))).toMatchObject({ hostname: "0.0.0.0" });
    expect(warnings).toHaveLength(1);
  });
  test("serves exact capabilities and safe health", async () => {
    const { handle } = await setup();
    const capabilityResponse = await handle(new Request("http://local/v1/capabilities"));
    expect(capabilityResponse.status).toBe(200); expect(parseCapabilityResponse(await body(capabilityResponse)).limits.chunkSizeBytes).toBe(4_194_304);
    expect(await body(await handle(new Request("http://local/v1/health")))).toEqual({ protocolVersion: 1, status: "ok" });
  });
  test("never reaches protected routes without valid injected authorization", async () => {
    for (const authorize of [async () => { throw new Error("no"); }, async () => ({ vaultId: "bad", deviceId, principalId })]) {
      const { handle } = await setup(authorize);
      const response = await handle(new Request("http://local/v1/objects/presence", { method: "POST" }));
      expect(response.status).toBe(401); expect(await body(response)).toEqual({ protocolVersion: 1, code: "UNAUTHORIZED", message: "Authorization is required" });
    }
  });
  test("cannot initialize an empty server or cross the initialized vault boundary", async () => {
    const empty = await setup(async () => ({ vaultId, deviceId, principalId }), false); const bytes = frame();
    const denied = await empty.handle(putRequest(bytes));
    expect(denied.status).toBe(503);
    expect(empty.database.get<{ count: number }>("SELECT count(*) AS count FROM server_state")?.count).toBe(0);
    expect(await empty.filesystem.existsBatch([objectKey("chunk", objectId)])).toEqual([false]);

    const initialized = await setup();
    const otherVault = "423e4567-e89b-12d3-a456-426614174000";
    const otherHandle = createServerHandler({ filesystem: initialized.filesystem, catalog: initialized.catalog, authorize: async () => ({ vaultId: otherVault, deviceId, principalId }) });
    expect((await otherHandle(putRequest(bytes, "other-vault"))).status).toBe(403);
    const presence = new Request("http://local/v1/objects/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: [objectId] }) });
    expect((await otherHandle(presence)).status).toBe(403);
    expect((await otherHandle(new Request(`http://local/v1/objects/chunk/${objectId}`))).status).toBe(403);
  });
});

describe("streaming object routes", () => {
  test("uploads, catalogs, replays idempotently, downloads, and rejects key reuse", async () => {
    const { handle, catalog } = await setup(); const bytes = frame();
    expect(await body(await handle(putRequest(bytes)))).toEqual({ protocolVersion: 1, status: "stored" });
    expect(catalog.get(vaultId as any, objectId as any)).toMatchObject({ object_type: "chunk", ciphertext_length: bytes.byteLength });
    expect(await body(await handle(putRequest(bytes)))).toEqual({ protocolVersion: 1, status: "stored" });
    const conflict = await handle(putRequest(bytes, "upload-1", objectId, { "x-nanosync-ciphertext-sha256": "1".repeat(64) }));
    expect(conflict.status).toBe(409); expect((await body(conflict)).code).toBe("IDEMPOTENCY_KEY_REUSE");
    const downloaded = await handle(new Request(`http://local/v1/objects/chunk/${objectId}`));
    expect(downloaded.status).toBe(200); expect(downloaded.headers.get("content-length")).toBe(String(bytes.byteLength));
    expect(downloaded.headers.get("x-nanosync-object-type")).toBe("chunk");
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });
  test("supports closed, open, and suffix ranges and rejects malformed ranges", async () => {
    const { handle } = await setup(); const bytes = frame(); await handle(putRequest(bytes));
    for (const [range, expected] of [["bytes=1-3", bytes.slice(1, 4)], ["bytes=80-", bytes.slice(80)], ["bytes=-5", bytes.slice(-5)]] as const) {
      const response = await handle(new Request(`http://local/v1/objects/chunk/${objectId}`, { headers: { range } }));
      expect(response.status).toBe(206); expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array(expected));
    }
    for (const range of ["bytes=0-1,3-4", "items=0-1", "bytes=999-"]) {
      const response = await handle(new Request(`http://local/v1/objects/chunk/${objectId}`, { headers: { range } }));
      expect(response.status).toBe(416); expect(response.headers.get("content-range")).toBe(`bytes */${bytes.byteLength}`);
    }
  });
  test("handles fragmented headers and rejects bad headers without consuming later body", async () => {
    const { handle, catalog } = await setup(); const bytes = frame(); let offset = 0;
    const fragmented = new ReadableStream<Uint8Array>({ pull(controller) { if (offset === bytes.length) return controller.close(); const end = Math.min(bytes.length, offset + 7); controller.enqueue(bytes.slice(offset, end)); offset = end; } });
    const base = putRequest(bytes, "fragmented"); const request = new Request(base.url, { method: "PUT", headers: base.headers, body: fragmented as any });
    expect((await body(await handle(request))).status).toBe("stored");
    const bad = frame(undefined, "cd" + "0".repeat(62)); bad[0] = 0; let pulls = 0;
    const hostile = new ReadableStream<Uint8Array>({ pull(controller) { pulls++; if (pulls === 1) controller.enqueue(bad.slice(0, 80)); else throw new Error("over-read"); } });
    const badBase = putRequest(bad, "bad", "cd" + "0".repeat(62));
    const response = await handle(new Request(badBase.url, { method: "PUT", headers: badBase.headers, body: hostile as any }));
    expect(response.status).toBe(400); expect(pulls).toBeLessThanOrEqual(2); expect(catalog.get(vaultId as any, ("cd" + "0".repeat(62)) as any)).toBeNull();
  });
  test("repairs the durable-storage/catalog crash boundary", async () => {
    const { handle, filesystem, catalog } = await setup(); const bytes = frame(); const checksum = createHash("sha256").update(bytes).digest("hex");
    await filesystem.putIfAbsent(objectKey("chunk", objectId), new Blob([bytes]).stream(), checksum);
    expect(catalog.get(vaultId as any, objectId as any)).toBeNull();
    expect(await body(await handle(putRequest(bytes, "repair")))).toEqual({ protocolVersion: 1, status: "alreadyPresent" });
    expect(catalog.get(vaultId as any, objectId as any)).not.toBeNull();
  });
  test("does not catalog checksum, frame identity, or body length mismatches", async () => {
    const { handle, filesystem, catalog } = await setup();
    const checksumId = "10" + "0".repeat(62), identityId = "20" + "0".repeat(62), shortId = "30" + "0".repeat(62);
    const checksumBytes = frame("chunk", checksumId);
    const checksumResponse = await handle(putRequest(checksumBytes, "bad-checksum", checksumId, { "x-nanosync-ciphertext-sha256": "f".repeat(64) }));
    expect(checksumResponse.status).toBe(400);
    const identityBytes = frame("chunk", objectId);
    const identityResponse = await handle(putRequest(identityBytes, "bad-identity", identityId));
    expect(identityResponse.status).toBe(400);
    const shortBytes = frame("chunk", shortId); const base = putRequest(shortBytes, "short", shortId);
    const truncated = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(shortBytes.slice(0, -1)); controller.close(); } });
    const shortResponse = await handle(new Request(base.url, { method: "PUT", headers: base.headers, body: truncated as any }));
    expect(shortResponse.status).toBe(400);
    for (const id of [checksumId, identityId, shortId]) {
      expect(catalog.get(vaultId as any, id as any)).toBeNull();
      expect(await filesystem.existsBatch([objectKey("chunk", id)])).toEqual([false]);
    }
  });
  test("rejects trailing bytes, header length mismatches, unsupported versions, and reserved flags", async () => {
    const { handle, catalog } = await setup(); const id = "40" + "0".repeat(62); const valid = frame("chunk", id);
    const trailingBase = putRequest(valid, "trailing", id);
    const trailingBody = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(valid); controller.enqueue(new Uint8Array([1])); controller.close(); } });
    expect((await handle(new Request(trailingBase.url, { method: "PUT", headers: trailingBase.headers, body: trailingBody as any }))).status).toBe(400);
    const mismatch = frame("chunk", id); new DataView(mismatch.buffer).setBigUint64(64, 4n); new DataView(mismatch.buffer).setBigUint64(72, 4n);
    expect((await handle(putRequest(mismatch, "length-header", id))).status).toBe(400);
    const crypto = frame("chunk", id); new DataView(crypto.buffer).setUint16(10, 2);
    const format = frame("chunk", id); new DataView(format.buffer).setUint16(8, 2);
    const flags = frame("chunk", id); new DataView(flags.buffer).setUint16(14, 1);
    for (const [key, bytes] of [["crypto", crypto], ["format", format], ["flags", flags]] as const) {
      expect((await handle(putRequest(bytes, key, id))).status).toBe(400);
    }
    expect((await handle(putRequest(valid, "protocol", id, { "x-nanosync-protocol-version": "2" }))).status).toBe(400);
    expect((await handle(putRequest(valid, "request-format", id, { "x-nanosync-object-format-version": "2" }))).status).toBe(400);
    expect(catalog.get(vaultId as any, id as any)).toBeNull();
  });
  test("rejects missing upload metadata/body and type limits before consuming the body", async () => {
    const { handle, catalog } = await setup(); const id = "50" + "0".repeat(62); const bytes = frame("chunk", id); const checksum = createHash("sha256").update(bytes).digest("hex");
    let cancelled = false;
    const hostile = new ReadableStream<Uint8Array>({ cancel() { cancelled = true; return new Promise<void>(() => {}); } });
    const missingHeader = new Request(`http://local/v1/objects/chunk/${id}`, { method: "PUT", body: hostile as any, headers: { "idempotency-key": "missing", "x-nanosync-ciphertext-sha256": checksum } });
    expect((await promptly(handle(missingHeader))).status).toBe(400); expect(cancelled).toBe(true);
    const headers = { "content-length": String(bytes.byteLength), "x-nanosync-protocol-version": "1", "x-nanosync-object-format-version": "1", "x-nanosync-ciphertext-sha256": checksum, "idempotency-key": "no-body" };
    expect((await handle(new Request(`http://local/v1/objects/chunk/${id}`, { method: "PUT", headers }))).status).toBe(400);
    const lazy = new ReadableStream<Uint8Array>();
    const oversized = new Request(`http://local/v1/objects/chunk/${id}`, { method: "PUT", body: lazy as any, headers: { ...headers, "content-length": String(80 + 4_194_304 + 16 + 1), "idempotency-key": "too-large" } });
    expect((await handle(oversized)).status).toBe(413); expect(catalog.get(vaultId as any, id as any)).toBeNull();
  });
  test("handles concurrent identical uploads", async () => {
    const { handle, catalog } = await setup(); const bytes = frame();
    const responses = await Promise.all([handle(putRequest(bytes, "race-a")), handle(putRequest(bytes, "race-b"))]);
    expect(responses.every((response) => response.status === 200 || response.status === 201)).toBe(true);
    expect(catalog.get(vaultId as any, objectId as any)).not.toBeNull();
  });
  test("turns catalog/storage divergence into marked unavailable integrity failures", async () => {
    const missing = await setup(); const bytes = frame(); await missing.handle(putRequest(bytes));
    await missing.filesystem.delete(objectKey("chunk", objectId));
    const missingResponse = await missing.handle(new Request(`http://local/v1/objects/chunk/${objectId}`));
    expect(missingResponse.status).toBe(503); expect((await body(missingResponse)).code).toBe("UNAVAILABLE");
    expect(missing.catalog.get(vaultId as any, objectId as any)?.integrity_status).toBe("missing");

    const corrupt = await setup(); await corrupt.handle(putRequest(bytes));
    await truncate(join(corrupt.root, objectKey("chunk", objectId)), bytes.byteLength - 1);
    const corruptResponse = await corrupt.handle(new Request(`http://local/v1/objects/chunk/${objectId}`));
    expect(corruptResponse.status).toBe(503); expect(corrupt.catalog.get(vaultId as any, objectId as any)?.integrity_status).toBe("corrupt");
    const absent = await corrupt.handle(new Request(`http://local/v1/objects/chunk/${"f".repeat(64)}`));
    expect(absent.status).toBe(404);
  });
  test("a verified retry restores missing storage and clears only integrity state", async () => {
    const { handle, filesystem, catalog } = await setup(); const bytes = frame();
    await handle(putRequest(bytes, "initial"));
    const before = catalog.get(vaultId as any, objectId as any)!;
    await filesystem.delete(objectKey("chunk", objectId));
    expect((await handle(new Request(`http://local/v1/objects/chunk/${objectId}`))).status).toBe(503);
    expect(catalog.get(vaultId as any, objectId as any)?.integrity_status).toBe("missing");
    expect((await handle(putRequest(bytes, "initial"))).status).toBe(200);
    expect(catalog.get(vaultId as any, objectId as any)?.integrity_status).toBe("missing");
    expect(await filesystem.existsBatch([objectKey("chunk", objectId)])).toEqual([false]);

    const restored = await handle(putRequest(bytes, "restore"));
    expect(restored.status).toBe(201);
    const after = catalog.get(vaultId as any, objectId as any)!;
    expect(after).toMatchObject({ integrity_status: "unchecked", integrity_checked_at_ms: null });
    expect({ ...after, integrity_status: before.integrity_status, integrity_checked_at_ms: before.integrity_checked_at_ms }).toEqual(before);
    expect(await filesystem.existsBatch([objectKey("chunk", objectId)])).toEqual([true]);
    const downloaded = await handle(new Request(`http://local/v1/objects/chunk/${objectId}`));
    expect(downloaded.status).toBe(200);
    expect(new Uint8Array(await downloaded.arrayBuffer())).toEqual(new Uint8Array(bytes));
  });
});

describe("presence and request errors", () => {
  test("preserves presence order and does not report a missing catalog file", async () => {
    const { handle, filesystem, catalog } = await setup(); const bytes = frame(); await handle(putRequest(bytes));
    const request = () => new Request("http://local/v1/objects/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: [objectId] }) });
    expect((await body(await handle(request()))).objects).toEqual([{ objectId, present: true }]);
    await filesystem.delete(objectKey("chunk", objectId)); expect((await body(await handle(request()))).objects).toEqual([{ objectId, present: false }]);
    expect(catalog.get(vaultId as any, objectId as any)?.integrity_status).toBe("missing");
  });
  test("rejects duplicate-key JSON, duplicate IDs, unknown methods and routes safely", async () => {
    const { handle } = await setup();
    const duplicateJson = await handle(new Request("http://local/v1/objects/presence", { method: "POST", headers: { "content-type": "application/json" }, body: `{"protocolVersion":1,"protocolVersion":1,"objectType":"chunk","objectIds":["${objectId}"]}` }));
    expect(duplicateJson.status).toBe(400);
    const duplicateIds = await handle(new Request("http://local/v1/objects/presence", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: [objectId, objectId] }) }));
    expect(duplicateIds.status).toBe(400);
    expect((await handle(new Request("http://local/v1/capabilities", { method: "POST" }))).status).toBe(405);
    expect((await handle(new Request("http://local/nope"))).status).toBe(404);
  });
  test("strictly bounds and parses presence JSON", async () => {
    const { handle } = await setup(); const url = "http://local/v1/objects/presence";
    const request = (bodyValue: string | Uint8Array | ReadableStream<Uint8Array>, headers: Record<string, string> = {}) => handle(new Request(url, { method: "POST", body: bodyValue as any, headers: { "content-type": "application/json", ...headers } }));
    for (const malformed of ["\u00a0{}", "{", new Uint8Array([0xff])]) expect((await request(malformed)).status).toBe(400);
    const valid = JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: [objectId] });
    for (const declared of [String(new TextEncoder().encode(valid).byteLength - 1), String(new TextEncoder().encode(valid).byteLength + 1)]) {
      const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode(valid)); controller.close(); } });
      expect((await request(stream as any, { "content-length": declared })).status).toBe(400);
    }
    const unsorted = JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: ["f".repeat(64), objectId] });
    expect((await request(unsorted)).status).toBe(400);
    const tooMany = JSON.stringify({ protocolVersion: 1, objectType: "chunk", objectIds: Array.from({ length: 1001 }, (_, index) => index.toString(16).padStart(64, "0")) });
    expect((await request(tooMany)).status).toBe(413);
    let cancelled = false;
    const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(128 * 1024 + 1)); }, cancel() { cancelled = true; } });
    expect((await request(oversized as any)).status).toBe(413); expect(cancelled).toBe(true);
  });
  test("emits stable safe protocol errors for representative endpoint failures", async () => {
    const { handle, database } = await setup();
    const bad = await handle(new Request("http://local/v1/objects/presence", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    expect(bad.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await body(bad)).toEqual({ protocolVersion: 1, code: "MALFORMED_REQUEST", message: "JSON body is malformed" });
    const notFound = await handle(new Request("http://local/not-found")); expect(notFound.headers.get("content-type")).toBe("application/json; charset=utf-8"); expect(await body(notFound)).toEqual({ protocolVersion: 1, code: "NOT_FOUND", message: "Route not found" });
    const method = await handle(new Request("http://local/v1/capabilities", { method: "POST" }));
    expect(method.status).toBe(405); expect(method.headers.get("allow")).toBe("GET"); expect(method.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(await body(method)).toEqual({ protocolVersion: 1, code: "MALFORMED_REQUEST", message: "Method is not supported for this route" });
    const limited = await handle(new Request("http://local/v1/objects/presence", { method: "POST", body: new ReadableStream<Uint8Array>() as any, headers: { "content-type": "application/json", "content-length": "200000" } }));
    expect(limited.status).toBe(413); expect(limited.headers.get("content-type")).toBe("application/json; charset=utf-8"); expect(await body(limited)).toEqual({ protocolVersion: 1, code: "BODY_LIMIT_EXCEEDED", message: "JSON body exceeds the request limit" });
    const bytes = frame(); const checksum = createHash("sha256").update(bytes).digest("hex");
    await handle(putRequest(bytes, "range-source"));
    const range = await handle(new Request(`http://local/v1/objects/chunk/${objectId}`, { headers: { range: "bytes=999-" } }));
    expect(range.status).toBe(416); expect(range.headers.get("content-type")).toBe("application/json; charset=utf-8"); expect(await body(range)).toEqual({ protocolVersion: 1, code: "MALFORMED_REQUEST", message: "Requested byte range is not satisfiable" });
    const digest = createHash("sha256").update(["put-object-v1", vaultId, "chunk", objectId, bytes.byteLength, checksum, 1].join("\0")).digest("hex");
    database.writeTransaction((tx) => tx.run(
      `INSERT INTO idempotency_records
       (principal_id, device_id, operation, idempotency_key, request_digest, outcome, result_json, created_at_ms, expires_at_ms)
       VALUES (?, ?, 'put-object-v1', 'corrupt-result', ?, 'success', ?, 0, 1)`,
      [principalId, deviceId, digest, '{"protocolVersion":1,"status":"stored","extra":true}'],
    ));
    const internal = await handle(putRequest(bytes, "corrupt-result"));
    expect(internal.status).toBe(500); expect(internal.headers.get("content-type")).toBe("application/json; charset=utf-8"); expect(await body(internal)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
    const sanitized = errorResponse(new ApiError(500, "INTERNAL", "unsafe\nmessage"));
    expect(await body(sanitized)).toEqual({ protocolVersion: 1, code: "INTERNAL", message: "Request failed" });
  });
});
