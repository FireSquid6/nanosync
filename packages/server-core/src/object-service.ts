import { createHash } from "node:crypto";
import {
  AES_GCM_TAG_BYTES, CHUNK_SIZE, OBJECT_FORMAT_VERSION, OBJECT_FRAME_HEADER_BYTES, PROTOCOL_VERSION, RANDOMIZED_NONCE_BYTES,
  ProtocolValidationError, parseCiphertextChecksum, parseIdempotencyKey, parseObjectFrameHeader,
  type CiphertextChecksum, type DeviceId, type IdempotencyKey, type ObjectId, type ObjectType,
  type PrincipalId, type VaultId,
} from "@nanosync/protocol";
import {
  ObjectCatalogRepository, ObjectRepositoryError, type UploadIdentity, type UploadResultRecord,
} from "@nanosync/server-metadata";
import { ObjectStorageError, type ByteRange, type Filesystem } from "@nanosync/server-object-storage";
import { ApiError, json } from "./http.ts";

export interface AuthorizationContext { principalId: PrincipalId; deviceId: DeviceId; vaultId: VaultId; }
export interface ObjectServiceOptions {
  filesystem: Filesystem;
  catalog: ObjectCatalogRepository;
  maximumObjectSize: number;
  clock?: () => number;
}

export class ObjectService {
  private readonly clock: () => number;
  constructor(private readonly options: ObjectServiceOptions) { this.clock = options.clock ?? Date.now; }

  async presence(context: AuthorizationContext, objectType: ObjectType, objectIds: ObjectId[]): Promise<Response> {
    this.repositoryCall(() => this.options.catalog.requireVault(context.vaultId));
    const cataloged = this.repositoryCall(() => this.options.catalog.find(context.vaultId, objectType, objectIds));
    const rows = objectIds.map((id) => cataloged.get(id));
    const keys = rows.flatMap((row) => row ? [objectKey(row.object_type, row.object_id, this.storageVault(context.vaultId))] : []);
    const existence = await this.options.filesystem.existsBatch(keys);
    let position = 0;
    const missing: ObjectId[] = [];
    const objects = objectIds.map((objectId, index) => {
      const row = rows[index];
      if (!row) return { objectId, present: false };
      const present = existence[position++] ?? false;
      if (!present) missing.push(objectId);
      return { objectId, present };
    });
    if (missing.length) this.options.catalog.markMissing(context.vaultId, missing, this.clock());
    return json({ protocolVersion: PROTOCOL_VERSION, objectType, objects });
  }

  async put(request: Request, context: AuthorizationContext, objectType: ObjectType, objectId: ObjectId): Promise<Response> {
    let metadata: UploadMetadata;
    try {
      this.repositoryCall(() => this.options.catalog.requireVault(context.vaultId));
      metadata = uploadMetadata(request, this.options.maximumObjectSize);
      const framingBytes = OBJECT_FRAME_HEADER_BYTES + (objectType === "chunk" ? 0 : RANDOMIZED_NONCE_BYTES) + AES_GCM_TAG_BYTES;
      const typeMaximum = objectType === "chunk" ? framingBytes + CHUNK_SIZE : this.options.maximumObjectSize;
      if (metadata.contentLength < framingBytes + 1) throw new ApiError(400, "LENGTH_MISMATCH", "Content length is below the object type minimum");
      if (metadata.contentLength > typeMaximum) throw new ApiError(413, "OBJECT_LIMIT_EXCEEDED", "Object exceeds the type-specific limit");
    } catch (error) {
      cancelNoWait(request.body);
      throw error;
    }
    const identity: UploadIdentity = {
      principalId: context.principalId,
      deviceId: context.deviceId,
      vaultId: context.vaultId,
      idempotencyKey: metadata.idempotencyKey,
      requestDigest: requestDigest(context.vaultId, objectType, objectId, metadata),
    };
    let replay: UploadResultRecord | null;
    try { replay = this.repositoryCall(() => this.options.catalog.idempotency(identity)); }
    catch (error) {
      cancelNoWait(request.body);
      throw error;
    }
    if (replay) {
      cancelNoWait(request.body);
      return json(replay);
    }
    if (!request.body) throw new ApiError(400, "MALFORMED_REQUEST", "An object body is required");
    const reader = (request.body as ReadableStream<Uint8Array>).getReader();
    let prefix: { header: Uint8Array; remainder: Uint8Array };
    try {
      prefix = await readHeader(reader);
    } catch (error) {
      cancelReaderNoWait(reader);
      reader.releaseLock();
      throw error;
    }
    let frame;
    try {
      frame = parseObjectFrameHeader(prefix.header);
      if (frame.objectType !== objectType || frame.objectId !== objectId || frame.vaultId !== context.vaultId) {
        throw new ApiError(400, "MALFORMED_REQUEST", "Object frame identity does not match the request");
      }
      if (frame.objectFormatVersion !== metadata.objectFormatVersion) {
        throw new ApiError(400, "UNSUPPORTED_FORMAT_VERSION", "Object format header does not match the request");
      }
      if (frame.completeLength !== metadata.contentLength) {
        throw new ApiError(400, "LENGTH_MISMATCH", "Content length does not match the object frame");
      }
      if (frame.completeLength > this.options.maximumObjectSize) {
        throw new ApiError(413, "OBJECT_LIMIT_EXCEEDED", "Object exceeds the configured limit");
      }
    } catch (error) {
      cancelReaderNoWait(reader);
      reader.releaseLock();
      if (error instanceof ProtocolValidationError) throw protocolFrameError(error);
      throw error;
    }
    const stream = exactObjectStream(reader, prefix.header, prefix.remainder, frame.completeLength);
    let stored;
    try {
      stored = await this.options.filesystem.putIfAbsent(objectKey(objectType, objectId, this.storageVault(context.vaultId)), stream, metadata.checksum);
    } catch (error) {
      throw storageError(error);
    }
    if (stored.size !== frame.completeLength) {
      throw new ApiError(409, "LENGTH_MISMATCH", "Stored object length does not match metadata");
    }
    const result: UploadResultRecord = { protocolVersion: PROTOCOL_VERSION, status: stored.status === "stored" ? "stored" : "alreadyPresent" };
    const committed = this.repositoryCall(() => this.options.catalog.commitUpload(identity, {
      vaultId: context.vaultId,
      objectId,
      objectType,
      ciphertextChecksum: metadata.checksum,
      ciphertextLength: frame.completeLength,
      objectFormatVersion: frame.objectFormatVersion,
    }, result, this.clock()));
    return json(committed, stored.status === "stored" ? 201 : 200);
  }

  async get(request: Request, context: AuthorizationContext, objectType: ObjectType, objectId: ObjectId): Promise<Response> {
    this.repositoryCall(() => this.options.catalog.requireVault(context.vaultId));
    const row = this.repositoryCall(() => this.options.catalog.get(context.vaultId, objectId));
    if (!row || row.object_type !== objectType) throw new ApiError(404, "NOT_FOUND", "Object not found");
    const range = parseRange(request.headers.get("range"), row.ciphertext_length);
    let opened;
    try {
       opened = await this.options.filesystem.open(objectKey(objectType, objectId, this.storageVault(context.vaultId)), range ?? undefined);
    }
    catch (error) {
      if (error instanceof ObjectStorageError && error.code === "NOT_FOUND") {
        this.repositoryCall(() => this.options.catalog.markIntegrity(context.vaultId, objectId, "missing", this.clock()));
        throw new ApiError(503, "UNAVAILABLE", "Object is temporarily unavailable");
      }
      if (error instanceof ObjectStorageError && error.code === "RANGE_NOT_SATISFIABLE") {
        this.repositoryCall(() => this.options.catalog.markIntegrity(context.vaultId, objectId, "corrupt", this.clock()));
        throw new ApiError(503, "UNAVAILABLE", "Object is temporarily unavailable");
      }
      throw storageError(error);
    }
    if (opened.size !== row.ciphertext_length) {
      void opened.stream.cancel().catch(() => undefined);
      this.repositoryCall(() => this.options.catalog.markIntegrity(context.vaultId, objectId, "corrupt", this.clock()));
      throw new ApiError(503, "UNAVAILABLE", "Object is temporarily unavailable");
    }
    const headers = new Headers({
      "content-type": "application/octet-stream", "accept-ranges": "bytes",
      "content-length": String(opened.range.endExclusive - opened.range.start),
      "x-nanosync-protocol-version": String(PROTOCOL_VERSION),
      "x-nanosync-object-format-version": String(row.object_format_version),
      "x-nanosync-object-type": row.object_type,
      "x-nanosync-ciphertext-sha256": row.ciphertext_checksum,
    });
    if (range) headers.set("content-range", `bytes ${range.start}-${range.endExclusive - 1}/${opened.size}`);
    return new Response(opened.stream, { status: range ? 206 : 200, headers });
  }

  private repositoryCall<T>(callback: () => T): T {
    try { return callback(); }
    catch (error) {
      if (error instanceof ObjectRepositoryError) {
        if (error.code === "IDEMPOTENCY_KEY_REUSE") throw new ApiError(409, "IDEMPOTENCY_KEY_REUSE", "Idempotency key was used for another request");
        if (error.code === "CATALOG_CONFLICT") throw new ApiError(409, "CONFLICT", "Object identity conflicts with existing metadata");
        if (error.code === "VAULT_CONFLICT") throw new ApiError(403, "FORBIDDEN", "Authenticated vault is not available");
        if (error.code === "SERVER_UNINITIALIZED") throw new ApiError(503, "UNAVAILABLE", "Server vault is not initialized");
      }
      throw error;
    }
  }
  private storageVault(vaultId: VaultId): string | undefined {
    return this.options.catalog.legacyVault(vaultId) ? undefined : vaultId;
  }
}

interface UploadMetadata {
  contentLength: number;
  checksum: CiphertextChecksum;
  idempotencyKey: IdempotencyKey;
  objectFormatVersion: 1;
}
function uploadMetadata(request: Request, maximum: number): UploadMetadata {
  if (request.headers.has("transfer-encoding")) {
    throw new ApiError(400, "MALFORMED_REQUEST", "Transfer-Encoding is not accepted for object uploads");
  }
  if (request.headers.get("x-nanosync-protocol-version") !== "1") {
    throw new ApiError(400, "UNSUPPORTED_PROTOCOL_VERSION", "Protocol version 1 is required");
  }
  if (request.headers.get("x-nanosync-object-format-version") !== "1") {
    throw new ApiError(400, "UNSUPPORTED_FORMAT_VERSION", "Object format version 1 is required");
  }
  const rawLength = request.headers.get("content-length");
  if (rawLength === null || !/^[1-9]\d*$/.test(rawLength) || !Number.isSafeInteger(Number(rawLength))) {
    throw new ApiError(400, "MALFORMED_REQUEST", "A canonical decimal Content-Length is required");
  }
  const contentLength = Number(rawLength);
  if (contentLength > maximum) {
    throw new ApiError(413, "OBJECT_LIMIT_EXCEEDED", "Object exceeds the configured limit");
  }
  try {
    return {
      contentLength,
      objectFormatVersion: OBJECT_FORMAT_VERSION,
      checksum: parseCiphertextChecksum(request.headers.get("x-nanosync-ciphertext-sha256"), "header.checksum"),
      idempotencyKey: parseIdempotencyKey(request.headers.get("idempotency-key"), "header.idempotencyKey"),
    };
  } catch {
    throw new ApiError(400, "MALFORMED_REQUEST", "Required object upload headers are invalid");
  }
}
function requestDigest(vaultId: VaultId, objectType: ObjectType, objectId: ObjectId, metadata: UploadMetadata): string {
  return createHash("sha256")
    .update([
      "put-object-v1",
      vaultId,
      objectType,
      objectId,
      metadata.contentLength,
      metadata.checksum,
      metadata.objectFormatVersion,
    ].join("\0"))
    .digest("hex");
}
export function objectKey(type: ObjectType, id: string, vaultId?: string): string {
  return `objects/v1/${vaultId ? `${vaultId}/` : ""}${type}/${id.slice(0, 2)}/${id}`;
}

interface ByteReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void>;
  releaseLock(): void;
}
async function readHeader(reader: ByteReader): Promise<{ header: Uint8Array; remainder: Uint8Array }> {
  const header = new Uint8Array(OBJECT_FRAME_HEADER_BYTES);
  let offset = 0;
  while (offset < header.byteLength) {
    const next = await reader.read();
    if (next.done) throw new ApiError(400, "LENGTH_MISMATCH", "Object frame header is truncated");
    if (!(next.value instanceof Uint8Array)) throw new ApiError(400, "MALFORMED_REQUEST", "Object body is invalid");
    const used = Math.min(next.value.byteLength, header.byteLength - offset);
    header.set(next.value.subarray(0, used), offset);
    offset += used;
    if (used < next.value.byteLength) {
      const remainder = new Uint8Array(next.value.byteLength - used);
      remainder.set(next.value.subarray(used));
      return { header, remainder };
    }
  }
  return { header, remainder: new Uint8Array() };
}
function exactObjectStream(
  reader: ByteReader,
  header: Uint8Array,
  remainder: Uint8Array,
  expected: number,
): ReadableStream<Uint8Array> {
  let initial = [header, remainder].filter((item) => item.byteLength > 0);
  let count = 0;
  let finished = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = initial.shift() ?? (await reader.read()).value;
        if (chunk === undefined) {
          if (count !== expected) throw new ApiError(400, "LENGTH_MISMATCH", "Object body is truncated");
           finished = true;
           reader.releaseLock();
           controller.close();
           return;
        }
        if (chunk.byteLength > expected - count) throw new ApiError(400, "LENGTH_MISMATCH", "Object body has trailing bytes");
         count += chunk.byteLength;
         controller.enqueue(chunk);
       } catch (error) {
         cancelReaderNoWait(reader);
         if (!finished) {
           try { reader.releaseLock(); } catch {}
         }
         controller.error(error);
       }
    },
     cancel() {
       cancelReaderNoWait(reader);
       try { reader.releaseLock(); } catch {}
     },
  });
}
function parseRange(value: string | null, size: number): ByteRange | null {
  if (value === null) return null;
  const invalid = () => { throw new ApiError(416, "MALFORMED_REQUEST", "Requested byte range is not satisfiable", { "content-range": `bytes */${size}` }); };
  if (value.includes(",")) return invalid();
  const match = /^bytes=(\d*)-(\d*)$/.exec(value); if (!match || (!match[1] && !match[2])) return invalid();
  let start: number, endExclusive: number;
  if (!match[1]) { const suffix = Number(match[2]); if (!Number.isSafeInteger(suffix) || suffix <= 0) return invalid(); start = Math.max(0, size - suffix); endExclusive = size; }
  else { start = Number(match[1]); if (!Number.isSafeInteger(start) || start >= size) return invalid(); const end = match[2] ? Number(match[2]) : size - 1; if (!Number.isSafeInteger(end) || end < start) return invalid(); endExclusive = Math.min(size, end + 1); }
  return { start, endExclusive };
}
function protocolFrameError(error: ProtocolValidationError): ApiError {
  return new ApiError(400, error.code === "UNSUPPORTED_VERSION" ? "UNSUPPORTED_FORMAT_VERSION" : error.code === "LIMIT_EXCEEDED" ? "OBJECT_LIMIT_EXCEEDED" : "MALFORMED_REQUEST", "Object frame header is invalid");
}
function storageError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ObjectStorageError) {
    if (error.code === "CHECKSUM_MISMATCH") return new ApiError(400, "CHECKSUM_MISMATCH", "Ciphertext checksum does not match");
    if (error.code === "OBJECT_CONFLICT") return new ApiError(409, "CONFLICT", "Object identity conflicts with stored bytes");
    if (error.code === "NOT_FOUND") return new ApiError(404, "NOT_FOUND", "Object not found");
    if (error.code === "SIZE_LIMIT_EXCEEDED") return new ApiError(413, "OBJECT_LIMIT_EXCEEDED", "Object exceeds the configured limit");
  }
  return new ApiError(500, "INTERNAL", "Request failed");
}
function cancelReaderNoWait(reader: ByteReader): void { try { void reader.cancel().catch(() => undefined); } catch {} }
function cancelNoWait(stream: ReadableStream<Uint8Array> | null): void { if (stream) try { void stream.cancel().catch(() => undefined); } catch {} }
