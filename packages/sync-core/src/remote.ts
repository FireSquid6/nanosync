import {
  CHUNK_SIZE, MAX_JSON_METADATA_BYTES, parseAdvanceHeadRequest, parseAdvanceHeadResult,
  parseCapabilityResponse, parseCiphertextChecksum, parseIdempotencyKey, parseObjectFrameHeader,
  parseObjectId, parsePersistedRevisionEnvelope, parseProtocolErrorEnvelope, parseRevisionId,
  parseVaultId, type AdvanceHeadRequest, type AdvanceHeadResult, type CapabilityResponse,
  type ObjectType, type RevisionEnvelope, type VisibleObjectReference,
} from "@nanosync/protocol";
import {
  decryptObject, decryptManifest, encryptChunk, encryptManifest, referenceSetMac, verifyReferenceSetMac,
  type EncryptedObject,
} from "./index.ts";
import { parseManifest, validateManifestReferences, type ManifestV1 } from "./manifest.ts";

const encoder = new TextEncoder();
const MAX_RESPONSE_JSON = MAX_JSON_METADATA_BYTES;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const MAX_FRAME = CHUNK_SIZE + 108;
class RetryableDownloadError extends Error {}

export class RemoteError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly retryAfterSeconds?: number) {
    super(message); this.name = "RemoteError";
  }
}

/** Durable adapters must atomically commit a verified plaintext chunk before resolving put.
 * Entries are indexed by vault, object ID, length and ciphertext checksum; never return
 * unverified or partially-written bytes. The client re-authenticates cached bytes on read.
 */
export interface ChunkJournal {
  get(vaultId: string, reference: VisibleObjectReference): Promise<Uint8Array | null>;
  put(vaultId: string, reference: VisibleObjectReference, plaintext: Uint8Array): Promise<void>;
}

export interface RemoteOptions {
  baseUrl: string;
  token: string;
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  journal?: ChunkJournal;
  retries?: number;
}

function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new Error("invalid remote response");
  const obj = value as Record<string, unknown>;
  if (Object.keys(obj).length !== fields.length || fields.some(field => !Object.hasOwn(obj, field))) throw new Error("invalid remote response fields");
  return obj;
}

async function json(response: Response, limit = MAX_RESPONSE_JSON): Promise<unknown> {
  if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) throw new Error("invalid response content type");
  if (response.headers.get("content-length") !== null && Number(response.headers.get("content-length")) > limit) throw new Error("response exceeds limit");
  if (!response.body) throw new Error("missing JSON body");
  const reader = response.body.getReader(); let length = 0; const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      if (!(value instanceof Uint8Array) || value.length > limit - length) throw new Error("response exceeds limit");
      length += value.length; parts.push(value);
    }
  } catch (error) { void reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const data = new Uint8Array(length); let offset = 0;
  for (const part of parts) { data.set(part, offset); offset += part.length; }
  const source = new TextDecoder("utf-8", { fatal: true }).decode(data);
  rejectDuplicateKeys(source);
  return JSON.parse(source);
}

function rejectDuplicateKeys(source: string): void {
  let cursor = 0;
  const space = () => { while (/\s/.test(source[cursor] ?? "") && cursor < source.length) cursor++; };
  const string = (): string => {
    const start = cursor++;
    while (cursor < source.length) {
      if (source[cursor] === "\\") { cursor += 2; continue; }
      if (source[cursor++] === '"') return JSON.parse(source.slice(start, cursor)) as string;
    }
    throw new Error("invalid JSON string");
  };
  const value = (): void => {
    space(); const ch = source[cursor];
    if (ch === '"') { string(); return; }
    if (ch === "{" || ch === "[") {
      cursor++; const keys = new Set<string>(); space();
      if (source[cursor] === (ch === "{" ? "}" : "]")) { cursor++; return; }
      while (cursor < source.length) {
        space();
        if (ch === "{") {
          const key = string(); if (keys.has(key)) throw new Error("duplicate JSON key"); keys.add(key);
          space(); if (source[cursor++] !== ":") throw new Error("invalid JSON object");
        }
        value(); space();
        if (source[cursor] === (ch === "{" ? "}" : "]")) { cursor++; return; }
        if (source[cursor++] !== ",") throw new Error("invalid JSON collection");
      }
      throw new Error("invalid JSON collection");
    }
    while (cursor < source.length && !/[\s,\]}]/.test(source[cursor]!)) cursor++;
    if (cursor === 0 || source[cursor - 1] === ":") throw new Error("invalid JSON value");
  };
  value(); space();
  if (cursor !== source.length) throw new Error("invalid JSON response");
}

function sameReference(a: VisibleObjectReference, b: VisibleObjectReference): boolean {
  return a.objectId === b.objectId && a.objectType === b.objectType && a.ciphertextChecksum === b.ciphertextChecksum &&
    a.ciphertextLength === b.ciphertextLength && a.objectFormatVersion === b.objectFormatVersion;
}

function validateReference(reference: VisibleObjectReference): void {
  exact(reference, ["objectId", "objectType", "ciphertextChecksum", "ciphertextLength", "objectFormatVersion"]);
  parseObjectId(reference.objectId); parseCiphertextChecksum(reference.ciphertextChecksum);
  if (reference.objectFormatVersion !== 1 || !["chunk", "manifest", "revision-private"].includes(reference.objectType) ||
      !Number.isSafeInteger(reference.ciphertextLength) || reference.ciphertextLength < (reference.objectType === "chunk" ? 97 : 109) ||
      (reference.objectType === "chunk" && reference.ciphertextLength > CHUNK_SIZE + 96)) throw new Error("invalid object reference");
}

function validateFrame(frame: Uint8Array, reference: VisibleObjectReference, vaultId: string): void {
  validateReference(reference);
  if (!(frame instanceof Uint8Array) || frame.length !== reference.ciphertextLength || frame.length > MAX_FRAME) throw new Error("invalid frame size");
  const header = parseObjectFrameHeader(frame.subarray(0, 80));
  if (header.completeLength !== frame.length || header.vaultId !== vaultId || header.objectId !== reference.objectId ||
      header.objectType !== reference.objectType) throw new Error("frame identity mismatch");
}

/** A fresh bounded stream is constructed on each retry; do not pass an entire file here. */
function frameStream(frame: Uint8Array): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset === frame.length) { controller.close(); return; }
      controller.enqueue(frame.subarray(offset, Math.min(offset + 64 * 1024, frame.length)));
      offset = Math.min(offset + 64 * 1024, frame.length);
    },
  });
}

function uploadKey(maximumLength: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, "0")).join("").slice(0, maximumLength);
}

export class HttpRemote {
  private readonly base: string;
  private readonly retries: number;
  private capabilitiesCache?: CapabilityResponse;
  constructor(private readonly options: RemoteOptions) {
    const url = new URL(options.baseUrl);
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("invalid remote URL");
    if (!TOKEN.test(options.token)) throw new Error("invalid bearer token");
    if (!Number.isSafeInteger(options.retries ?? 2) || (options.retries ?? 2) < 0 || (options.retries ?? 2) > 10) throw new Error("invalid retry count");
    this.base = url.href.replace(/\/$/, ""); this.retries = options.retries ?? 2;
  }

  private async request(path: string, init: RequestInit = {}, authenticated = true): Promise<Response> {
    const headers = new Headers(init.headers);
    if (authenticated) headers.set("authorization", `Bearer ${this.options.token}`);
    return this.options.fetch(new Request(`${this.base}${path}`, { ...init, headers }));
  }

  private async body(response: Response, statuses: number[] = [200]): Promise<unknown> {
    if (!statuses.includes(response.status)) {
      const envelope = parseProtocolErrorEnvelope(await json(response, 2048));
      throw new RemoteError(response.status, envelope.code, envelope.message, envelope.retryAfterSeconds);
    }
    return json(response);
  }

  async capabilities(): Promise<CapabilityResponse> {
    const caps = parseCapabilityResponse(await this.body(await this.request("/v1/capabilities", {}, false)));
    if (!caps.objectTypes.includes("chunk") || !caps.objectTypes.includes("manifest") ||
        caps.limits.maximumObjectCiphertextBytes < CHUNK_SIZE + 108 || caps.limits.maximumReferencesPerRevision < 1 ||
        caps.limits.maximumPresenceQuery < 1 || caps.limits.maximumIdempotencyKeyLength < 32)
      throw new Error("remote cannot support bounded v1 publication with collision-resistant idempotency keys");
    this.capabilitiesCache = caps;
    return caps;
  }

  private async negotiated(): Promise<CapabilityResponse> { return this.capabilitiesCache ?? this.capabilities(); }

  async presence(type: ObjectType, ids: string[]): Promise<Set<string>> {
    const caps = await this.negotiated();
    if (!caps.objectTypes.includes(type)) throw new Error("unadvertised object type");
    const sorted = [...new Set(ids.map(id => parseObjectId(id)))].sort();
    const missing = new Set<string>();
    for (let i = 0; i < sorted.length; i += Math.min(1000, caps.limits.maximumPresenceQuery)) {
      const batch = sorted.slice(i, i + Math.min(1000, caps.limits.maximumPresenceQuery));
      const response = exact(await this.body(await this.request("/v1/objects/presence", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ protocolVersion: 1, objectType: type, objectIds: batch }),
      })), ["protocolVersion", "objectType", "objects"]);
      if (response.protocolVersion !== 1 || response.objectType !== type || !Array.isArray(response.objects) || response.objects.length !== batch.length) throw new Error("invalid presence response");
      response.objects.forEach((entry, index) => {
        const item = exact(entry, ["objectId", "present"]);
        if (item.objectId !== batch[index] || typeof item.present !== "boolean") throw new Error("invalid presence entry");
        if (!item.present) missing.add(batch[index]!);
      });
    }
    return missing;
  }

  private async retry<T>(operation: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try { return await operation(); }
      catch (error) {
        if (attempt >= this.retries || !(error instanceof RetryableDownloadError || error instanceof TypeError ||
          error instanceof RemoteError && ["RATE_LIMITED", "UNAVAILABLE"].includes(error.code))) throw error;
      }
    }
  }

  async upload(object: EncryptedObject, vaultIdInput: string, key: string): Promise<"stored" | "alreadyPresent"> {
    // Snapshot both metadata and bytes before the first suspension. Retries use the
    // same immutable frame even if the producer reuses or mutates its buffer.
    const vaultId = parseVaultId(vaultIdInput), idempotencyKey = parseIdempotencyKey(key);
    const ref = { ...object.reference }, frame = object.frame.slice();
    validateFrame(frame, ref, vaultId);
    const caps = await this.negotiated();
    if (!caps.objectTypes.includes(ref.objectType) || ref.ciphertextLength > caps.limits.maximumObjectCiphertextBytes ||
        idempotencyKey.length > caps.limits.maximumIdempotencyKeyLength) throw new Error("object exceeds negotiated limits");
    const hash = await crypto.subtle.digest("SHA-256", frame.buffer);
    if (Array.from(new Uint8Array(hash), b => b.toString(16).padStart(2, "0")).join("") !== ref.ciphertextChecksum) throw new Error("upload checksum mismatch");
    return this.retry(async () => {
      const response = await this.request(`/v1/objects/${ref.objectType}/${ref.objectId}`, {
        method: "PUT", headers: {
          "content-length": String(ref.ciphertextLength), "x-nanosync-protocol-version": "1",
          "x-nanosync-object-format-version": "1", "x-nanosync-ciphertext-sha256": ref.ciphertextChecksum,
          "idempotency-key": idempotencyKey,
        }, body: frameStream(frame),
        // Node fetch requires duplex for streams; browsers ignore the extra property.
        duplex: "half",
      } as RequestInit);
      const result = exact(await this.body(response, [200, 201]), ["protocolVersion", "status"]);
      if (result.protocolVersion !== 1 || (result.status !== "stored" && result.status !== "alreadyPresent") ||
          (response.status === 201 && result.status !== "stored")) throw new Error("invalid upload response");
      return result.status;
    });
  }

  private async downloadFrame(reference: VisibleObjectReference, vaultIdInput: string): Promise<Uint8Array> {
    const vaultId = parseVaultId(vaultIdInput), stableReference = { ...reference };
    validateReference(stableReference);
    const caps = await this.negotiated();
    if (!caps.objectTypes.includes(stableReference.objectType) || stableReference.ciphertextLength > caps.limits.maximumObjectCiphertextBytes ||
        stableReference.ciphertextLength > MAX_FRAME) throw new Error("object exceeds bounded decrypt limit");
    return this.retry(async () => {
      const response = await this.request(`/v1/objects/${stableReference.objectType}/${stableReference.objectId}`);
      if (response.status !== 200) { await this.body(response); throw new Error("unexpected object status"); }
      const headers = response.headers;
      // Bun serves streaming responses with transfer-encoding: chunked even when
      // the handler specifies Content-Length. The authenticated reference still
      // bounds and checks the exact number of bytes read below.
      if (headers.get("content-type") !== "application/octet-stream" ||
          (headers.has("content-length") && headers.get("content-length") !== String(stableReference.ciphertextLength)) ||
          headers.get("x-nanosync-protocol-version") !== "1" || headers.get("x-nanosync-object-format-version") !== "1" ||
          headers.get("x-nanosync-object-type") !== stableReference.objectType || headers.get("x-nanosync-ciphertext-sha256") !== stableReference.ciphertextChecksum || !response.body) {
        void response.body?.cancel().catch(() => {});
        throw new Error("download metadata mismatch");
      }
      const frame = new Uint8Array(stableReference.ciphertextLength), reader = response.body.getReader(); let offset = 0;
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (!(value instanceof Uint8Array) || value.length > frame.length - offset) throw new Error("download exceeds expected length");
          frame.set(value, offset); offset += value.length;
        }
      } catch (error) { void reader.cancel().catch(() => {}); throw new RetryableDownloadError("download stream interrupted", { cause: error }); }
      finally { reader.releaseLock(); }
      if (offset !== frame.length) throw new RetryableDownloadError("truncated download");
      validateFrame(frame, stableReference, vaultId);
      return frame;
    });
  }

  async download(reference: VisibleObjectReference, master: Uint8Array, vaultIdInput: string): Promise<Uint8Array> {
    if (reference.objectType !== "chunk") throw new Error("use authenticated manifest fetch for manifest objects");
    if (!(master instanceof Uint8Array) || master.byteLength !== 32) throw new Error("invalid master key");
    const stableMaster = master.slice(), stableReference = { ...reference };
    return decryptObject(await this.downloadFrame(stableReference, vaultIdInput), stableMaster, vaultIdInput, stableReference);
  }

  /** MAC-authenticate the envelope before downloading its manifest frame; bind the plaintext to the envelope. */
  async manifest(id: string, master: Uint8Array): Promise<{ manifest: ManifestV1; revision: RevisionEnvelope; sequence: number | null }> {
    const { revision, sequence } = await this.revision(id, master);
    const reference = revision.references.find(ref => ref.objectId === revision.encryptedManifestObjectId);
    if (!reference || reference.objectType !== "manifest") throw new Error("missing manifest reference");
    const frame = await this.downloadFrame(reference, revision.vaultId);
    return { manifest: await decryptManifest(frame, revision, master), revision, sequence };
  }

  /** Each yielded chunk is fully authenticated; retries never restart an exposed chunk. */
  async *downloadChunks(references: readonly VisibleObjectReference[], master: Uint8Array, vaultIdInput: string): AsyncGenerator<Uint8Array> {
    const vaultId = parseVaultId(vaultIdInput);
    if (!(master instanceof Uint8Array) || master.byteLength !== 32) throw new Error("invalid master key");
    const stableMaster = master.slice(), stableReferences = references.map(reference => ({ ...reference }));
    for (const reference of stableReferences) {
      validateReference(reference);
      if (reference.objectType !== "chunk") throw new Error("expected chunk reference");
      let plaintext: Uint8Array | null = null;
      const cached = await this.options.journal?.get(vaultId, { ...reference });
      if (cached) {
        // Journal memory may be mutated while Web Crypto verifies it. Never yield
        // its original buffer after an asynchronous verification.
        const snapshot = cached.slice();
        const recomputed = await encryptChunk(snapshot, stableMaster, vaultId);
        if (sameReference(recomputed.reference, reference)) plaintext = snapshot;
      }
      if (!plaintext) {
        plaintext = await this.download(reference, stableMaster, vaultId);
        await this.options.journal?.put(vaultId, { ...reference }, plaintext.slice());
      }
      yield plaintext;
    }
  }

  async head(): Promise<{ revisionId: string | null; sequence: number }> {
    const result = exact(await this.body(await this.request("/v1/head")), ["protocolVersion", "status", "revisionId", "sequence"]);
    if (result.protocolVersion !== 1 || !Number.isSafeInteger(result.sequence) ||
        !(result.status === "head" && (result.sequence as number) > 0 && parseRevisionId(result.revisionId) ||
          result.status === "initializedWithoutHead" && result.revisionId === null && result.sequence === 0)) throw new Error("invalid head response");
    return { revisionId: result.revisionId as string | null, sequence: result.sequence as number };
  }

  async revision(id: string, master: Uint8Array): Promise<{ revision: RevisionEnvelope; sequence: number | null }> {
    const result = exact(await this.body(await this.request(`/v1/revisions/${parseRevisionId(id)}`)), ["protocolVersion", "revision", "sequence"]);
    const revision = parsePersistedRevisionEnvelope(result.revision);
    if (result.protocolVersion !== 1 || revision.revisionId !== id ||
        !(result.sequence === null || Number.isSafeInteger(result.sequence) && (result.sequence as number) > 0) ||
        !await verifyReferenceSetMac(revision, master)) throw new Error("invalid or unauthenticated revision");
    return { revision, sequence: result.sequence as number | null };
  }

  async advance(request: AdvanceHeadRequest): Promise<AdvanceHeadResult> {
    const caps = await this.negotiated(); const parsed = parseAdvanceHeadRequest(request);
    if (parsed.proposedRevision.references.length > caps.limits.maximumReferencesPerRevision ||
        parsed.proposedRevision.parents.length > caps.limits.maximumParents ||
        parsed.idempotencyKey.length > caps.limits.maximumIdempotencyKeyLength ||
        parsed.proposedRevision.references.some(r => !caps.objectTypes.includes(r.objectType) || r.ciphertextLength > caps.limits.maximumObjectCiphertextBytes)) throw new Error("revision exceeds negotiated limits");
    const body = JSON.stringify(parsed);
    if (encoder.encode(body).length > caps.limits.maximumJsonMetadataBytes) throw new Error("revision metadata exceeds negotiated limit");
    return this.retry(async () => parseAdvanceHeadResult(await this.body(await this.request("/v1/head/advance", {
      method: "POST", headers: { "content-type": "application/json" }, body,
    }))));
  }

  /** Reuse authenticated prior references without bytes; consume only new frames. */
  async publish(manifestInput: ManifestV1, knownReferences: readonly VisibleObjectReference[],
    newChunks: AsyncIterable<EncryptedObject> | Iterable<EncryptedObject>, master: Uint8Array,
    expectedRevisionId: string, createdAt: string,
    beforeAdvance?: (request: AdvanceHeadRequest, encryptedManifestFrame: Uint8Array) => void | Promise<void>): Promise<AdvanceHeadResult> {
    const manifest = parseManifest(manifestInput), expected = parseRevisionId(expectedRevisionId);
    if (!manifest.parents.includes(expected)) throw new Error("expected head must be a manifest parent");
    const required = new Map<string, number>();
    for (const entry of manifest.entries) for (const chunk of entry.chunks ?? []) {
      const previous = required.get(chunk.objectId);
      if (previous !== undefined && previous !== chunk.length) throw new Error("conflicting chunk lengths");
      required.set(chunk.objectId, chunk.length);
    }
    const caps = await this.negotiated();
    if (required.size + 1 > caps.limits.maximumReferencesPerRevision) throw new Error("reference limit exceeded");
    const chunkReferences: VisibleObjectReference[] = [], seen = new Set<string>();
    for (const input of knownReferences) {
      const ref = { ...input }; validateReference(ref);
      if (ref.objectType !== "chunk" || required.get(ref.objectId) !== ref.ciphertextLength - 96 || seen.has(ref.objectId) ||
          chunkReferences.length && ref.objectId <= chunkReferences[chunkReferences.length - 1]!.objectId)
        throw new Error("known references must be sorted, unique and match the manifest");
      seen.add(ref.objectId); chunkReferences.push(ref);
    }
    const knownById = new Map(chunkReferences.map(ref => [ref.objectId, ref]));
    const unavailable = await this.presence("chunk", chunkReferences.map(ref => ref.objectId));

    // Limit the in-flight frames as well as network round trips. A single batch is
    // at most 16 bounded frames (64 MiB), independent of total file size.
    const batchSize = Math.min(16, caps.limits.maximumPresenceQuery);
    let batch: EncryptedObject[] = [];
    const streamed = new Set<string>();
    const flush = async () => {
      if (!batch.length) return;
      const missing = await this.presence("chunk", batch.filter(item => !knownById.has(item.reference.objectId)).map(item => item.reference.objectId));
      for (const object of batch) if (missing.has(object.reference.objectId))
        await this.upload(object, manifest.vaultId, uploadKey(caps.limits.maximumIdempotencyKeyLength));
      for (const object of batch) if (unavailable.has(object.reference.objectId)) {
        await this.upload(object, manifest.vaultId, uploadKey(caps.limits.maximumIdempotencyKeyLength));
        unavailable.delete(object.reference.objectId);
      }
      batch = [];
    };
    for await (const input of newChunks) {
      const object: EncryptedObject = { frame: input.frame.slice(), reference: { ...input.reference } };
      const ref = object.reference;
      validateFrame(object.frame, ref, manifest.vaultId);
      const reused = knownById.get(ref.objectId);
      if (ref.objectType !== "chunk" || streamed.has(ref.objectId) ||
          (reused ? !unavailable.has(ref.objectId) || !sameReference(reused, ref) : seen.has(ref.objectId)) ||
          required.get(ref.objectId) !== ref.ciphertextLength - 96) throw new Error("duplicate, extra or mismatched chunk frame");
      // The producer may supply an internally consistent checksum for a corrupt
      // frame; authenticate GCM and the keyed plaintext chunk ID before publishing.
      await decryptObject(object.frame, master, manifest.vaultId, ref);
      if (!reused) { seen.add(ref.objectId); chunkReferences.push(ref); }
      streamed.add(ref.objectId);
      batch.push(object);
      if (batch.length === batchSize) await flush();
    }
    if (required.size !== seen.size) throw new Error("missing chunk frames");
    await flush();
    if (unavailable.size) throw new Error("reused chunk is absent remotely; provide its verified frame to repair it");
    const encrypted = await encryptManifest(manifest, master);
    const references = [...chunkReferences, encrypted.reference].sort((a, b) => a.objectId < b.objectId ? -1 : a.objectId > b.objectId ? 1 : 0);
    const unsigned = {
      protocolVersion: 1, revisionFormatVersion: 1, vaultId: parseVaultId(manifest.vaultId),
      revisionId: parseRevisionId(manifest.revisionId), parents: manifest.parents.map(id => parseRevisionId(id)),
      creatingDeviceId: manifest.creatingDeviceId, createdAt, encryptedManifestObjectId: encrypted.reference.objectId,
      references, referenceSetMac: "0".repeat(64),
    } as RevisionEnvelope;
    validateManifestReferences(manifest, unsigned);
    const proposedRevision = { ...unsigned, referenceSetMac: await referenceSetMac(unsigned, master) } as RevisionEnvelope;
    if ((await this.presence("manifest", [encrypted.reference.objectId])).has(encrypted.reference.objectId))
      await this.upload(encrypted, manifest.vaultId, uploadKey(caps.limits.maximumIdempotencyKeyLength));
    // Stable across retries of this exact envelope; never generate a second proposal on a lost response.
    const keyBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(manifest.revisionId)));
    const key = Array.from(keyBytes, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, caps.limits.maximumIdempotencyKeyLength);
    const request = parseAdvanceHeadRequest({ protocolVersion: 1, vaultId: manifest.vaultId,
      expectedRevisionId: expected, proposedRevision, idempotencyKey: key });
    await beforeAdvance?.(request, encrypted.frame.slice());
    return this.advance(request);
  }
}
