import {
  CHUNK_SIZE, OBJECT_FRAME_HEADER_BYTES, OBJECT_FRAME_MAGIC, OBJECT_TYPE_CODES,
  parseObjectFrameHeader, parseObjectId, parseVaultId, parseRecoveryWrap,
  decodeCanonicalBase64Url, type ObjectType, type ObjectFrameHeader,
  canonicalizePersistedRevisionEnvelope, parseReferenceSetMac, parseCiphertextChecksum, parseObjectType,
  type RevisionEnvelope, type ObjectId, type VaultId, type RecoveryWrapV1, type VisibleObjectReference,
} from "@nanosync/protocol";
export { MAX_FILE_BYTES, parseManifest, encodeManifest, decodeManifest, validateManifestReferences, encryptManifest, decryptManifest, type ManifestV1, type ManifestEntry, type ManifestChunk } from "./manifest.ts";
export { HttpRemote, RemoteError, type RemoteOptions, type ChunkJournal } from "./remote.ts";

const text = new TextEncoder();
const ZERO_NONCE = new Uint8Array(12);
const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// Web Crypto is one-shot AEAD and digest. A randomized object larger than this needs
// an authenticated bounded temporary store / streaming crypto provider (not v1 core).
export const MAX_IN_MEMORY_OBJECT_PLAINTEXT = CHUNK_SIZE;

function bytes(value: Uint8Array, length: number, name: string): Uint8Array {
  if (!(value instanceof Uint8Array) || value.byteLength !== length) throw new Error(`invalid ${name} length`);
  return value;
}
function hex(value: Uint8Array): string { return Array.from(value, x => x.toString(16).padStart(2, "0")).join(""); }
function unhex(value: string): Uint8Array { return Uint8Array.from(value.match(/../g)!, x => parseInt(x, 16)); }
function join(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
function uuidBytes(id: VaultId): Uint8Array { return unhex(id.replaceAll("-", "")); }
function b64encode(input: Uint8Array): string {
  let result = "";
  for (let i = 0; i < input.length; i += 3) {
    const a = input[i]!, b = input[i + 1], c = input[i + 2];
    result += B64[a >> 2]! + B64[((a & 3) << 4) | ((b ?? 0) >> 4)]!;
    if (b !== undefined) result += B64[((b & 15) << 2) | ((c ?? 0) >> 6)];
    if (c !== undefined) result += B64[c & 63];
  }
  return result;
}
function b32encode(input: Uint8Array): string {
  let out = "", acc = 0, bits = 0;
  for (const byte of input) {
    acc = (acc << 8) | byte; bits += 8;
    while (bits >= 5) { bits -= 5; out += B32[(acc >>> bits) & 31]; acc &= (1 << bits) - 1; }
  }
  if (bits) out += B32[(acc << (5 - bits)) & 31];
  return out;
}
function b32decode(value: string, size: number): Uint8Array {
  if (value.length !== Math.ceil(size * 8 / 5) || !/^[a-z2-7]+$/.test(value)) throw new Error("invalid recovery alphabet or length");
  const out = new Uint8Array(size);
  let acc = 0, bits = 0, offset = 0;
  for (const ch of value) {
    acc = acc * 32 + B32.indexOf(ch); bits += 5;
    if (bits >= 8) { bits -= 8; out[offset++] = (acc >>> bits) & 255; acc &= (1 << bits) - 1; }
  }
  if (offset !== size || acc !== 0 || b32encode(out) !== value) throw new Error("noncanonical recovery encoding");
  return out;
}
function webBytes(value: Uint8Array): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(value.byteLength)); copy.set(value); return copy;
}
async function sha(input: Uint8Array): Promise<Uint8Array> { return new Uint8Array(await crypto.subtle.digest("SHA-256", webBytes(input))); }
async function hmac(key: Uint8Array, input: Uint8Array): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", webBytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", imported, webBytes(input)));
}
async function hkdf(ikm: Uint8Array, salt: Uint8Array, label: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", webBytes(ikm), "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt: webBytes(salt), info: text.encode(label) }, key, 256));
}
async function aes(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, payload: Uint8Array, decrypt = false): Promise<Uint8Array> {
  const imported = await crypto.subtle.importKey("raw", webBytes(key), "AES-GCM", false, [decrypt ? "decrypt" : "encrypt"]);
  const params = { name: "AES-GCM", iv: webBytes(nonce), additionalData: webBytes(aad), tagLength: 128 };
  return new Uint8Array(await (decrypt ? crypto.subtle.decrypt(params, imported, webBytes(payload)) : crypto.subtle.encrypt(params, imported, webBytes(payload))));
}
// All AAD schemas below contain only fixed ASCII keys, ASCII identifiers and safe integers.
// Sorting these ASCII keys and JSON.stringify-ing values is exactly RFC 8785 for this
// restricted domain. No general-purpose JCS or arbitrary Unicode input is accepted.
function aad(fields: Record<string, string | number>): Uint8Array {
  return text.encode(`{${Object.keys(fields).sort().map(k => `${JSON.stringify(k)}:${JSON.stringify(fields[k])}`).join(",")}}`);
}
function vault(id: string): VaultId { return parseVaultId(id); }
function objectId(id: string): ObjectId { return parseObjectId(id); }
function objectAAD(vaultId: VaultId, type: ObjectType, id: ObjectId, length: number): Uint8Array {
  return aad({ label: `nanosync/v1/aad/${type}`, objectFormatVersion: 1, cryptoFormatVersion: 1,
    vaultId, objectType: type, objectId: id, plaintextLength: length });
}

export function generateVaultMasterKey(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
export function generateRecoverySecret(): Uint8Array { return crypto.getRandomValues(new Uint8Array(32)); }
export async function deriveVaultKeys(master: Uint8Array, vaultIdInput: string) {
  const keyMaterial = bytes(master, 32, "master key").slice(), salt = uuidBytes(vault(vaultIdInput));
  const [chunkEncryptionRoot, manifestKey, revisionPrivateKey, revisionAuthenticationKey, chunkIdentifierKey] = await Promise.all([
    "chunk-encryption-root", "manifest-key", "revision-private-key", "revision-authentication-key", "chunk-identifier-key",
  ].map(label => hkdf(keyMaterial, salt, `nanosync/v1/${label}`)));
  return { chunkEncryptionRoot: chunkEncryptionRoot!, manifestKey: manifestKey!, revisionPrivateKey: revisionPrivateKey!, revisionAuthenticationKey: revisionAuthenticationKey!, chunkIdentifierKey: chunkIdentifierKey! };
}
export async function displayRecoverySecret(secret: Uint8Array): Promise<string> {
  const stable = bytes(secret, 32, "recovery secret").slice();
  const digest = await sha(join(text.encode("nanosync/v1/recovery-checksum"), new Uint8Array(1), stable));
  return (b32encode(stable) + b32encode(digest.subarray(0, 4))).match(/.{1,5}/g)!.join("-");
}
export async function decodeRecoverySecret(display: string): Promise<Uint8Array> {
  if (typeof display !== "string" || !/^(?:[a-z2-7]{5}-){11}[a-z2-7]{4}$/.test(display)) throw new Error("invalid recovery display");
  const symbols = display.replaceAll("-", "");
  const secret = b32decode(symbols.slice(0, 52), 32);
  const check = b32decode(symbols.slice(52), 4);
  const digest = await sha(join(text.encode("nanosync/v1/recovery-checksum"), new Uint8Array(1), secret));
  let difference = 0;
  for (let i = 0; i < 4; i++) difference |= check[i]! ^ digest[i]!;
  if (difference) throw new Error("invalid recovery checksum");
  return secret;
}
export async function wrapMasterKey(master: Uint8Array, secret: Uint8Array, vaultIdInput: string): Promise<RecoveryWrapV1> {
  const stableMaster = bytes(master, 32, "master key").slice(), stableSecret = bytes(secret, 32, "recovery secret").slice();
  const id = vault(vaultIdInput), nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = await hkdf(stableSecret, uuidBytes(id), "nanosync/v1/recovery-wrap-key");
  const ciphertext = await aes(key, nonce, aad({ algorithm: "A256GCM", label: "nanosync/v1/aad/recovery-wrap", vaultId: id, version: 1 }), stableMaster);
  return { version: 1, algorithm: "A256GCM", nonce: b64encode(nonce), ciphertext: b64encode(ciphertext) };
}
export async function unwrapMasterKey(input: unknown, secret: Uint8Array, vaultIdInput: string): Promise<Uint8Array> {
  const stableSecret = bytes(secret, 32, "recovery secret").slice(); const id = vault(vaultIdInput), wrap = parseRecoveryWrap(input);
  const nonce = decodeCanonicalBase64Url(wrap.nonce, 12), ciphertext = decodeCanonicalBase64Url(wrap.ciphertext, 48);
  return aes(await hkdf(stableSecret, uuidBytes(id), "nanosync/v1/recovery-wrap-key"), nonce,
    aad({ algorithm: "A256GCM", label: "nanosync/v1/aad/recovery-wrap", vaultId: id, version: 1 }), ciphertext, true);
}

function frameHeader(id: VaultId, oid: ObjectId, type: ObjectType, length: number): Uint8Array {
  if (!Number.isSafeInteger(length) || length < 1 || length > MAX_IN_MEMORY_OBJECT_PLAINTEXT) throw new Error("object plaintext exceeds bounded limit");
  const header = new Uint8Array(OBJECT_FRAME_HEADER_BYTES), view = new DataView(header.buffer);
  header.set(text.encode(OBJECT_FRAME_MAGIC)); view.setUint16(8, 1); view.setUint16(10, 1);
  view.setUint8(12, OBJECT_TYPE_CODES[type]); view.setUint8(13, type === "chunk" ? 0 : 12);
  header.set(uuidBytes(id), 16); header.set(unhex(oid), 32);
  view.setBigUint64(64, BigInt(length)); view.setBigUint64(72, BigInt(length));
  parseObjectFrameHeader(header);
  return header;
}
export interface EncryptedObject { frame: Uint8Array; reference: VisibleObjectReference; }
async function result(frame: Uint8Array, type: ObjectType, id: ObjectId): Promise<EncryptedObject> {
  return { frame, reference: { objectId: id, objectType: type, ciphertextChecksum: hex(await sha(frame)) as VisibleObjectReference["ciphertextChecksum"], ciphertextLength: frame.length, objectFormatVersion: 1 } };
}
export async function encryptChunk(plaintext: Uint8Array, master: Uint8Array, vaultIdInput: string): Promise<EncryptedObject> {
  const id = vault(vaultIdInput); if (!(plaintext instanceof Uint8Array) || !plaintext.length || plaintext.length > CHUNK_SIZE) throw new Error("chunk must be 1..4 MiB");
  const stablePlaintext = plaintext.slice(), stableMaster = bytes(master, 32, "master key").slice();
  const keys = await deriveVaultKeys(stableMaster, id);
  const oid = objectId(hex(await hmac(keys.chunkIdentifierKey, stablePlaintext)));
  const key = await hkdf(keys.chunkEncryptionRoot, unhex(oid), "nanosync/v1/chunk-key");
  return result(join(frameHeader(id, oid, "chunk", stablePlaintext.length), await aes(key, ZERO_NONCE, objectAAD(id, "chunk", oid, stablePlaintext.length), stablePlaintext)), "chunk", oid);
}
export async function encryptRandomized(type: "manifest" | "revision-private", plaintext: Uint8Array, master: Uint8Array, vaultIdInput: string): Promise<EncryptedObject> {
  const id = vault(vaultIdInput);
  if (!(plaintext instanceof Uint8Array) || !plaintext.length || plaintext.length > MAX_IN_MEMORY_OBJECT_PLAINTEXT) throw new Error("randomized object exceeds bounded limit");
  if (type !== "manifest" && type !== "revision-private") throw new Error("invalid randomized object type");
  const stablePlaintext = plaintext.slice(), stableMaster = bytes(master, 32, "master key").slice();
  const oid = objectId(hex(crypto.getRandomValues(new Uint8Array(32))));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const keys = await deriveVaultKeys(stableMaster, id);
  return result(join(frameHeader(id, oid, type, stablePlaintext.length), nonce,
    await aes(type === "manifest" ? keys.manifestKey : keys.revisionPrivateKey, nonce, objectAAD(id, type, oid, stablePlaintext.length), stablePlaintext)), type, oid);
}
export async function decryptObject(frame: Uint8Array, master: Uint8Array, vaultIdInput: string, expected: VisibleObjectReference): Promise<Uint8Array> {
  if (!(frame instanceof Uint8Array) || frame.length < 96 || frame.length > CHUNK_SIZE + 108) throw new Error("invalid bounded frame length");
  const stableFrame = frame.slice(), stableMaster = bytes(master, 32, "master key").slice();
  if (typeof expected !== "object" || expected === null || Array.isArray(expected) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(expected)) ||
      Object.keys(expected).length !== 5 ||
      !["objectId", "objectType", "ciphertextChecksum", "ciphertextLength", "objectFormatVersion"].every(k => Object.hasOwn(expected, k))) throw new Error("invalid reference shape");
  const id = vault(vaultIdInput), oid = objectId(expected.objectId);
  const type = parseObjectType(expected.objectType), checksum = parseCiphertextChecksum(expected.ciphertextChecksum);
  const length = expected.ciphertextLength, version = expected.objectFormatVersion;
  if (!Number.isSafeInteger(length) || version !== 1) throw new Error("invalid reference metadata");
  const header: ObjectFrameHeader = parseObjectFrameHeader(stableFrame.subarray(0, 80));
  if (header.vaultId !== id || header.objectId !== oid || header.objectType !== type ||
      header.completeLength !== stableFrame.length || length !== stableFrame.length ||
      checksum !== hex(await sha(stableFrame))) throw new Error("frame metadata or checksum mismatch");
  if (header.plaintextLength > MAX_IN_MEMORY_OBJECT_PLAINTEXT) throw new Error("object exceeds bounded decrypt limit");
  const nonce = header.objectType === "chunk" ? ZERO_NONCE : stableFrame.subarray(80, 92);
  const keys = await deriveVaultKeys(stableMaster, id);
  const key = header.objectType === "chunk" ? await hkdf(keys.chunkEncryptionRoot, unhex(oid), "nanosync/v1/chunk-key") :
    header.objectType === "manifest" ? keys.manifestKey : keys.revisionPrivateKey;
  // Web Crypto does not expose plaintext until its authentication tag verifies.
  const plaintext = await aes(key, nonce, objectAAD(id, header.objectType, oid, header.plaintextLength), stableFrame.subarray(80 + header.nonceLength), true);
  if (plaintext.length !== header.plaintextLength || (header.objectType === "chunk" && hex(await hmac(keys.chunkIdentifierKey, plaintext)) !== oid)) throw new Error("chunk ID or plaintext length mismatch");
  return plaintext;
}

/** Bound buffering to one 4 MiB chunk plus one incoming stream segment. */
export async function* encryptFileChunks(source: ReadableStream<Uint8Array>, master: Uint8Array, vaultId: string): AsyncGenerator<EncryptedObject> {
  const stableMaster = bytes(master, 32, "master key").slice(), stableVault = vault(vaultId);
  const reader = source.getReader(); let buffer: Uint8Array | undefined, used = 0, finished = false;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) { finished = true; break; }
      if (!(value instanceof Uint8Array)) throw new Error("file stream must contain byte arrays");
      let offset = 0;
      while (offset < value.length) {
        buffer ??= new Uint8Array(CHUNK_SIZE);
        const count = Math.min(CHUNK_SIZE - used, value.length - offset);
        buffer.set(value.subarray(offset, offset + count), used); offset += count; used += count;
        if (used === CHUNK_SIZE) { const complete = buffer; buffer = undefined; used = 0; yield await encryptChunk(complete, stableMaster, stableVault); }
      }
    }
    if (used) yield await encryptChunk(buffer!.subarray(0, used), stableMaster, stableVault);
  } finally {
    if (!finished) void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** MAC the validated public envelope, without its MAC field (genesis is permitted). */
export async function referenceSetMac(envelope: RevisionEnvelope, master: Uint8Array): Promise<string> {
  const normalized = JSON.parse(canonicalizePersistedRevisionEnvelope(envelope)) as Record<string, unknown>;
  const stableMaster = bytes(master, 32, "master key").slice();
  delete normalized.referenceSetMac;
  const keys = await deriveVaultKeys(stableMaster, normalized.vaultId as string);
  // Protocol's canonicalizer sorts all nested public fields; deleting the final
  // top-level property preserves their ordering and JCS representation.
  const canonical = JSON.stringify(normalized);
  return hex(await hmac(keys.revisionAuthenticationKey, join(text.encode("nanosync/v1/reference-set-mac"), new Uint8Array(1), text.encode(canonical))));
}
export async function verifyReferenceSetMac(envelope: RevisionEnvelope, master: Uint8Array): Promise<boolean> {
  const actual = unhex(parseReferenceSetMac(envelope.referenceSetMac));
  const expected = unhex(await referenceSetMac(envelope, master));
  let difference = 0;
  for (let i = 0; i < 32; i++) difference |= actual[i]! ^ expected[i]!;
  return difference === 0;
}
