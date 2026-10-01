import { ProtocolValidationError } from "./errors.ts";
import { parseDeviceId, parsePrincipalId, parseVaultId, type DeviceId, type PrincipalId, type VaultId } from "./ids.ts";
import { parsePersistedRevisionEnvelope, type RevisionEnvelope } from "./envelopes.ts";
import { PROTOCOL_VERSION } from "./versions.ts";

export const MAX_BOOTSTRAP_PASSWORD_BYTES = 1024;
export const RECOVERY_WRAP_ALGORITHM = "A256GCM" as const;

export interface RecoveryWrapV1 {
  version: 1;
  algorithm: typeof RECOVERY_WRAP_ALGORITHM;
  nonce: string;
  ciphertext: string;
}
export interface BootstrapInitializeRequest {
  protocolVersion: 1;
  principalId: PrincipalId;
  vaultId: VaultId;
  initialDeviceId: DeviceId;
  password: string;
  recoveryWrap: RecoveryWrapV1;
}
export interface BootstrapCompleteRequest {
  protocolVersion: 1;
  vaultId: VaultId;
  genesisRevision: RevisionEnvelope;
}

type Plain = Record<string, unknown>;
function exact(value: unknown, path: string, fields: readonly string[]): Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolValidationError("INVALID_TYPE", path, "expected object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ProtocolValidationError("INVALID_TYPE", path, "expected plain object");
  const record = value as Plain;
  for (const field of fields) {
    if (!Object.hasOwn(record, field)) {
      throw new ProtocolValidationError("MISSING_FIELD", `${path}.${field}`, "field is required");
    }
  }
  for (const field of Object.keys(record)) {
    if (!fields.includes(field)) {
      throw new ProtocolValidationError("UNKNOWN_FIELD", `${path}.${field}`, "field is not allowed");
    }
  }
  return record;
}
function protocol(value: unknown, path: string): 1 {
  if (value !== PROTOCOL_VERSION) throw new ProtocolValidationError(typeof value === "number" ? "UNSUPPORTED_VERSION" : "INVALID_TYPE", path, "protocol version 1 is required");
  return 1;
}
function canonicalBase64Url(value: unknown, bytes: number, path: string): string {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  decodeCanonicalBase64Url(value, bytes, path);
  return value;
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Portable strict RFC 4648 base64url decoder. Padding and nonzero discarded bits are rejected. */
export function decodeCanonicalBase64Url(value: string, expectedBytes: number, path = "base64url"): Uint8Array {
  const expectedCharacters = Math.ceil(expectedBytes * 8 / 6);
  if (value.length !== expectedCharacters || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new ProtocolValidationError("INVALID_VALUE", path, `expected ${expectedBytes} bytes as canonical unpadded base64url`);
  }
  const output = new Uint8Array(expectedBytes);
  let accumulator = 0;
  let bits = 0;
  let offset = 0;
  for (const character of value) {
    const digit = BASE64URL.indexOf(character);
    if (digit < 0) throw new ProtocolValidationError("INVALID_VALUE", path, "invalid base64url alphabet");
    accumulator = accumulator * 64 + digit;
    bits += 6;
    while (bits >= 8) {
      bits -= 8;
      if (offset >= output.length) throw new ProtocolValidationError("INVALID_VALUE", path, "noncanonical base64url length");
      output[offset++] = Math.floor(accumulator / 2 ** bits) & 0xff;
      accumulator &= 2 ** bits - 1;
    }
  }
  if (offset !== expectedBytes || accumulator !== 0) throw new ProtocolValidationError("INVALID_VALUE", path, "noncanonical base64url discarded bits");
  return output;
}

export function parseRecoveryWrap(value: unknown, path = "recoveryWrap"): RecoveryWrapV1 {
  const input = exact(value, path, ["version", "algorithm", "nonce", "ciphertext"]);
  if (input.version !== 1) throw new ProtocolValidationError("UNSUPPORTED_VERSION", `${path}.version`, "recovery wrap version 1 is required");
  if (input.algorithm !== RECOVERY_WRAP_ALGORITHM) throw new ProtocolValidationError("INVALID_VALUE", `${path}.algorithm`, "A256GCM is required");
  return {
    version: 1,
    algorithm: RECOVERY_WRAP_ALGORITHM,
    nonce: canonicalBase64Url(input.nonce, 12, `${path}.nonce`),
    ciphertext: canonicalBase64Url(input.ciphertext, 48, `${path}.ciphertext`),
  };
}

export function parseBootstrapInitializeRequest(value: unknown, path = "request"): BootstrapInitializeRequest {
  const input = exact(value, path, ["protocolVersion", "principalId", "vaultId", "initialDeviceId", "password", "recoveryWrap"]);
  if (typeof input.password !== "string" || input.password.length === 0 || new TextEncoder().encode(input.password).byteLength > MAX_BOOTSTRAP_PASSWORD_BYTES) {
    throw new ProtocolValidationError("LIMIT_EXCEEDED", `${path}.password`, `password must be 1..${MAX_BOOTSTRAP_PASSWORD_BYTES} UTF-8 bytes`);
  }
  return {
    protocolVersion: protocol(input.protocolVersion, `${path}.protocolVersion`),
    principalId: parsePrincipalId(input.principalId, `${path}.principalId`),
    vaultId: parseVaultId(input.vaultId, `${path}.vaultId`),
    initialDeviceId: parseDeviceId(input.initialDeviceId, `${path}.initialDeviceId`),
    password: input.password,
    recoveryWrap: parseRecoveryWrap(input.recoveryWrap, `${path}.recoveryWrap`),
  };
}

export function parseBootstrapCompleteRequest(value: unknown, path = "request"): BootstrapCompleteRequest {
  const input = exact(value, path, ["protocolVersion", "vaultId", "genesisRevision"]);
  const vaultId = parseVaultId(input.vaultId, `${path}.vaultId`);
  const genesisRevision = parsePersistedRevisionEnvelope(input.genesisRevision, `${path}.genesisRevision`);
  if (genesisRevision.parents.length !== 0) throw new ProtocolValidationError("INVALID_VALUE", `${path}.genesisRevision.parents`, "genesis must have zero parents");
  if (genesisRevision.vaultId !== vaultId) throw new ProtocolValidationError("INVALID_VALUE", `${path}.genesisRevision.vaultId`, "must match request vaultId");
  return { protocolVersion: protocol(input.protocolVersion, `${path}.protocolVersion`), vaultId, genesisRevision };
}
