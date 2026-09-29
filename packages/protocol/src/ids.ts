import { ProtocolValidationError } from "./errors.ts";
import { MAX_IDEMPOTENCY_KEY_LENGTH } from "./versions.ts";

declare const brand: unique symbol;
type Branded<T extends string> = string & { readonly [brand]: T };
export type VaultId = Branded<"VaultId">;
export type DeviceId = Branded<"DeviceId">;
export type RevisionId = Branded<"RevisionId">;
export type ObjectId = Branded<"ObjectId">;
export type CiphertextChecksum = Branded<"CiphertextChecksum">;
export type ReferenceSetMac = Branded<"ReferenceSetMac">;
export type IdempotencyKey = Branded<"IdempotencyKey">;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEX_256 = /^[0-9a-f]{64}$/;
const IDEMPOTENCY = /^[\x21-\x7e]+$/;

function parseString(value: unknown, path: string, pattern: RegExp, description: string): string {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  if (!pattern.test(value)) throw new ProtocolValidationError("INVALID_VALUE", path, `expected ${description}`);
  return value;
}

export const parseVaultId = (value: unknown, path = "vaultId"): VaultId =>
  parseString(value, path, UUID, "canonical lowercase UUID") as VaultId;
export const parseDeviceId = (value: unknown, path = "deviceId"): DeviceId =>
  parseString(value, path, UUID, "canonical lowercase UUID") as DeviceId;
export const parseRevisionId = (value: unknown, path = "revisionId"): RevisionId =>
  parseString(value, path, UUID, "canonical lowercase UUID") as RevisionId;
export const parseObjectId = (value: unknown, path = "objectId"): ObjectId =>
  parseString(value, path, HEX_256, "64 lowercase hexadecimal characters") as ObjectId;
export const parseCiphertextChecksum = (value: unknown, path = "ciphertextChecksum"): CiphertextChecksum =>
  parseString(value, path, HEX_256, "SHA-256 as 64 lowercase hexadecimal characters") as CiphertextChecksum;
export const parseReferenceSetMac = (value: unknown, path = "referenceSetMac"): ReferenceSetMac =>
  parseString(value, path, HEX_256, "HMAC-SHA-256 as 64 lowercase hexadecimal characters") as ReferenceSetMac;

export function parseIdempotencyKey(value: unknown, path = "idempotencyKey"): IdempotencyKey {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  if (value.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new ProtocolValidationError("LIMIT_EXCEEDED", path, `maximum length is ${MAX_IDEMPOTENCY_KEY_LENGTH}`);
  }
  if (!IDEMPOTENCY.test(value)) {
    throw new ProtocolValidationError("INVALID_VALUE", path, "expected 1-128 visible ASCII characters");
  }
  return value as IdempotencyKey;
}
