import { ProtocolValidationError } from "./errors.ts";
import {
  parseCiphertextChecksum, parseDeviceId, parseIdempotencyKey, parseObjectId, parseReferenceSetMac,
  parseRevisionId, parseVaultId,
  type CiphertextChecksum, type DeviceId, type IdempotencyKey, type ObjectId,
  type ReferenceSetMac, type RevisionId, type VaultId,
} from "./ids.ts";
import {
  AES_GCM_TAG_BYTES, CHUNK_SIZE, MAX_IDEMPOTENCY_KEY_LENGTH, MAX_JSON_METADATA_BYTES, MAX_OBJECT_CIPHERTEXT_BYTES,
  OBJECT_FRAME_HEADER_BYTES, RANDOMIZED_NONCE_BYTES,
  MAX_PAGE_SIZE, MAX_PARENTS, MAX_PRESENCE_QUERY, MAX_REFERENCES_PER_REVISION,
  OBJECT_FORMAT_VERSION, OBJECT_TYPES, PROTOCOL_VERSION, REVISION_FORMAT_VERSION,
  type ObjectType,
} from "./versions.ts";

export interface VisibleObjectReference {
  objectId: ObjectId;
  objectType: ObjectType;
  ciphertextChecksum: CiphertextChecksum;
  ciphertextLength: number;
  objectFormatVersion: typeof OBJECT_FORMAT_VERSION;
}
export interface RevisionEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  revisionFormatVersion: typeof REVISION_FORMAT_VERSION;
  vaultId: VaultId;
  revisionId: RevisionId;
  parents: RevisionId[];
  creatingDeviceId: DeviceId;
  createdAt: string;
  encryptedManifestObjectId: ObjectId;
  references: VisibleObjectReference[];
  referenceSetMac: ReferenceSetMac;
}
export interface CapabilityResponse {
  protocolVersions: number[];
  revisionFormatVersions: number[];
  objectFormatVersions: number[];
  objectTypes: ObjectType[];
  limits: {
    maximumObjectCiphertextBytes: number;
    maximumReferencesPerRevision: number;
    maximumParents: number;
    maximumPresenceQuery: number;
    maximumPageSize: number;
    maximumJsonMetadataBytes: number;
    maximumIdempotencyKeyLength: number;
    chunkSizeBytes: number;
  };
}
export interface AdvanceHeadRequest {
  protocolVersion: typeof PROTOCOL_VERSION;
  vaultId: VaultId;
  expectedRevisionId: RevisionId | null;
  proposedRevision: RevisionEnvelope;
  idempotencyKey: IdempotencyKey;
}
export type AdvanceHeadResult =
  | { status: "accepted" | "alreadyAccepted"; revisionId: RevisionId; sequence: number }
  | { status: "staleHead"; currentRevisionId: RevisionId | null }
  | { status: "missingObjects"; objectIds: ObjectId[] }
  | { status: "invalidRevision"; reasonCode: string };

type RecordValue = Record<string, unknown>;
function object(value: unknown, path: string, fields: readonly string[]): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ProtocolValidationError("INVALID_TYPE", path, "expected object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ProtocolValidationError("INVALID_TYPE", path, "expected a plain object without inherited properties");
  }
  const record = value as RecordValue;
  for (const key of fields) {
    if (!Object.hasOwn(record, key)) throw new ProtocolValidationError("MISSING_FIELD", `${path}.${key}`, "field is required");
  }
  for (const key of Object.keys(record)) {
    if (!fields.includes(key)) throw new ProtocolValidationError("UNKNOWN_FIELD", `${path}.${key}`, "field is not allowed");
  }
  return record;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw new ProtocolValidationError("INVALID_TYPE", path, "expected array");
  return value;
}
function integer(value: unknown, path: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new ProtocolValidationError("INVALID_TYPE", path, "expected safe integer");
  }
  if (value < minimum || value > maximum) throw new ProtocolValidationError("LIMIT_EXCEEDED", path, `expected ${minimum}..${maximum}`);
  return value;
}
function version(value: unknown, path: string, supported: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) throw new ProtocolValidationError("INVALID_TYPE", path, "expected safe integer");
  if (value !== supported) throw new ProtocolValidationError("UNSUPPORTED_VERSION", path, `only version ${supported} is supported`);
  return value;
}
function string(value: unknown, path: string, pattern: RegExp, description: string): string {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  if (!pattern.test(value)) throw new ProtocolValidationError("INVALID_VALUE", path, description);
  return value;
}
function sortedUnique<T>(values: T[], path: string, key: (value: T) => string): void {
  for (let index = 1; index < values.length; index++) {
    const previous = key(values[index - 1]!);
    const current = key(values[index]!);
    if (current === previous) throw new ProtocolValidationError("DUPLICATE_VALUE", `${path}[${index}]`, "duplicate value");
    if (current < previous) throw new ProtocolValidationError("INVALID_ORDER", `${path}[${index}]`, "values must be lexically sorted");
  }
}
function parseObjectType(value: unknown, path: string): ObjectType {
  if (typeof value !== "string" || !(OBJECT_TYPES as readonly string[]).includes(value)) {
    throw new ProtocolValidationError("INVALID_VALUE", path, "unsupported object type");
  }
  return value as ObjectType;
}
function parseReference(value: unknown, path: string): VisibleObjectReference {
  const v = object(value, path, ["objectId", "objectType", "ciphertextChecksum", "ciphertextLength", "objectFormatVersion"]);
  const objectType = parseObjectType(v.objectType, `${path}.objectType`);
  const framingBytes = OBJECT_FRAME_HEADER_BYTES + (objectType === "chunk" ? 0 : RANDOMIZED_NONCE_BYTES) + AES_GCM_TAG_BYTES;
  const maximumLength = objectType === "chunk" ? framingBytes + CHUNK_SIZE : MAX_OBJECT_CIPHERTEXT_BYTES;
  return {
    objectId: parseObjectId(v.objectId, `${path}.objectId`),
    objectType,
    ciphertextChecksum: parseCiphertextChecksum(v.ciphertextChecksum, `${path}.ciphertextChecksum`),
    ciphertextLength: integer(v.ciphertextLength, `${path}.ciphertextLength`, framingBytes + 1, maximumLength),
    objectFormatVersion: version(v.objectFormatVersion, `${path}.objectFormatVersion`, OBJECT_FORMAT_VERSION) as 1,
  };
}

export function parseRevisionEnvelope(value: unknown, path = "revision"): RevisionEnvelope {
  const fields = ["protocolVersion", "revisionFormatVersion", "vaultId", "revisionId", "parents", "creatingDeviceId", "createdAt", "encryptedManifestObjectId", "references", "referenceSetMac"];
  const v = object(value, path, fields);
  const rawParents = array(v.parents, `${path}.parents`);
  if (rawParents.length < 1 || rawParents.length > MAX_PARENTS) throw new ProtocolValidationError("LIMIT_EXCEEDED", `${path}.parents`, "expected one or two parents");
  const parents = rawParents.map((item, index) => parseRevisionId(item, `${path}.parents[${index}]`));
  sortedUnique(parents, `${path}.parents`, String);
  const revisionId = parseRevisionId(v.revisionId, `${path}.revisionId`);
  if (parents.includes(revisionId)) throw new ProtocolValidationError("INVALID_VALUE", `${path}.parents`, "revision cannot be its own parent");
  const rawReferences = array(v.references, `${path}.references`);
  if (rawReferences.length < 1 || rawReferences.length > MAX_REFERENCES_PER_REVISION) throw new ProtocolValidationError("LIMIT_EXCEEDED", `${path}.references`, `expected 1..${MAX_REFERENCES_PER_REVISION} references`);
  const references = rawReferences.map((item, index) => parseReference(item, `${path}.references[${index}]`));
  sortedUnique(references, `${path}.references`, (item) => item.objectId);
  const encryptedManifestObjectId = parseObjectId(v.encryptedManifestObjectId, `${path}.encryptedManifestObjectId`);
  const manifest = references.find((item) => item.objectId === encryptedManifestObjectId);
  if (!manifest || manifest.objectType !== "manifest") throw new ProtocolValidationError("INVALID_VALUE", `${path}.encryptedManifestObjectId`, "must identify exactly one manifest reference");
  const createdAt = string(v.createdAt, `${path}.createdAt`, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "expected canonical UTC timestamp");
  const instant = new Date(createdAt);
  if (!Number.isFinite(instant.getTime()) || instant.toISOString() !== createdAt) throw new ProtocolValidationError("INVALID_VALUE", `${path}.createdAt`, "timestamp is not a real instant");
  return {
    protocolVersion: version(v.protocolVersion, `${path}.protocolVersion`, PROTOCOL_VERSION) as 1,
    revisionFormatVersion: version(v.revisionFormatVersion, `${path}.revisionFormatVersion`, REVISION_FORMAT_VERSION) as 1,
    vaultId: parseVaultId(v.vaultId, `${path}.vaultId`), revisionId,
    parents, creatingDeviceId: parseDeviceId(v.creatingDeviceId, `${path}.creatingDeviceId`), createdAt,
    encryptedManifestObjectId, references,
    referenceSetMac: parseReferenceSetMac(v.referenceSetMac, `${path}.referenceSetMac`),
  };
}

const LIMIT_FIELDS = ["maximumObjectCiphertextBytes", "maximumReferencesPerRevision", "maximumParents", "maximumPresenceQuery", "maximumPageSize", "maximumJsonMetadataBytes", "maximumIdempotencyKeyLength", "chunkSizeBytes"];
export function parseCapabilityResponse(value: unknown, path = "capabilities"): CapabilityResponse {
  const v = object(value, path, ["protocolVersions", "revisionFormatVersions", "objectFormatVersions", "objectTypes", "limits"]);
  const versions = (input: unknown, child: string, supported: number): number[] => {
    const result = array(input, child).map((item, i) => version(item, `${child}[${i}]`, supported));
    if (result.length !== 1) throw new ProtocolValidationError("INVALID_VALUE", child, "v1 requires exactly one advertised version");
    return result;
  };
  const types = array(v.objectTypes, `${path}.objectTypes`).map((item, i) => parseObjectType(item, `${path}.objectTypes[${i}]`));
  if (types.length === 0) throw new ProtocolValidationError("INVALID_VALUE", `${path}.objectTypes`, "at least one object type is required");
  sortedUnique(types, `${path}.objectTypes`, String);
  const limits = object(v.limits, `${path}.limits`, LIMIT_FIELDS);
  const parsedLimits = {
    maximumObjectCiphertextBytes: integer(limits.maximumObjectCiphertextBytes, `${path}.limits.maximumObjectCiphertextBytes`, 1, MAX_OBJECT_CIPHERTEXT_BYTES),
    maximumReferencesPerRevision: integer(limits.maximumReferencesPerRevision, `${path}.limits.maximumReferencesPerRevision`, 1, MAX_REFERENCES_PER_REVISION),
    maximumParents: integer(limits.maximumParents, `${path}.limits.maximumParents`, 1, MAX_PARENTS),
    maximumPresenceQuery: integer(limits.maximumPresenceQuery, `${path}.limits.maximumPresenceQuery`, 1, MAX_PRESENCE_QUERY),
    maximumPageSize: integer(limits.maximumPageSize, `${path}.limits.maximumPageSize`, 1, MAX_PAGE_SIZE),
    maximumJsonMetadataBytes: integer(limits.maximumJsonMetadataBytes, `${path}.limits.maximumJsonMetadataBytes`, 1, MAX_JSON_METADATA_BYTES),
    maximumIdempotencyKeyLength: integer(limits.maximumIdempotencyKeyLength, `${path}.limits.maximumIdempotencyKeyLength`, 1, MAX_IDEMPOTENCY_KEY_LENGTH),
    chunkSizeBytes: integer(limits.chunkSizeBytes, `${path}.limits.chunkSizeBytes`, CHUNK_SIZE, CHUNK_SIZE),
  };
  return { protocolVersions: versions(v.protocolVersions, `${path}.protocolVersions`, 1), revisionFormatVersions: versions(v.revisionFormatVersions, `${path}.revisionFormatVersions`, 1), objectFormatVersions: versions(v.objectFormatVersions, `${path}.objectFormatVersions`, 1), objectTypes: types, limits: parsedLimits };
}

export function parseAdvanceHeadRequest(value: unknown, path = "request"): AdvanceHeadRequest {
  const v = object(value, path, ["protocolVersion", "vaultId", "expectedRevisionId", "proposedRevision", "idempotencyKey"]);
  const vaultId = parseVaultId(v.vaultId, `${path}.vaultId`);
  const proposedRevision = parseRevisionEnvelope(v.proposedRevision, `${path}.proposedRevision`);
  if (proposedRevision.vaultId !== vaultId) throw new ProtocolValidationError("INVALID_VALUE", `${path}.proposedRevision.vaultId`, "must match request vaultId");
  return { protocolVersion: version(v.protocolVersion, `${path}.protocolVersion`, 1) as 1, vaultId, expectedRevisionId: v.expectedRevisionId === null ? null : parseRevisionId(v.expectedRevisionId, `${path}.expectedRevisionId`), proposedRevision, idempotencyKey: parseIdempotencyKey(v.idempotencyKey, `${path}.idempotencyKey`) };
}

export function parseAdvanceHeadResult(value: unknown, path = "result"): AdvanceHeadResult {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !Object.hasOwn(value, "status")) throw new ProtocolValidationError("INVALID_TYPE", path, "expected result object with status");
  const status = (value as { status?: unknown }).status;
  if (status === "accepted" || status === "alreadyAccepted") {
    const v = object(value, path, ["status", "revisionId", "sequence"]);
    return { status, revisionId: parseRevisionId(v.revisionId, `${path}.revisionId`), sequence: integer(v.sequence, `${path}.sequence`, 1, Number.MAX_SAFE_INTEGER) };
  }
  if (status === "staleHead") {
    const v = object(value, path, ["status", "currentRevisionId"]);
    return { status, currentRevisionId: v.currentRevisionId === null ? null : parseRevisionId(v.currentRevisionId, `${path}.currentRevisionId`) };
  }
  if (status === "missingObjects") {
    const v = object(value, path, ["status", "objectIds"]);
    const ids = array(v.objectIds, `${path}.objectIds`).map((item, i) => parseObjectId(item, `${path}.objectIds[${i}]`));
    if (ids.length < 1 || ids.length > MAX_REFERENCES_PER_REVISION) throw new ProtocolValidationError("LIMIT_EXCEEDED", `${path}.objectIds`, "invalid missing-object count");
    sortedUnique(ids, `${path}.objectIds`, String);
    return { status, objectIds: ids };
  }
  if (status === "invalidRevision") {
    const v = object(value, path, ["status", "reasonCode"]);
    return { status, reasonCode: string(v.reasonCode, `${path}.reasonCode`, /^[A-Z][A-Z0-9_]{0,63}$/, "expected stable uppercase reason code") };
  }
  throw new ProtocolValidationError("INVALID_VALUE", `${path}.status`, "unknown result status");
}
