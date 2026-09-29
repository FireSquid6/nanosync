import { ProtocolValidationError } from "./errors.ts";
import { decodeCanonicalBase64Url, parseRecoveryWrap, type RecoveryWrapV1 } from "./bootstrap.ts";
import { parseDeviceId, type DeviceId } from "./ids.ts";
import { PROTOCOL_VERSION } from "./versions.ts";

export const AUTH_TOKEN_BYTES = 32;
export const DEVICE_FINGERPRINT_BYTES = 32;
export const MAX_AUTH_PASSWORD_BYTES = 1024;
export const MAX_DEVICE_DISPLAY_NAME_BYTES = 128;
export const MAX_DEVICE_PLATFORM_BYTES = 32;
export const MAX_CLIENT_VERSION_BYTES = 64;
export const INITIAL_DEVICE_AUTHORIZATION_HEADER = "x-nanosync-bootstrap-authorization" as const;
export const MAX_INITIAL_DEVICE_AUTHORIZATION_BYTES = 1024;

export interface PasswordAuthenticationRequest { protocolVersion: 1; password: string; }
export interface EnrollmentCreateRequest {
  protocolVersion: 1; deviceId: DeviceId; displayName: string; platform: string;
  clientVersion: string; fingerprint: string;
}
export interface DeviceActionRequest { protocolVersion: 1; }
export interface PasswordAuthenticationResponse { protocolVersion: 1; status: "authenticated"; sessionToken: string; expiresAtMs: number; }
export interface EnrollmentResponse { protocolVersion: 1; status: "pending" | "approved"; deviceId: DeviceId; }
export interface EnrollmentStatusResponse { protocolVersion: 1; status: "pending" | "approved" | "denied" | "expired"; deviceId: DeviceId; }
export interface DeviceRecord {
  deviceId: DeviceId; displayName: string | null; platform: string | null; clientVersion: string | null; fingerprint: string | null;
  role: "administrator" | "member"; state: "pending" | "active" | "revoked"; createdAtMs: number; approvedAtMs: number | null; revokedAtMs: number | null;
}
export interface DeviceListResponse { protocolVersion: 1; devices: DeviceRecord[]; }
export interface PendingEnrollmentListResponse { protocolVersion: 1; enrollments: DeviceRecord[]; }
export interface RecoveryWrapResponse { protocolVersion: 1; recoveryWrap: RecoveryWrapV1; }

type Plain = Record<string, unknown>;
function exact(value: unknown, path: string, fields: readonly string[]): Plain {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ProtocolValidationError("INVALID_TYPE", path, "expected object");
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw new ProtocolValidationError("INVALID_TYPE", path, "expected plain object");
  const record = value as Plain;
  for (const field of fields) if (!Object.hasOwn(record, field)) throw new ProtocolValidationError("MISSING_FIELD", `${path}.${field}`, "field is required");
  for (const field of Object.keys(record)) if (!fields.includes(field)) throw new ProtocolValidationError("UNKNOWN_FIELD", `${path}.${field}`, "field is not allowed");
  return record;
}
function version(value: unknown, path: string): 1 {
  if (value !== PROTOCOL_VERSION) throw new ProtocolValidationError(typeof value === "number" ? "UNSUPPORTED_VERSION" : "INVALID_TYPE", path, "protocol version 1 is required");
  return 1;
}
function boundedText(value: unknown, maximum: number, path: string): string {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  const bytes = new TextEncoder().encode(value).byteLength;
  if (bytes < 1 || bytes > maximum || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) throw new ProtocolValidationError("LIMIT_EXCEEDED", path, `expected 1..${maximum} UTF-8 bytes without controls`);
  return value;
}

export function parseAuthToken(value: unknown, path = "token"): string {
  if (typeof value !== "string") throw new ProtocolValidationError("INVALID_TYPE", path, "expected string");
  decodeCanonicalBase64Url(value, AUTH_TOKEN_BYTES, path);
  return value;
}

export function parsePasswordAuthenticationRequest(value: unknown, path = "request"): PasswordAuthenticationRequest {
  const input = exact(value, path, ["protocolVersion", "password"]);
  if (typeof input.password !== "string" || new TextEncoder().encode(input.password).byteLength < 1 || new TextEncoder().encode(input.password).byteLength > MAX_AUTH_PASSWORD_BYTES) throw new ProtocolValidationError("LIMIT_EXCEEDED", `${path}.password`, `password must be 1..${MAX_AUTH_PASSWORD_BYTES} UTF-8 bytes`);
  const password = input.password;
  return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), password };
}

export function parseEnrollmentCreateRequest(value: unknown, path = "request"): EnrollmentCreateRequest {
  const input = exact(value, path, ["protocolVersion", "deviceId", "displayName", "platform", "clientVersion", "fingerprint"]);
  if (typeof input.fingerprint !== "string") throw new ProtocolValidationError("INVALID_TYPE", `${path}.fingerprint`, "expected string");
  decodeCanonicalBase64Url(input.fingerprint, DEVICE_FINGERPRINT_BYTES, `${path}.fingerprint`);
  return {
    protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`),
    deviceId: parseDeviceId(input.deviceId, `${path}.deviceId`),
    displayName: boundedText(input.displayName, MAX_DEVICE_DISPLAY_NAME_BYTES, `${path}.displayName`),
    platform: boundedText(input.platform, MAX_DEVICE_PLATFORM_BYTES, `${path}.platform`),
    clientVersion: boundedText(input.clientVersion, MAX_CLIENT_VERSION_BYTES, `${path}.clientVersion`),
    fingerprint: input.fingerprint,
  };
}

export function parseDeviceActionRequest(value: unknown, path = "request"): DeviceActionRequest {
  const input = exact(value, path, ["protocolVersion"]);
  return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`) };
}

export function parsePasswordAuthenticationResponse(value: unknown, path = "response"): PasswordAuthenticationResponse {
  const input = exact(value, path, ["protocolVersion", "status", "sessionToken", "expiresAtMs"]);
  if (input.status !== "authenticated") throw new ProtocolValidationError("INVALID_VALUE", `${path}.status`, "authenticated is required");
  return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), status: "authenticated", sessionToken: parseAuthToken(input.sessionToken, `${path}.sessionToken`), expiresAtMs: timestamp(input.expiresAtMs, `${path}.expiresAtMs`) };
}
export function parseEnrollmentResponse(value: unknown, path = "response"): EnrollmentResponse {
  const input = exact(value, path, ["protocolVersion", "status", "deviceId"]);
  if (input.status !== "pending" && input.status !== "approved") throw new ProtocolValidationError("INVALID_VALUE", `${path}.status`, "unknown enrollment status");
  return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), status: input.status, deviceId: parseDeviceId(input.deviceId, `${path}.deviceId`) };
}
export function parseEnrollmentStatusResponse(value: unknown, path = "response"): EnrollmentStatusResponse {
  const input = exact(value, path, ["protocolVersion", "status", "deviceId"]);
  if (!["pending", "approved", "denied", "expired"].includes(input.status as string)) throw new ProtocolValidationError("INVALID_VALUE", `${path}.status`, "unknown enrollment status");
  return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), status: input.status as EnrollmentStatusResponse["status"], deviceId: parseDeviceId(input.deviceId, `${path}.deviceId`) };
}
export function parseDeviceListResponse(value: unknown, path = "response"): DeviceListResponse { const input = exact(value, path, ["protocolVersion", "devices"]); return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), devices: deviceArray(input.devices, `${path}.devices`) }; }
export function parsePendingEnrollmentListResponse(value: unknown, path = "response"): PendingEnrollmentListResponse { const input = exact(value, path, ["protocolVersion", "enrollments"]); return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), enrollments: deviceArray(input.enrollments, `${path}.enrollments`) }; }
export function parseRecoveryWrapResponse(value: unknown, path = "response"): RecoveryWrapResponse { const input = exact(value, path, ["protocolVersion", "recoveryWrap"]); return { protocolVersion: version(input.protocolVersion, `${path}.protocolVersion`), recoveryWrap: parseRecoveryWrap(input.recoveryWrap, `${path}.recoveryWrap`) }; }

function timestamp(value: unknown, path: string): number { if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ProtocolValidationError("INVALID_TYPE", path, "expected nonnegative safe integer"); return value; }
function nullableTimestamp(value: unknown, path: string): number | null { return value === null ? null : timestamp(value, path); }
function nullableText(value: unknown, maximum: number, path: string): string | null { return value === null ? null : boundedText(value, maximum, path); }
function deviceArray(value: unknown, path: string): DeviceRecord[] { if (!Array.isArray(value) || value.length > 64) throw new ProtocolValidationError("LIMIT_EXCEEDED", path, "expected at most 64 devices"); return value.map((item, index) => device(item, `${path}[${index}]`)); }
function device(value: unknown, path: string): DeviceRecord {
  const input = exact(value, path, ["deviceId", "displayName", "platform", "clientVersion", "fingerprint", "role", "state", "createdAtMs", "approvedAtMs", "revokedAtMs"]);
  if (input.role !== "administrator" && input.role !== "member") throw new ProtocolValidationError("INVALID_VALUE", `${path}.role`, "unknown device role");
  if (input.state !== "pending" && input.state !== "active" && input.state !== "revoked") throw new ProtocolValidationError("INVALID_VALUE", `${path}.state`, "unknown device state");
  let fingerprint: string | null = null;
  if (input.fingerprint !== null) { if (typeof input.fingerprint !== "string") throw new ProtocolValidationError("INVALID_TYPE", `${path}.fingerprint`, "expected string or null"); decodeCanonicalBase64Url(input.fingerprint, DEVICE_FINGERPRINT_BYTES, `${path}.fingerprint`); fingerprint = input.fingerprint; }
  return { deviceId: parseDeviceId(input.deviceId, `${path}.deviceId`), displayName: nullableText(input.displayName, MAX_DEVICE_DISPLAY_NAME_BYTES, `${path}.displayName`), platform: nullableText(input.platform, MAX_DEVICE_PLATFORM_BYTES, `${path}.platform`), clientVersion: nullableText(input.clientVersion, MAX_CLIENT_VERSION_BYTES, `${path}.clientVersion`), fingerprint, role: input.role, state: input.state, createdAtMs: timestamp(input.createdAtMs, `${path}.createdAtMs`), approvedAtMs: nullableTimestamp(input.approvedAtMs, `${path}.approvedAtMs`), revokedAtMs: nullableTimestamp(input.revokedAtMs, `${path}.revokedAtMs`) };
}
