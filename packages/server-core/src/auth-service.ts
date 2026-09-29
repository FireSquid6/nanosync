import { createHmac, randomBytes } from "node:crypto";
import {
  AUTH_TOKEN_BYTES, PROTOCOL_VERSION, decodeCanonicalBase64Url, parseAuthToken,
  type EnrollmentCreateRequest, type DeviceId,
} from "@nanosync/protocol";
import {
  AuthenticationRepository, AuthRepositoryError,
  type AuthIdentity, type PasswordVerifierRecord,
} from "@nanosync/server-metadata";
import { ApiError, json } from "./http.ts";
import { Argon2idPasswordHasher, type PasswordHasher } from "./password-hasher.ts";

const TOKEN_HMAC_LABEL = new TextEncoder().encode("nanosync/v1/bearer-token\0");
export type RandomBytes = (length: number) => Uint8Array;

export class AuthenticationService {
  private readonly pepper: Uint8Array;
  private readonly clock: () => number;
  private readonly random: RandomBytes;
  private readonly password: PasswordHasher;
  constructor(readonly repository: AuthenticationRepository, options: { pepper: Uint8Array; clock?: () => number; random?: RandomBytes; password?: PasswordHasher }) {
    if (!(options.pepper instanceof Uint8Array) || options.pepper.length < 32 || options.pepper.length > 64) throw new TypeError("credential pepper must contain 32..64 bytes");
    this.pepper = Uint8Array.from(options.pepper);
    this.clock = options.clock ?? Date.now;
    this.random = options.random ?? ((length) => randomBytes(length));
    this.password = options.password ?? new Argon2idPasswordHasher();
    if (typeof this.password.verify !== "function") throw new TypeError("password primitive must support verification");
  }

  async login(password: string): Promise<Response> {
    const now = this.now();
    const locked = this.repository.lockoutRemaining(now);
    if (locked > 0) { this.repository.loginFailed(now, true); throw rateLimit(locked); }
    const bytes = new TextEncoder().encode(password);
    try {
      let verifier: PasswordVerifierRecord | null = null;
      try { verifier = this.repository.passwordVerifier(); } catch { /* Public authentication failure is deliberately generic. */ }
      let accepted = false;
      try { accepted = !!verifier && await this.password.verify!(bytes, verifier); } catch { accepted = false; }
      if (!accepted || !verifier) {
        const remaining = this.repository.loginFailed(now);
        if (remaining > 0) throw rateLimit(remaining);
        throw new ApiError(401, "UNAUTHORIZED", "Authentication failed");
      }
      const tokenBytes = this.uniqueToken(), token = Buffer.from(tokenBytes).toString("base64url"), digest = this.digest(tokenBytes);
      const upgrade = isBaseline(verifier) ? undefined : await this.password.hash(bytes);
      const result = this.repository.loginSucceeded(digest, now, verifier, upgrade);
      tokenBytes.fill(0);
      return json({ protocolVersion: PROTOCOL_VERSION, status: "authenticated", sessionToken: token, expiresAtMs: result.expiresAtMs }, 200, { "cache-control": "no-store" });
    } finally { bytes.fill(0); }
  }

  isDesignatedInitialDevice(deviceId: DeviceId): boolean { return this.repository.isDesignatedInitialDevice(deviceId); }
  initialAuthorizationRequired(token: string, deviceId: DeviceId): boolean { return this.repository.initialAuthorizationRequired(this.tokenDigest(token), deviceId, this.now()); }
  createEnrollment(token: string, input: EnrollmentCreateRequest, initialAuthorizationVerified = false): Response {
    const status = this.repository.createEnrollment(this.tokenDigest(token), input, this.now(), initialAuthorizationVerified);
    return json({ protocolVersion: PROTOCOL_VERSION, status, deviceId: input.deviceId }, status === "approved" ? 200 : 202, { "cache-control": "no-store" });
  }
  enrollmentStatus(token: string): Response {
    const result = this.repository.enrollmentStatus(this.tokenDigest(token), this.now());
    if (!result) throw unauthorized();
    return json({ protocolVersion: PROTOCOL_VERSION, ...result }, 200, { "cache-control": "no-store" });
  }
  authorize(request: Request): AuthIdentity {
    const token = bearer(request); const identity = this.repository.authorizeCredential(this.tokenDigest(token));
    if (!identity) throw unauthorized(); return identity;
  }
  requireAdmin(request: Request): AuthIdentity { const identity = this.authorize(request); if (!identity.administrator) throw new ApiError(403, "FORBIDDEN", "Administrator authorization is required"); return identity; }
  pending(request: Request): Response { this.requireAdmin(request); return json({ protocolVersion: PROTOCOL_VERSION, enrollments: this.repository.listPending(this.now()) }); }
  devices(request: Request): Response { this.requireAdmin(request); return json({ protocolVersion: PROTOCOL_VERSION, devices: this.repository.listDevices() }); }
  approve(request: Request, target: DeviceId): Response { const actor = this.requireAdmin(request); const status = this.repository.approve(actor.deviceId, target, this.now()); return json({ protocolVersion: PROTOCOL_VERSION, status, deviceId: target }); }
  revoke(request: Request, target: DeviceId): Response { const actor = this.requireAdmin(request); this.repository.revoke(actor.deviceId, target, this.now()); return json({ protocolVersion: PROTOCOL_VERSION, status: "revoked", deviceId: target }); }
  recovery(request: Request): Response { this.authorize(request); return json({ protocolVersion: PROTOCOL_VERSION, recoveryWrap: this.repository.recoveryWrap() }, 200, { "cache-control": "no-store" }); }

  private now(): number { const value = this.clock(); if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid clock"); return value; }
  private digest(bytes: Uint8Array): Uint8Array { return Uint8Array.from(createHmac("sha256", this.pepper).update(TOKEN_HMAC_LABEL).update(bytes).digest()); }
  private tokenDigest(token: string): Uint8Array { parseAuthToken(token); return this.digest(decodeCanonicalBase64Url(token, AUTH_TOKEN_BYTES)); }
  private uniqueToken(): Uint8Array { const value = this.random(AUTH_TOKEN_BYTES); if (!(value instanceof Uint8Array) || value.length !== AUTH_TOKEN_BYTES) throw new Error("Random source returned invalid bytes"); return Uint8Array.from(value); }
}

export function bearer(request: Request): string {
  const value = request.headers.get("authorization");
  if (!value || value.includes(",") || !/^Bearer [A-Za-z0-9_-]{43}$/.test(value)) throw unauthorized();
  try { return parseAuthToken(value.slice(7)); } catch { throw unauthorized(); }
}
function unauthorized(): ApiError { return new ApiError(401, "UNAUTHORIZED", "Authorization is required"); }
function rateLimit(milliseconds: number): ApiError { const seconds = Math.max(1, Math.ceil(milliseconds / 1000)); return new ApiError(429, "RATE_LIMITED", "Authentication is temporarily unavailable", { "retry-after": String(seconds) }, seconds); }
function isBaseline(value: PasswordVerifierRecord): boolean { return value.algorithm === "argon2id" && value.version === 19 && value.memoryKiB === 65_536 && value.iterations === 3 && value.parallelism === 1 && value.salt.length === 16 && value.hash.length === 32; }
export function mapAuthRepositoryError(error: unknown): never {
  if (!(error instanceof AuthRepositoryError)) throw error;
  if (error.code === "UNAUTHORIZED") throw unauthorized();
  if (error.code === "LOCKED") throw rateLimit(error.retryAfterMs ?? 1_000);
  if (error.code === "FORBIDDEN") throw new ApiError(403, "FORBIDDEN", error.message);
  if (error.code === "LIMIT") throw new ApiError(429, "RATE_LIMITED", error.message);
  if (error.code === "CONFLICT") throw new ApiError(409, "CONFLICT", error.message);
  throw error;
}
