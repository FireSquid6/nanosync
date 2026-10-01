import { ProtocolValidationError } from "./errors.ts";
import { PROTOCOL_VERSION } from "./versions.ts";

export const PROTOCOL_ERROR_CODES = [
  "MALFORMED_REQUEST",
  "UNSUPPORTED_PROTOCOL_VERSION",
  "UNSUPPORTED_FORMAT_VERSION",
  "UNAUTHORIZED",
  "FORBIDDEN",
  "NOT_FOUND",
  "CONFLICT",
  "IDEMPOTENCY_KEY_REUSE",
  "BODY_LIMIT_EXCEEDED",
  "OBJECT_LIMIT_EXCEEDED",
  "REFERENCE_LIMIT_EXCEEDED",
  "CHECKSUM_MISMATCH",
  "LENGTH_MISMATCH",
  "RATE_LIMITED",
  "STALE_HEAD",
  "MISSING_OBJECTS",
  "INVALID_REVISION",
  "INTERNAL",
  "UNAVAILABLE",
] as const;

export type ProtocolErrorCode = (typeof PROTOCOL_ERROR_CODES)[number];
export const MAX_PUBLIC_ERROR_MESSAGE_BYTES = 512;
export const MAX_RETRY_AFTER_SECONDS = 86_400;

export interface ProtocolErrorEnvelope {
  protocolVersion: typeof PROTOCOL_VERSION;
  code: ProtocolErrorCode;
  message: string;
  retryAfterSeconds?: number;
}

function fail(code: ConstructorParameters<typeof ProtocolValidationError>[0], path: string, message: string): never {
  throw new ProtocolValidationError(code, path, message);
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index++;
    } else if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

export function parseProtocolErrorEnvelope(value: unknown, path = "error"): ProtocolErrorEnvelope {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail("INVALID_TYPE", path, "expected object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail("INVALID_TYPE", path, "expected plain object without inherited properties");
  const record = value as Record<string, unknown>;
  for (const required of ["protocolVersion", "code", "message"]) {
    if (!Object.hasOwn(record, required)) fail("MISSING_FIELD", `${path}.${required}`, "field is required");
  }
  for (const key of Object.keys(record)) {
    if (!["protocolVersion", "code", "message", "retryAfterSeconds"].includes(key)) fail("UNKNOWN_FIELD", `${path}.${key}`, "field is not allowed");
  }
  if (typeof record.protocolVersion !== "number" || !Number.isSafeInteger(record.protocolVersion)) fail("INVALID_TYPE", `${path}.protocolVersion`, "expected safe integer");
  if (record.protocolVersion !== PROTOCOL_VERSION) fail("UNSUPPORTED_VERSION", `${path}.protocolVersion`, "unsupported protocol version");
  if (typeof record.code !== "string" || !(PROTOCOL_ERROR_CODES as readonly string[]).includes(record.code)) fail("INVALID_VALUE", `${path}.code`, "unknown protocol error code");
  if (typeof record.message !== "string") fail("INVALID_TYPE", `${path}.message`, "expected string");
  if (record.message.length === 0 || hasUnpairedSurrogate(record.message) || new TextEncoder().encode(record.message).byteLength > MAX_PUBLIC_ERROR_MESSAGE_BYTES || /[\u0000-\u001f\u007f-\u009f]/u.test(record.message)) {
    fail("LIMIT_EXCEEDED", `${path}.message`, "expected 1-512 UTF-8 bytes without control characters");
  }
  const result: ProtocolErrorEnvelope = {
    protocolVersion: PROTOCOL_VERSION,
    code: record.code as ProtocolErrorCode,
    message: record.message,
  };
  if (Object.hasOwn(record, "retryAfterSeconds")) {
    if (typeof record.retryAfterSeconds !== "number" || !Number.isSafeInteger(record.retryAfterSeconds)) fail("INVALID_TYPE", `${path}.retryAfterSeconds`, "expected safe integer");
    if (record.retryAfterSeconds < 0 || record.retryAfterSeconds > MAX_RETRY_AFTER_SECONDS) fail("LIMIT_EXCEEDED", `${path}.retryAfterSeconds`, `expected 0..${MAX_RETRY_AFTER_SECONDS}`);
    result.retryAfterSeconds = record.retryAfterSeconds;
  }
  return result;
}
