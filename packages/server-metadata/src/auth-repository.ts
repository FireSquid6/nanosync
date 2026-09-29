import { timingSafeEqual } from "node:crypto";
import type { DeviceId, EnrollmentCreateRequest, PrincipalId, RecoveryWrapV1, VaultId } from "@nanosync/protocol";
import { ServerMetadataDatabase, type MetadataTransaction } from "./database.ts";
import { validateVerifier, type PasswordVerifierRecord } from "./bootstrap-repository.ts";

export const PASSWORD_SESSION_LIFETIME_MS = 10 * 60_000;
export const ENROLLMENT_LIFETIME_MS = 24 * 60 * 60_000;
export const LOGIN_FAILURE_WINDOW_MS = 15 * 60_000;
export const LOGIN_LOCKOUT_MS = 15 * 60_000;
export const MAX_LOGIN_FAILURES = 5;
export const MAX_PENDING_ENROLLMENTS = 32;
export const MAX_DEVICES = 64;
export const MAX_PASSWORD_SESSIONS = 64;
export const AUDIT_RETENTION_MS = 365 * 24 * 60 * 60_000;

export type EnrollmentStatus = "pending" | "approved" | "denied" | "expired";
export interface AuthIdentity { principalId: PrincipalId; deviceId: DeviceId; vaultId: VaultId; administrator: boolean; }
export interface DeviceView { deviceId: DeviceId; displayName: string | null; platform: string | null; clientVersion: string | null; fingerprint: string | null; role: "administrator" | "member"; state: "pending" | "active" | "revoked"; createdAtMs: number; approvedAtMs: number | null; revokedAtMs: number | null; }

export class AuthRepositoryError extends Error {
  constructor(readonly code: "UNAUTHORIZED" | "FORBIDDEN" | "CONFLICT" | "LIMIT" | "LOCKED" | "INVARIANT", message: string, readonly retryAfterMs?: number) { super(message); this.name = "AuthRepositoryError"; }
}

interface DeviceRow { device_id: DeviceId; principal_id: PrincipalId; vault_id: VaultId; state: "pending" | "active" | "revoked"; role: "administrator" | "member"; credential_digest: Uint8Array | null; display_name: string | null; platform: string | null; client_version: string | null; fingerprint: Uint8Array | null; created_at_ms: number; approved_at_ms: number | null; revoked_at_ms: number | null; }
interface SessionRow { token_digest: Uint8Array; principal_id: PrincipalId; device_id: DeviceId | null; created_at_ms: number; expires_at_ms: number; }

export class AuthenticationRepository {
  constructor(private readonly database: ServerMetadataDatabase) {}

  passwordVerifier(): PasswordVerifierRecord | null {
    const row = this.database.get<Record<string, unknown>>("SELECT password_algorithm, password_version, password_memory_kib, password_iterations, password_parallelism, password_salt, password_hash FROM accounts WHERE singleton = 1 AND EXISTS (SELECT 1 FROM bootstrap_state WHERE singleton=1 AND lifecycle='sealed')");
    if (!row) return null;
    const value: PasswordVerifierRecord = { algorithm: row.password_algorithm as "argon2id", version: row.password_version as 19, memoryKiB: row.password_memory_kib as number, iterations: row.password_iterations as number, parallelism: row.password_parallelism as number, salt: blob(row.password_salt), hash: blob(row.password_hash) };
    validateVerifier(value, false); return value;
  }

  lockoutRemaining(nowMs: number): number {
    const row = this.database.get<{ locked_until_ms: number }>("SELECT locked_until_ms FROM authentication_rate_limit WHERE singleton = 1");
    return Math.max(0, (row?.locked_until_ms ?? 0) - nowMs);
  }

  loginFailed(nowMs: number, rateLimited = false): number {
    return this.database.writeTransaction((tx) => {
      cleanup(tx, nowMs);
      const row = tx.get<{ window_started_at_ms: number; failed_attempts: number; locked_until_ms: number }>("SELECT window_started_at_ms, failed_attempts, locked_until_ms FROM authentication_rate_limit WHERE singleton = 1");
      let start = row?.window_started_at_ms ?? nowMs, attempts = row?.failed_attempts ?? 0, locked = row?.locked_until_ms ?? 0;
      if (nowMs - start >= LOGIN_FAILURE_WINDOW_MS && nowMs >= locked) { start = nowMs; attempts = 0; locked = 0; }
      if (!rateLimited) attempts = Math.min(MAX_LOGIN_FAILURES, attempts + 1);
      if (!rateLimited && attempts >= MAX_LOGIN_FAILURES) {
        locked = Math.max(locked, nowMs + LOGIN_LOCKOUT_MS);
        tx.run("DELETE FROM password_sessions WHERE device_id IS NULL");
      }
      tx.run("INSERT INTO authentication_rate_limit(singleton, window_started_at_ms, failed_attempts, locked_until_ms) VALUES (1, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET window_started_at_ms=excluded.window_started_at_ms, failed_attempts=excluded.failed_attempts, locked_until_ms=excluded.locked_until_ms", [start, attempts, locked]);
      audit(tx, rateLimited || locked > nowMs ? "login.rate_limited" : "login.failure", nowMs, null, null);
      return Math.max(0, locked - nowMs);
    });
  }

  loginSucceeded(digest: Uint8Array, nowMs: number, verified: PasswordVerifierRecord, upgraded?: PasswordVerifierRecord): { principalId: PrincipalId; expiresAtMs: number } {
    validateVerifier(verified, false);
    if (upgraded) validateVerifier(upgraded, true);
    return this.database.writeTransaction((tx) => {
      cleanup(tx, nowMs);
      const rate = tx.get<{ locked_until_ms: number }>("SELECT locked_until_ms FROM authentication_rate_limit WHERE singleton=1");
      if (rate && rate.locked_until_ms > nowMs) {
        audit(tx, "login.rate_limited", nowMs, null, null);
        throw new AuthRepositoryError("LOCKED", "Authentication is temporarily unavailable", rate.locked_until_ms - nowMs);
      }
      const account = tx.get<{ principal_id: PrincipalId; password_updated_at_ms: number; password_algorithm: string; password_version: number; password_memory_kib: number; password_iterations: number; password_parallelism: number; password_salt: Uint8Array; password_hash: Uint8Array }>("SELECT * FROM accounts WHERE singleton = 1");
      if (!account) throw new AuthRepositoryError("UNAUTHORIZED", "Authentication failed");
      if (!verifierMatches(account, verified)) throw new AuthRepositoryError("UNAUTHORIZED", "Authentication failed");
      const sessions = tx.get<{ count: number }>("SELECT count(*) AS count FROM password_sessions WHERE expires_at_ms > ?", [nowMs])?.count ?? 0;
      if (sessions >= MAX_PASSWORD_SESSIONS) throw new AuthRepositoryError("LIMIT", "Too many authentication sessions");
      if (upgraded) {
        const updated = Math.max(nowMs, account.password_updated_at_ms + 1);
        tx.run("UPDATE accounts SET password_algorithm=?, password_version=?, password_memory_kib=?, password_iterations=?, password_parallelism=?, password_salt=?, password_hash=?, password_updated_at_ms=? WHERE singleton=1", [upgraded.algorithm, upgraded.version, upgraded.memoryKiB, upgraded.iterations, upgraded.parallelism, upgraded.salt, upgraded.hash, updated]);
      }
      tx.run("DELETE FROM authentication_rate_limit WHERE singleton = 1");
      const expiresAtMs = nowMs + PASSWORD_SESSION_LIFETIME_MS;
      tx.run("INSERT INTO password_sessions(token_digest, principal_id, device_id, created_at_ms, expires_at_ms) VALUES (?, ?, NULL, ?, ?)", [digest, account.principal_id, nowMs, expiresAtMs]);
      audit(tx, "login.success", nowMs, null, null);
      return { principalId: account.principal_id, expiresAtMs };
    });
  }

  session(digest: Uint8Array, nowMs: number): SessionRow | null {
    const rows = this.database.all<SessionRow>("SELECT * FROM password_sessions WHERE expires_at_ms > ?", [nowMs]);
    return constantTimeFind(rows, digest, (row) => row.token_digest);
  }

  isDesignatedInitialDevice(deviceId: DeviceId): boolean {
    const row = this.database.get<{ device_id: DeviceId }>("SELECT device_id FROM initial_devices WHERE singleton=1");
    return row?.device_id === deviceId;
  }

  initialAuthorizationRequired(digest: Uint8Array, deviceId: DeviceId, nowMs: number): boolean {
    if (!this.isDesignatedInitialDevice(deviceId)) return false;
    const session = this.session(digest, nowMs);
    if (!session) return true;
    const existing = this.database.get<{ device_id: DeviceId; state: string }>("SELECT device_id,state FROM enrollment_requests WHERE token_digest=?", [session.token_digest]);
    return existing?.device_id !== deviceId || existing.state !== "approved";
  }

  createEnrollment(digest: Uint8Array, input: EnrollmentCreateRequest, nowMs: number, initialAuthorizationVerified = false): EnrollmentStatus {
    return this.database.writeTransaction((tx) => {
      cleanup(tx, nowMs);
      const session = constantTimeFind(tx.all<SessionRow>("SELECT * FROM password_sessions WHERE expires_at_ms > ?", [nowMs]), digest, (row) => row.token_digest);
      if (!session) throw new AuthRepositoryError("UNAUTHORIZED", "Authentication is required");
      const existing = tx.get<any>("SELECT * FROM enrollment_requests WHERE token_digest = ?", [session.token_digest]);
      if (existing) {
        if (existing.device_id !== input.deviceId || existing.display_name !== input.displayName || existing.platform !== input.platform || existing.client_version !== input.clientVersion || !equal(existing.fingerprint, Buffer.from(input.fingerprint, "base64url"))) throw new AuthRepositoryError("CONFLICT", "Authentication session is already bound");
        return existing.state as EnrollmentStatus;
      }
      const pending = tx.get<{ count: number }>("SELECT count(*) AS count FROM enrollment_requests WHERE state='pending' AND expires_at_ms > ?", [nowMs])?.count ?? 0;
      if (pending >= MAX_PENDING_ENROLLMENTS) throw new AuthRepositoryError("LIMIT", "Too many pending enrollments");
      const current = tx.get<DeviceRow>("SELECT * FROM devices WHERE device_id = ?", [input.deviceId]);
      const initial = tx.get<{ device_id: DeviceId }>("SELECT device_id FROM initial_devices WHERE singleton=1");
      const designatedInitial = input.deviceId === initial?.device_id;
      if (designatedInitial && (!initialAuthorizationVerified || current?.state !== "pending" || current.role !== "administrator" || current.credential_digest !== null)) throw new AuthRepositoryError("FORBIDDEN", "Initial device authorization is required");
      if (current?.state === "active" || current?.state === "pending" && input.deviceId !== initial?.device_id) throw new AuthRepositoryError("CONFLICT", "Device is already registered");
      if (current?.state === "revoked") {
        if (designatedInitial || current.role === "administrator") throw new AuthRepositoryError("FORBIDDEN", "Administrator re-enrollment is unavailable");
        tx.run("DELETE FROM enrollment_requests WHERE device_id=?", [input.deviceId]);
      }
      if (!current) {
        const count = tx.get<{ count: number }>("SELECT count(*) AS count FROM devices")?.count ?? 0;
        if (count >= MAX_DEVICES) throw new AuthRepositoryError("LIMIT", "Device limit reached");
        const state = "pending";
        tx.run("INSERT INTO devices(device_id, principal_id, vault_id, state, role, display_name, platform, client_version, fingerprint, is_initial, created_at_ms) SELECT ?, a.principal_id, s.vault_id, ?, 'member', ?, ?, ?, ?, 0, ? FROM accounts a, server_state s WHERE a.singleton=1 AND s.singleton=1", [input.deviceId, state, input.displayName, input.platform, input.clientVersion, Buffer.from(input.fingerprint, "base64url"), nowMs]);
      }
      const autoApprove = designatedInitial && initialAuthorizationVerified && current?.state === "pending";
      tx.run("INSERT INTO enrollment_requests(token_digest, device_id, display_name, platform, client_version, fingerprint, state, created_at_ms, expires_at_ms, decided_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", [session.token_digest, input.deviceId, input.displayName, input.platform, input.clientVersion, Buffer.from(input.fingerprint, "base64url"), autoApprove ? "approved" : "pending", nowMs, nowMs + ENROLLMENT_LIFETIME_MS, autoApprove ? nowMs : null]);
      tx.run("UPDATE password_sessions SET device_id=? WHERE token_digest=?", [input.deviceId, session.token_digest]);
      tx.run("UPDATE password_sessions SET expires_at_ms=? WHERE token_digest=?", [nowMs + ENROLLMENT_LIFETIME_MS, session.token_digest]);
      if (autoApprove) {
        tx.run("UPDATE devices SET state='active', credential_digest=?, display_name=?, platform=?, client_version=?, fingerprint=?, approved_at_ms=? WHERE device_id=? AND state='pending'", [session.token_digest, input.displayName, input.platform, input.clientVersion, Buffer.from(input.fingerprint, "base64url"), nowMs, input.deviceId]);
        audit(tx, "device.initial_activated", nowMs, input.deviceId, input.deviceId);
      } else audit(tx, "enrollment.created", nowMs, null, input.deviceId);
      return autoApprove ? "approved" : "pending";
    });
  }

  enrollmentStatus(digest: Uint8Array, nowMs: number): { status: EnrollmentStatus; deviceId: DeviceId } | null {
    const session = this.session(digest, nowMs);
    if (!session?.device_id) return null;
    const row = this.database.get<{ state: "pending" | "approved" | "denied"; expires_at_ms: number }>("SELECT state, expires_at_ms FROM enrollment_requests WHERE token_digest=?", [session.token_digest]);
    if (!row) return null;
    return { status: row.expires_at_ms <= nowMs && row.state === "pending" ? "expired" : row.state, deviceId: session.device_id };
  }

  authorizeCredential(digest: Uint8Array): AuthIdentity | null {
    const rows = this.database.all<DeviceRow>("SELECT * FROM devices WHERE state='active'");
    const row = constantTimeFind(rows, digest, (item) => item.credential_digest);
    return row ? { principalId: row.principal_id, deviceId: row.device_id, vaultId: row.vault_id, administrator: row.role === "administrator" } : null;
  }

  listPending(nowMs: number): DeviceView[] { return this.database.all<DeviceRow>("SELECT d.* FROM devices d JOIN enrollment_requests e ON e.device_id=d.device_id WHERE e.state='pending' AND e.expires_at_ms > ? ORDER BY e.created_at_ms, d.device_id", [nowMs]).map(view); }
  listDevices(): DeviceView[] { return this.database.all<DeviceRow>("SELECT * FROM devices ORDER BY created_at_ms, device_id").map(view); }

  approve(actor: DeviceId, target: DeviceId, nowMs: number): EnrollmentStatus {
    return this.database.writeTransaction((tx) => {
      requireActiveAdministrator(tx, actor);
      const request = tx.get<any>("SELECT * FROM enrollment_requests WHERE device_id=?", [target]);
      if (!request) throw new AuthRepositoryError("CONFLICT", "Enrollment is unavailable");
      if (request.state === "approved") return "approved";
      if (request.state !== "pending" || request.expires_at_ms <= nowMs) throw new AuthRepositoryError("CONFLICT", "Enrollment is unavailable");
      const changed = tx.run("UPDATE devices SET state='active', credential_digest=?, display_name=?, platform=?, client_version=?, fingerprint=?, approved_at_ms=?, revoked_at_ms=NULL WHERE device_id=? AND state IN ('pending','revoked')", [request.token_digest, request.display_name, request.platform, request.client_version, request.fingerprint, nowMs, target]).changes;
      if (changed !== 1) throw new AuthRepositoryError("CONFLICT", "Enrollment is unavailable");
      tx.run("UPDATE enrollment_requests SET state='approved', decided_at_ms=? WHERE device_id=? AND state='pending'", [nowMs, target]);
      audit(tx, "enrollment.approved", nowMs, actor, target); return "approved";
    });
  }

  revoke(actor: DeviceId, target: DeviceId, nowMs: number): void {
    this.database.writeTransaction((tx) => {
      requireActiveAdministrator(tx, actor);
      if (actor === target) throw new AuthRepositoryError("FORBIDDEN", "Self-revocation is not permitted");
      const device = tx.get<DeviceRow>("SELECT * FROM devices WHERE device_id=?", [target]);
      if (!device || device.state !== "active") throw new AuthRepositoryError("CONFLICT", "Device is not active");
      if (device.role === "administrator") {
        const admins = tx.get<{ count: number }>("SELECT count(*) AS count FROM devices WHERE state='active' AND role='administrator'")?.count ?? 0;
        if (admins <= 1) throw new AuthRepositoryError("FORBIDDEN", "The last active administrator cannot be revoked");
      }
      tx.run("UPDATE devices SET state='revoked', credential_digest=NULL, revoked_at_ms=? WHERE device_id=? AND state='active'", [nowMs, target]);
      tx.run("DELETE FROM password_sessions WHERE device_id=?", [target]);
      audit(tx, "device.revoked", nowMs, actor, target);
    });
  }

  recoveryWrap(): RecoveryWrapV1 {
    const row = this.database.get<{ wrap_version: number; algorithm: string; nonce: Uint8Array; ciphertext: Uint8Array }>("SELECT wrap_version, algorithm, nonce, ciphertext FROM recovery_wraps WHERE singleton=1");
    if (!row || row.wrap_version !== 1 || row.algorithm !== "A256GCM" || blob(row.nonce).length !== 12 || blob(row.ciphertext).length !== 48) throw new AuthRepositoryError("INVARIANT", "Recovery metadata is unavailable");
    return { version: 1, algorithm: "A256GCM", nonce: Buffer.from(row.nonce).toString("base64url"), ciphertext: Buffer.from(row.ciphertext).toString("base64url") };
  }
}

function cleanup(tx: MetadataTransaction, nowMs: number): void {
  tx.run("DELETE FROM password_sessions WHERE expires_at_ms <= ?", [nowMs]);
  tx.run("DELETE FROM devices WHERE state='pending' AND is_initial=0 AND NOT EXISTS (SELECT 1 FROM enrollment_requests e WHERE e.device_id=devices.device_id)");
  tx.run("DELETE FROM audit_events WHERE occurred_at_ms < ?", [Math.max(0, nowMs - AUDIT_RETENTION_MS)]);
}
function audit(tx: MetadataTransaction, type: string, now: number, actor: DeviceId | null, subject: DeviceId | null): void { tx.run("INSERT INTO audit_events(event_type, actor_device_id, subject_device_id, occurred_at_ms, details_json) VALUES (?, ?, ?, ?, '{}')", [type, actor, subject, now]); }
function blob(value: unknown): Uint8Array { if (!(value instanceof Uint8Array)) throw new AuthRepositoryError("INVARIANT", "Persisted authentication state is invalid"); return Uint8Array.from(value); }
function equal(a: unknown, b: Uint8Array): boolean { return a instanceof Uint8Array && a.length === b.length && timingSafeEqual(a, b); }
function constantTimeFind<T>(rows: T[], digest: Uint8Array, select: (row: T) => Uint8Array | null): T | null { let found: T | null = null; for (const row of rows) { const candidate = select(row); if (candidate instanceof Uint8Array && candidate.length === 32 && digest.length === 32 && timingSafeEqual(candidate, digest)) found = row; } return found; }
function view(row: DeviceRow): DeviceView { return { deviceId: row.device_id, displayName: row.display_name, platform: row.platform, clientVersion: row.client_version, fingerprint: row.fingerprint ? Buffer.from(row.fingerprint).toString("base64url") : null, role: row.role, state: row.state, createdAtMs: row.created_at_ms, approvedAtMs: row.approved_at_ms, revokedAtMs: row.revoked_at_ms }; }
function requireActiveAdministrator(tx: MetadataTransaction, actor: DeviceId): DeviceRow {
  const row = tx.get<DeviceRow>("SELECT * FROM devices WHERE device_id=?", [actor]);
  if (!row || row.state !== "active" || row.role !== "administrator" || !(row.credential_digest instanceof Uint8Array) || row.credential_digest.length !== 32) throw new AuthRepositoryError("FORBIDDEN", "Administrator authorization is required");
  return row;
}
function verifierMatches(row: { password_algorithm: string; password_version: number; password_memory_kib: number; password_iterations: number; password_parallelism: number; password_salt: Uint8Array; password_hash: Uint8Array }, verifier: PasswordVerifierRecord): boolean {
  return row.password_algorithm === verifier.algorithm && row.password_version === verifier.version && row.password_memory_kib === verifier.memoryKiB && row.password_iterations === verifier.iterations && row.password_parallelism === verifier.parallelism && equal(row.password_salt, verifier.salt) && equal(row.password_hash, verifier.hash);
}
