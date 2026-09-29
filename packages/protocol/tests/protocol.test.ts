import { describe, expect, test } from "bun:test";
import {
  MAX_IDEMPOTENCY_KEY_LENGTH, MAX_OBJECT_CIPHERTEXT_BYTES, OBJECT_FORMAT_VERSION, ProtocolValidationError,
  parseAdvanceHeadRequest, parseAdvanceHeadResult, parseCapabilityResponse,
  parseIdempotencyKey, parseProtocolErrorEnvelope, parseReferenceSetMac, parseRevisionEnvelope,
} from "../src/index.ts";

const vaultId = "123e4567-e89b-12d3-a456-426614174000";
const revisionId = "123e4567-e89b-12d3-a456-426614174001";
const parent = "123e4567-e89b-12d3-a456-426614174002";
const deviceId = "123e4567-e89b-12d3-a456-426614174003";
const manifestId = "1".repeat(64);
const chunkId = "0".repeat(64);
const checksum = "a".repeat(64);

function envelope(): Record<string, unknown> {
  return {
    protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId,
    parents: [parent], creatingDeviceId: deviceId, createdAt: "2026-09-28T12:34:56.000Z",
    encryptedManifestObjectId: manifestId,
    referenceSetMac: "b".repeat(64),
    references: [
      { objectId: chunkId, objectType: "chunk", ciphertextChecksum: checksum, ciphertextLength: 117, objectFormatVersion: OBJECT_FORMAT_VERSION },
      { objectId: manifestId, objectType: "manifest", ciphertextChecksum: checksum, ciphertextLength: 199, objectFormatVersion: OBJECT_FORMAT_VERSION },
    ],
  };
}

function error(value: unknown): ProtocolValidationError {
  try { parseRevisionEnvelope(value); } catch (caught) {
    expect(caught).toBeInstanceOf(ProtocolValidationError);
    return caught as ProtocolValidationError;
  }
  throw new Error("expected validation failure");
}

describe("revision envelopes", () => {
  test("returns a normalized copy isolated from caller mutation", () => {
    const input = envelope();
    const parsed = parseRevisionEnvelope(input);
    (input.parents as string[])[0] = revisionId;
    ((input.references as Record<string, unknown>[])[0]!).ciphertextLength = 200;
    expect(parsed.parents.map(String)).toEqual([parent]);
    expect(parsed.references[0]?.ciphertextLength).toBe(117);
    expect(parsed).not.toBe(input);
  });

  test("rejects non-objects, inherited, missing, and unknown properties", () => {
    expect(error([]).code).toBe("INVALID_TYPE");
    expect(error(Object.create(envelope())).code).toBe("INVALID_TYPE");
    const missing = envelope(); delete missing.createdAt;
    expect(error(missing)).toMatchObject({ code: "MISSING_FIELD", path: "revision.createdAt" });
    expect(error({ ...envelope(), surprise: true }).code).toBe("UNKNOWN_FIELD");
    const nestedUnknown = envelope();
    (nestedUnknown.references as Record<string, unknown>[])[0]!.surprise = true;
    expect(error(nestedUnknown)).toMatchObject({ code: "UNKNOWN_FIELD", path: "revision.references[0].surprise" });
    const nestedInherited = envelope();
    (nestedInherited.references as unknown[])[0] = Object.create((nestedInherited.references as unknown[])[0] as object);
    expect(error(nestedInherited)).toMatchObject({ code: "INVALID_TYPE", path: "revision.references[0]" });
  });

  test("rejects primitives, unsafe numbers, versions, timestamps, and identifiers", () => {
    expect(error({ ...envelope(), parents: "no" }).code).toBe("INVALID_TYPE");
    expect(error({ ...envelope(), protocolVersion: 2 }).code).toBe("UNSUPPORTED_VERSION");
    expect(error({ ...envelope(), createdAt: "2026-02-30T00:00:00.000Z" }).code).toBe("INVALID_VALUE");
    expect(error({ ...envelope(), vaultId: vaultId.toUpperCase() }).code).toBe("INVALID_VALUE");
    expect(error({ ...envelope(), referenceSetMac: "A".repeat(64) })).toMatchObject({ code: "INVALID_VALUE", path: "revision.referenceSetMac" });
    expect(String(parseReferenceSetMac("c".repeat(64)))).toBe("c".repeat(64));
    const badLength = envelope();
    (badLength.references as Record<string, unknown>[])[0]!.ciphertextLength = Number.MAX_SAFE_INTEGER + 1;
    expect(error(badLength).code).toBe("INVALID_TYPE");
    for (const length of [0, MAX_OBJECT_CIPHERTEXT_BYTES + 1]) {
      const invalid = envelope();
      (invalid.references as Record<string, unknown>[])[0]!.ciphertextLength = length;
      expect(error(invalid)).toMatchObject({ code: "LIMIT_EXCEEDED", path: "revision.references[0].ciphertextLength" });
    }
  });

  test("rejects parent and reference count, ordering, duplicates, and type confusion", () => {
    expect(error({ ...envelope(), parents: [] }).code).toBe("LIMIT_EXCEEDED");
    expect(error({ ...envelope(), references: Array(20_001) }).code).toBe("LIMIT_EXCEEDED");
    expect(error({ ...envelope(), parents: [parent, revisionId] }).code).toBe("INVALID_ORDER");
    expect(error({ ...envelope(), parents: [parent, parent] }).code).toBe("DUPLICATE_VALUE");
    expect(error({ ...envelope(), parents: [revisionId] }).code).toBe("INVALID_VALUE");
    const reversed = envelope(); (reversed.references as unknown[]).reverse();
    expect(error(reversed).code).toBe("INVALID_ORDER");
    const duplicate = envelope();
    (duplicate.references as unknown[]).splice(1, 0, { ...(duplicate.references as object[])[0] });
    expect(error(duplicate).code).toBe("DUPLICATE_VALUE");
    const confused = envelope();
    (confused.references as Record<string, unknown>[])[1]!.objectType = "chunk";
    expect(error(confused)).toMatchObject({ code: "INVALID_VALUE", path: "revision.encryptedManifestObjectId" });
    expect(error({ ...envelope(), encryptedManifestObjectId: "2".repeat(64) })).toMatchObject({ code: "INVALID_VALUE", path: "revision.encryptedManifestObjectId" });
  });
});

describe("other protocol messages", () => {
  test("parses a request and isolates its nested envelope", () => {
    const proposedRevision = envelope();
    const parsed = parseAdvanceHeadRequest({ protocolVersion: 1, vaultId, expectedRevisionId: parent, proposedRevision, idempotencyKey: "publish-1" });
    expect(String(parsed.proposedRevision.revisionId)).toBe(revisionId);
    expect(() => parseAdvanceHeadRequest({ protocolVersion: 1, vaultId: deviceId, expectedRevisionId: null, proposedRevision, idempotencyKey: "x" })).toThrow();
    expect(() => parseAdvanceHeadRequest({ protocolVersion: 1, vaultId, expectedRevisionId: parent, proposedRevision, idempotencyKey: "contains space" })).toThrow();
  });

  test("validates idempotency keys and all result variants", () => {
    expect(String(parseIdempotencyKey("request!1"))).toBe("request!1");
    for (const value of ["", "contains space", "é", "x".repeat(MAX_IDEMPOTENCY_KEY_LENGTH + 1)]) expect(() => parseIdempotencyKey(value)).toThrow();
    expect(parseAdvanceHeadResult({ status: "accepted", revisionId, sequence: 1 }).status).toBe("accepted");
    expect(parseAdvanceHeadResult({ status: "alreadyAccepted", revisionId, sequence: 2 }).status).toBe("alreadyAccepted");
    expect(parseAdvanceHeadResult({ status: "staleHead", currentRevisionId: null }).status).toBe("staleHead");
    expect(parseAdvanceHeadResult({ status: "missingObjects", objectIds: [chunkId, manifestId] }).status).toBe("missingObjects");
    expect(parseAdvanceHeadResult({ status: "invalidRevision", reasonCode: "BAD_PARENT" }).status).toBe("invalidRevision");
    for (const bad of [{ status: "accepted", revisionId }, { status: "missingObjects", objectIds: [] }, { status: "what" }]) expect(() => parseAdvanceHeadResult(bad)).toThrow();
    expect(() => parseAdvanceHeadResult({ status: "missingObjects", objectIds: [chunkId, chunkId] })).toThrow();
    expect(() => parseAdvanceHeadResult({ status: "missingObjects", objectIds: [manifestId, chunkId] })).toThrow();
  });

  test("parses strict capabilities", () => {
    const capabilities = {
      protocolVersions: [1], revisionFormatVersions: [1], objectFormatVersions: [1],
      objectTypes: ["chunk", "manifest", "revision-private"],
      limits: { maximumObjectCiphertextBytes: 1, maximumReferencesPerRevision: 1, maximumParents: 1, maximumPresenceQuery: 1, maximumPageSize: 1, maximumJsonMetadataBytes: 1, maximumIdempotencyKeyLength: 1 },
    };
    const parsed = parseCapabilityResponse(capabilities);
    (capabilities.objectTypes as string[])[0] = "changed";
    expect(parsed.objectTypes[0]).toBe("chunk");
    expect(() => parseCapabilityResponse({ ...capabilities, extra: true })).toThrow();
    expect(() => parseCapabilityResponse({ ...capabilities, objectTypes: ["unknown"] })).toThrow();
    expect(() => parseCapabilityResponse({ ...capabilities, objectTypes: [] })).toThrow();
    expect(() => parseCapabilityResponse({ ...capabilities, objectTypes: ["chunk", "chunk"] })).toThrow();
    expect(() => parseCapabilityResponse({ ...capabilities, limits: { ...capabilities.limits, maximumPageSize: 1_001 } })).toThrow();
  });
});

describe("protocol error envelopes", () => {
  test("normalizes the strict versioned public shape", () => {
    const input = { protocolVersion: 1, code: "RATE_LIMITED", message: "Try again later", retryAfterSeconds: 30 };
    const parsed = parseProtocolErrorEnvelope(input);
    input.message = "mutated";
    expect(parsed).toEqual({ protocolVersion: 1, code: "RATE_LIMITED", message: "Try again later", retryAfterSeconds: 30 });
  });

  test("rejects malformed, inherited, unknown, unsafe, and unbounded values", () => {
    const valid = { protocolVersion: 1, code: "INTERNAL", message: "Request failed" };
    const cases: unknown[] = [
      [], Object.create(valid), { protocolVersion: 1, code: "INTERNAL" }, { ...valid, detail: "secret stack" }, { ...valid, protocolVersion: 2 },
      { ...valid, code: "SECRET_DATABASE_FAILURE" }, { ...valid, message: "line\nbreak" },
      { ...valid, message: "é".repeat(257) }, { ...valid, message: "\ud800" }, { ...valid, retryAfterSeconds: 86_401 },
      { ...valid, retryAfterSeconds: 1.5 },
    ];
    for (const value of cases) expect(() => parseProtocolErrorEnvelope(value)).toThrow(ProtocolValidationError);
  });
});
