import { CHUNK_SIZE, parseDeviceId, parseObjectId, parsePersistedRevisionEnvelope, parseRevisionId, parseVaultId, type RevisionEnvelope } from "@nanosync/protocol";
import { decryptObject, encryptRandomized, MAX_IN_MEMORY_OBJECT_PLAINTEXT, verifyReferenceSetMac, type EncryptedObject } from "./index.ts";

export const MAX_FILE_BYTES = 50_000_000_000;
const utf8 = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const shaEmpty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

export interface ManifestChunk { objectId: string; length: number }
export interface ManifestEntry {
  id: string;
  parentId: string | null;
  name: string;
  kind: "directory" | "file" | "tombstone";
  // Tombstones retain their former kind and location, but carry no content references.
  deletedKind?: "directory" | "file";
  size?: number;
  sha256?: string;
  executable?: boolean;
  chunks?: ManifestChunk[];
  // Conflict copies have a new stable ID and retain their source identity.
  conflict?: { sourceEntryId: string; sourceRevisionId: string };
}
export interface ManifestV1 {
  version: 1;
  vaultId: string;
  revisionId: string;
  parents: string[];
  creatingDeviceId: string;
  entries: ManifestEntry[];
}

function record(input: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input) || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error("invalid manifest record");
  const obj = input as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (required.some(k => !Object.hasOwn(obj, k)) || keys.some(k => !required.includes(k) && !optional.includes(k))) throw new Error("invalid manifest fields");
  return obj;
}
function name(value: unknown, root = false): string {
  if (root && value === "") return "";
  if (typeof value !== "string" || !value || utf8.encode(value).length > 255 || value.normalize("NFC") !== value ||
      value === "." || value === ".." || /[\u0000-\u001f\u007f-\u009f\/\\:*?"<>|]/u.test(value) ||
      /[. ]$/u.test(value) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(value) ||
      !Array.from(value).every(c => c.codePointAt(0)! <= 0xffff ? !/[\ud800-\udfff]/u.test(c) : true)) throw new Error("invalid manifest name");
  return value;
}
function uuid(value: unknown): string { return parseRevisionId(value); }
function digest(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid plaintext SHA-256");
  return value;
}
function integer(value: unknown, max: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > max) throw new Error("invalid manifest length");
  return value as number;
}
function dense(value: unknown): value is unknown[] {
  return Array.isArray(value) && Object.keys(value).length === value.length &&
    value.every((_, i) => Object.hasOwn(value, i));
}

/** Normalize and validate the complete v1 tree; output has deterministic field and entry order. */
export function parseManifest(input: unknown): ManifestV1 {
  const m = record(input, ["version", "vaultId", "revisionId", "parents", "creatingDeviceId", "entries"]);
  if (m.version !== 1) throw new Error("unsupported manifest version");
  const vaultId = parseVaultId(m.vaultId), revisionId = parseRevisionId(m.revisionId), creatingDeviceId = parseDeviceId(m.creatingDeviceId);
  if (!dense(m.parents) || m.parents.length > 2) throw new Error("invalid manifest parents");
  const parents = m.parents.map(uuid);
  if (parents.some((p, i) => p === revisionId || (i > 0 && p <= parents[i - 1]!))) throw new Error("invalid manifest parents");
  if (!dense(m.entries) || m.entries.length < 1 || m.entries.length > 20_000) throw new Error("invalid manifest entry count");
  const entries: ManifestEntry[] = m.entries.map(raw => {
    const e = record(raw, ["id", "parentId", "name", "kind"], ["deletedKind", "size", "sha256", "executable", "chunks", "conflict"]);
    const id = uuid(e.id), parentId = e.parentId === null ? null : uuid(e.parentId);
    const kind = e.kind;
    if (kind !== "file" && kind !== "directory" && kind !== "tombstone") throw new Error("invalid manifest kind");
    const result: ManifestEntry = { id, parentId, name: name(e.name, parentId === null), kind };
    if (kind === "file") {
      if (Object.hasOwn(e, "deletedKind") || typeof e.executable !== "boolean" || !dense(e.chunks)) throw new Error("invalid file fields");
      const size = integer(e.size, MAX_FILE_BYTES), sha256 = digest(e.sha256);
      const rawChunks = e.chunks as unknown[];
      if (rawChunks.length !== Math.ceil(size / CHUNK_SIZE) || rawChunks.length > 20_000 || (size === 0 && sha256 !== shaEmpty)) throw new Error("invalid file chunk count");
      const chunks = rawChunks.map((rawChunk, i) => {
        const chunk = record(rawChunk, ["objectId", "length"]);
        const length = integer(chunk.length, CHUNK_SIZE);
        if (length !== (i === rawChunks.length - 1 ? size - i * CHUNK_SIZE : CHUNK_SIZE)) throw new Error("invalid file chunk length");
        return { objectId: parseObjectId(chunk.objectId), length };
      });
      Object.assign(result, { size, sha256, executable: e.executable, chunks });
    } else if (kind === "tombstone") {
      if (e.deletedKind !== "file" && e.deletedKind !== "directory") throw new Error("invalid tombstone kind");
      if (["size", "sha256", "executable", "chunks"].some(k => Object.hasOwn(e, k))) throw new Error("tombstone carries content");
      result.deletedKind = e.deletedKind;
    } else if (["deletedKind", "size", "sha256", "executable", "chunks"].some(k => Object.hasOwn(e, k))) throw new Error("directory carries content");
    if (Object.hasOwn(e, "conflict")) {
      const c = record(e.conflict, ["sourceEntryId", "sourceRevisionId"]);
      const sourceEntryId = uuid(c.sourceEntryId), sourceRevisionId = uuid(c.sourceRevisionId);
      if (sourceEntryId === id || kind === "tombstone") throw new Error("invalid conflict lineage");
      result.conflict = { sourceEntryId, sourceRevisionId };
    }
    return result;
  });
  entries.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const byId = new Map(entries.map(e => [e.id, e]));
  if (byId.size !== entries.length) throw new Error("duplicate manifest ID");
  const roots = entries.filter(e => e.parentId === null);
  if (roots.length !== 1 || roots[0]!.kind !== "directory" || roots[0]!.name !== "") throw new Error("invalid manifest root");
  const siblings = new Set<string>();
  const visited = new Set<string>();
  function walk(entry: ManifestEntry): void {
    const chain: string[] = [], active = new Set<string>();
    let cursor: ManifestEntry | undefined = entry;
    while (cursor && !visited.has(cursor.id)) {
      if (active.has(cursor.id)) throw new Error("manifest cycle");
      chain.push(cursor.id); active.add(cursor.id);
      const parentId: string | null = cursor.parentId;
      cursor = parentId === null ? undefined : byId.get(parentId);
      if (parentId !== null && !cursor) throw new Error("orphan manifest entry");
    }
    for (const id of chain) visited.add(id);
  }
  for (const entry of entries) {
    walk(entry);
    if (entry.parentId === null) continue;
    if (entry.name === "" || byId.get(entry.parentId)?.kind !== "directory") throw new Error("orphan or non-directory parent");
    const sibling = `${entry.parentId}/${entry.name.toLowerCase()}`;
    if (siblings.has(sibling)) throw new Error("duplicate sibling name");
    siblings.add(sibling);
  }
  return { version: 1, vaultId, revisionId, parents, creatingDeviceId, entries };
}

// JCS for this deliberately restricted schema: ASCII member names, safe integers,
// canonical identifiers and NFC Unicode names; JSON.stringify gives JCS strings.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value);
}
export function encodeManifest(input: unknown): Uint8Array {
  const result = utf8.encode(canonical(parseManifest(input)));
  if (result.length > MAX_IN_MEMORY_OBJECT_PLAINTEXT) throw new Error("manifest plaintext exceeds 4 MiB");
  return result;
}
export function decodeManifest(input: Uint8Array): ManifestV1 {
  if (!(input instanceof Uint8Array) || !input.length || input.length > MAX_IN_MEMORY_OBJECT_PLAINTEXT) throw new Error("invalid manifest byte length");
  const text = decoder.decode(input);
  const manifest = parseManifest(JSON.parse(text));
  if (decoder.decode(encodeManifest(manifest)) !== text) throw new Error("noncanonical manifest JSON");
  return manifest;
}
export function validateManifestReferences(manifestInput: unknown, envelopeInput: unknown): void {
  const manifest = parseManifest(manifestInput), envelope = parsePersistedRevisionEnvelope(envelopeInput);
  if (manifest.vaultId !== envelope.vaultId || manifest.revisionId !== envelope.revisionId ||
      manifest.creatingDeviceId !== envelope.creatingDeviceId ||
      JSON.stringify(manifest.parents) !== JSON.stringify(envelope.parents)) throw new Error("manifest revision binding mismatch");
  const required = new Map<string, number>();
  for (const entry of manifest.entries) for (const chunk of entry.chunks ?? []) {
    if (required.has(chunk.objectId) && required.get(chunk.objectId) !== chunk.length) throw new Error("conflicting chunk lengths");
    required.set(chunk.objectId, chunk.length);
  }
  if (envelope.references.length !== required.size + 1) throw new Error("manifest reference set mismatch");
  for (const ref of envelope.references) {
    if (ref.objectId === envelope.encryptedManifestObjectId) {
      if (ref.objectType !== "manifest") throw new Error("missing manifest reference");
    } else {
      const length = required.get(ref.objectId);
      if (length === undefined || ref.objectType !== "chunk" || ref.ciphertextLength !== length + 96) throw new Error("chunk reference mismatch");
      required.delete(ref.objectId);
    }
  }
  if (required.size) throw new Error("missing chunk reference");
}

export async function encryptManifest(input: unknown, master: Uint8Array): Promise<EncryptedObject> {
  const manifest = parseManifest(input);
  const plaintext = encodeManifest(manifest);
  return encryptRandomized("manifest", plaintext, master, manifest.vaultId);
}

/** Authenticate the public set before touching ciphertext; the encrypted plaintext binds revision identity. */
export async function decryptManifest(frame: Uint8Array, envelopeInput: unknown, master: Uint8Array): Promise<ManifestV1> {
  const envelope: RevisionEnvelope = parsePersistedRevisionEnvelope(envelopeInput);
  if (!await verifyReferenceSetMac(envelope, master)) throw new Error("invalid reference set MAC");
  const reference = envelope.references.find(r => r.objectId === envelope.encryptedManifestObjectId)!;
  const manifest = decodeManifest(await decryptObject(frame, master, envelope.vaultId, reference));
  validateManifestReferences(manifest, envelope);
  return manifest;
}
