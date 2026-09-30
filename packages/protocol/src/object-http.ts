import { ProtocolValidationError } from "./errors.ts";
import { parseObjectId, parseVaultId, type ObjectId, type VaultId } from "./ids.ts";
import {
  AES_GCM_TAG_BYTES, CHUNK_NONCE_BYTES, CHUNK_SIZE, CRYPTO_FORMAT_VERSION,
  MAX_OBJECT_CIPHERTEXT_BYTES, MAX_PRESENCE_QUERY, OBJECT_FORMAT_VERSION,
  OBJECT_FRAME_HEADER_BYTES, OBJECT_FRAME_MAGIC, OBJECT_TYPE_CODES, OBJECT_TYPES,
  PROTOCOL_VERSION, RANDOMIZED_NONCE_BYTES, type ObjectType,
} from "./versions.ts";

export interface ObjectFrameHeader {
  objectFormatVersion: 1;
  cryptoFormatVersion: 1;
  objectType: ObjectType;
  nonceLength: number;
  vaultId: VaultId;
  objectId: ObjectId;
  plaintextLength: number;
  encryptedPayloadLength: number;
  completeLength: number;
}

export interface PresenceRequest {
  protocolVersion: 1;
  objectType: ObjectType;
  objectIds: ObjectId[];
}

function fail(
  path: string,
  message: string,
  code: "INVALID_TYPE" | "INVALID_VALUE" | "MISSING_FIELD" | "UNKNOWN_FIELD" | "LIMIT_EXCEEDED" | "UNSUPPORTED_VERSION" | "INVALID_ORDER" | "DUPLICATE_VALUE" = "INVALID_VALUE",
): never {
  throw new ProtocolValidationError(code, path, message);
}

export function parseObjectType(value: unknown, path = "objectType"): ObjectType {
  if (typeof value !== "string" || !(OBJECT_TYPES as readonly string[]).includes(value)) fail(path, "unsupported object type");
  return value as ObjectType;
}

export function parsePresenceRequest(value: unknown, path = "request"): PresenceRequest {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path, "expected object", "INVALID_TYPE");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(path, "expected a plain object without inherited properties", "INVALID_TYPE");
  const record = value as Record<string, unknown>;
  for (const field of ["protocolVersion", "objectType", "objectIds"]) {
    if (!Object.hasOwn(record, field)) {
      fail(`${path}.${field}`, "field is required", "MISSING_FIELD");
    }
  }
  for (const field of Object.keys(record)) {
    if (!["protocolVersion", "objectType", "objectIds"].includes(field)) {
      fail(`${path}.${field}`, "field is not allowed", "UNKNOWN_FIELD");
    }
  }
  if (record.protocolVersion !== PROTOCOL_VERSION) fail(`${path}.protocolVersion`, "only protocol version 1 is supported", "UNSUPPORTED_VERSION");
  if (!Array.isArray(record.objectIds)) fail(`${path}.objectIds`, "expected array", "INVALID_TYPE");
  if (record.objectIds.length < 1 || record.objectIds.length > MAX_PRESENCE_QUERY) {
    fail(`${path}.objectIds`, `expected 1..${MAX_PRESENCE_QUERY} IDs`, "LIMIT_EXCEEDED");
  }
  const objectIds = record.objectIds.map((id, index) => parseObjectId(id, `${path}.objectIds[${index}]`));
  for (let index = 1; index < objectIds.length; index++) {
    if (objectIds[index] === objectIds[index - 1]) {
      fail(`${path}.objectIds[${index}]`, "duplicate ID", "DUPLICATE_VALUE");
    }
    if (objectIds[index]! < objectIds[index - 1]!) {
      fail(`${path}.objectIds[${index}]`, "IDs must be lexically sorted", "INVALID_ORDER");
    }
  }
  return {
    protocolVersion: PROTOCOL_VERSION,
    objectType: parseObjectType(record.objectType, `${path}.objectType`),
    objectIds,
  };
}

export function parseObjectFrameHeader(bytes: Uint8Array): ObjectFrameHeader {
  if (bytes.byteLength !== OBJECT_FRAME_HEADER_BYTES) fail("objectHeader", "expected exactly 80 bytes", "INVALID_TYPE");
  const magic = new TextDecoder().decode(bytes.subarray(0, 8));
  if (magic !== OBJECT_FRAME_MAGIC) fail("objectHeader.magic", "invalid object magic");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const objectFormatVersion = view.getUint16(8);
  const cryptoFormatVersion = view.getUint16(10);
  if (objectFormatVersion !== OBJECT_FORMAT_VERSION) fail("objectHeader.objectFormatVersion", "unsupported object format", "UNSUPPORTED_VERSION");
  if (cryptoFormatVersion !== CRYPTO_FORMAT_VERSION) fail("objectHeader.cryptoFormatVersion", "unsupported crypto format", "UNSUPPORTED_VERSION");
  const code = view.getUint8(12);
  const objectType = OBJECT_TYPES.find((type) => OBJECT_TYPE_CODES[type] === code);
  if (!objectType) fail("objectHeader.objectType", "unsupported object type");
  const nonceLength = view.getUint8(13);
  const expectedNonce = objectType === "chunk" ? CHUNK_NONCE_BYTES : RANDOMIZED_NONCE_BYTES;
  if (nonceLength !== expectedNonce) fail("objectHeader.nonceLength", "invalid nonce rule");
  if (view.getUint16(14) !== 0) fail("objectHeader.flags", "reserved flags must be zero");
  const vaultId = parseVaultId(uuidFromBytes(bytes.subarray(16, 32)), "objectHeader.vaultId");
  const objectId = parseObjectId(hex(bytes.subarray(32, 64)), "objectHeader.objectId");
  const plaintext = view.getBigUint64(64);
  const encrypted = view.getBigUint64(72);
  if (plaintext > BigInt(Number.MAX_SAFE_INTEGER) || encrypted > BigInt(Number.MAX_SAFE_INTEGER)) fail("objectHeader.length", "length exceeds safe integer range", "LIMIT_EXCEEDED");
  const plaintextLength = Number(plaintext);
  const encryptedPayloadLength = Number(encrypted);
  if (plaintextLength !== encryptedPayloadLength) fail("objectHeader.encryptedPayloadLength", "must equal plaintext length");
  if (plaintextLength < 1 || (objectType === "chunk" && plaintextLength > CHUNK_SIZE)) fail("objectHeader.plaintextLength", "type-specific length is out of bounds", "LIMIT_EXCEEDED");
  const completeLength = OBJECT_FRAME_HEADER_BYTES + nonceLength + encryptedPayloadLength + AES_GCM_TAG_BYTES;
  if (!Number.isSafeInteger(completeLength) || completeLength > MAX_OBJECT_CIPHERTEXT_BYTES) fail("objectHeader.completeLength", "object exceeds format limit", "LIMIT_EXCEEDED");
  return {
    objectFormatVersion: 1,
    cryptoFormatVersion: 1,
    objectType,
    nonceLength,
    vaultId,
    objectId,
    plaintextLength,
    encryptedPayloadLength,
    completeLength,
  };
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
function uuidFromBytes(bytes: Uint8Array): string {
  const value = hex(bytes);
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}
