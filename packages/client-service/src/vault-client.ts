import { assertNoRemoval } from './removal-state.ts';
import { credentialBarrier, credentialMetadata, withCredentialOperation, readCredentialRecord, writeCredentialRecord, cleanupCredentialRecords, initializeCredentials, withCredentialRegistry, type CredentialOptions, type CredentialMode } from "./credentials.ts";
import type { EnrollmentEvent } from "./events.ts";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeRecoverySecret, unwrapMasterKey, RemoteError } from "@nanosync/sync-core";
import { enrollmentVerificationCode, parseCapabilityResponse, parseDeviceId, parseVaultId, parseRecoveryWrap } from "@nanosync/protocol";
import { api, baseUrl, login } from "./client.ts";
import { privateDirectory, syncPrivateDirectory } from "./security.ts";

import { ClientError } from "./errors.ts";

export interface ServerRegistration { version: 1; serverId: string; baseUrl: string; deviceId: string; name: string; token: string }
interface VaultKey { version: 1; serverId: string; vaultId: string; masterKey: string }
const dir = (root: string, leaf: string) => privateDirectory(join(privateDirectory(root), leaf));

export type ServerMetadata = Omit<ServerRegistration, 'token'>;
export function servers(root: string): ServerMetadata[] {
  credentialBarrier(root);
  return readdirSync(dir(root, 'servers')).map(file => {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) throw new Error('unexpected server state file');
    return credentialMetadata(root, `servers/${file}`) as unknown as ServerMetadata;
  });
}
export async function authenticatedServer(root: string, choice?: string, options: CredentialOptions = {}): Promise<ServerRegistration> {
  const info = server(root, choice);
  return readCredentialRecord(root, `servers/${info.serverId}.json`, options);
}
export function server(root: string, choice?: string): ServerMetadata {
  const list = servers(root);
  const selected = choice ? list.filter(item => item.serverId === choice || item.name === choice || item.baseUrl === choice) : list;
  if (selected.length !== 1) throw new Error(selected.length ? "server is ambiguous; select by ID" : "server not found; run nanosync client connections add");
  return selected[0]!;
}
export async function key(root: string, serverId: string, vaultId: string, options: CredentialOptions = {}): Promise<Uint8Array | null> {
  credentialBarrier(root); assertNoRemoval(root);
  parseDeviceId(serverId); parseDeviceId(vaultId);
  const path = `keys/${serverId}-${vaultId}.json`;
  if (!existsSync(join(dir(root, 'keys'), `${serverId}-${vaultId}.json`))) return null;
  const value = await readCredentialRecord<VaultKey>(root, path, options);
  return Buffer.from(value.masterKey, 'hex');
}
export function keyWritePending(root: string, serverId: string, vaultId: string): boolean {
  parseDeviceId(serverId); parseDeviceId(vaultId);
  const path = `keys/${serverId}-${vaultId}.json`;
  return existsSync(join(root, path)) && credentialMetadata(root, path).credentialWrite === 'pending';
}
async function saveKey(root: string, info: ServerMetadata, vaultId: string, master: Uint8Array, options: CredentialOptions): Promise<void> {
  const current = options.retryCredentialWrite && keyWritePending(root, info.serverId, vaultId)
    ? null : await key(root, info.serverId, vaultId, options);
  if (current) {
    try { if (!Buffer.from(current).equals(Buffer.from(master))) throw new Error('vault key differs from stored key'); }
    finally { current.fill(0); }
    return;
  }
  await withCredentialRegistry(root, () => writeCredentialRecord(root, `keys/${info.serverId}-${vaultId}.json`, {version:1, serverId:info.serverId, vaultId, masterKey:Buffer.from(master).toString('hex')}, options));
}

export interface PendingEnrollment { url: string; token: string; deviceId: string; name: string; alias: string; fingerprint: string; serverId: string; expiresAtMs: number; status?: string }
export function pendingEnrollments(root: string): Omit<PendingEnrollment, 'token'>[] {
  credentialBarrier(root);
  return readdirSync(dir(root, 'pending')).map(file => {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('unexpected pending enrollment file');
    const value = credentialMetadata(root, `pending/${file}`) as unknown as Omit<PendingEnrollment, 'token'>;
    if (pendingFile(root, value.url) !== join(dir(root, 'pending'), file)) throw new Error('invalid pending enrollment URL');
    return value;
  });
}
function pendingFile(root: string, url: string) { return join(dir(root, "pending"), createHash("sha256").update(baseUrl(url)).digest("hex") + ".json"); }
export function connectionSummary(info: ServerMetadata) {
  return { serverId: info.serverId, alias: info.name, url: info.baseUrl, deviceId: info.deviceId, status: "approved" as const };
}
export type EnrollmentResult = ReturnType<typeof connectionSummary> | {
  status: 'pending' | 'denied' | 'expired'; alias: string; url: string; deviceId: string; deviceName: string;
};
async function enrollLocked(root: string, url: string, password: string | undefined, deviceName: string,
  waitMs = 60_000, options: { alias?: string; fresh?: boolean; signal?: AbortSignal; password?: () => Promise<string>; onEvent?: (event: EnrollmentEvent) => void } & CredentialOptions = {}): Promise<EnrollmentResult> {
  const waitDeadline = waitMs > 0 ? Date.now() + waitMs : Infinity;
  const interrupted = () => new ClientError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
  // Every exchange is bounded, even submit-and-exit and interactive enrollment.
  // Clear timers after each exchange; combine rather than replace user cancellation.
  async function bounded<T>(operation: (signal: AbortSignal) => Promise<T>, deadline = Infinity): Promise<T> {
    if (options.signal?.aborted) throw interrupted();
    const timeout = new AbortController();
    const timer = setTimeout(() => timeout.abort(), Math.max(1, Math.min(10_000, deadline - Date.now())));
    try {
      return await operation(options.signal ? AbortSignal.any([options.signal, timeout.signal]) : timeout.signal);
    } catch (error) {
      if (options.signal?.aborted) throw interrupted();
      if (timeout.signal.aborted) throw new ClientError("REQUEST_TIMEOUT", "Server request timed out; retry the same command to resume", 5);
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function pause(ms: number) {
    try { await sleep(ms, undefined, {signal:options.signal}); }
    catch (error) { if (options.signal?.aborted) throw interrupted(); throw error; }
  }
  privateDirectory(root);
  const canonical = baseUrl(url), pendingPath = pendingFile(root, canonical);
  if (existsSync(join(root, 'credential-cleanup.json')) && !options.fresh) throw new ClientError('CREDENTIAL_CLEANUP_PENDING', 'Credential cleanup pending; use client credentials resume --confirm-cleanup or repeat the authorized --fresh');
  const existingInfo = servers(root).find(item => item.baseUrl === canonical);
  const existing = existingInfo ? await authenticatedServer(root, existingInfo.serverId, options) : undefined;
  if (options.signal?.aborted) throw interrupted();
  if (existing) {
    if (existsSync(pendingPath)) {
      const saved = await readCredentialRecord<PendingEnrollment>(root, `pending/${pendingPath.split("/").pop()!}`, options);
      if (options.signal?.aborted) throw interrupted();
      if (saved.deviceId !== existing.deviceId || saved.token !== existing.token || saved.serverId !== existing.serverId)
        throw new ClientError("CONFLICT", "pending identity differs from saved connection; inspect local state");
      await withCredentialRegistry(root, async () => { unlinkSync(pendingPath); syncPrivateDirectory(dir(root, "pending")); });
    }
    return connectionSummary(existing);
  }
  if (options.fresh && existsSync(join(root, 'credential-cleanup.json'))) {
    await withCredentialRegistry(root, () => cleanupCredentialRecords(root, [`pending/${pendingPath.split('/').pop()!}`], options));
  }
  let pending: PendingEnrollment | undefined;
  if (existsSync(pendingPath)) {
    const path = `pending/${pendingPath.split('/').pop()!}`;
    const metadata = credentialMetadata(root, path);
    try { pending = await readCredentialRecord<PendingEnrollment>(root, path, options); }
    catch (error) {
      if (!(error instanceof ClientError) || error.code !== 'CREDENTIALS_UNAVAILABLE' ||
          metadata.credentialWrite !== 'pending' || !options.retryCredentialWrite) throw error;
      const secret = password ?? await options.password?.();
      if (!secret) throw new ClientError('INPUT_REQUIRED', 'Password required to retry an unsubmitted credential write');
      const token = await bounded(signal => login(canonical, secret, signal), waitDeadline);
      await withCredentialRegistry(root, () => writeCredentialRecord(root, path, {...metadata, token}, options));
      pending = await readCredentialRecord<PendingEnrollment>(root, path, options);
    }
    if (metadata.credentialWrite === 'pending') {
      await withCredentialRegistry(root, () => writeCredentialRecord(root, path, {...pending!}, options));
    }
  }
  if (options.signal?.aborted) throw interrupted();
  if (pending && options.alias && pending.alias !== options.alias) throw new ClientError("CONFLICT", "Pending request has a different alias; resume that alias");
  const alias = pending?.alias ?? options.alias ?? deviceName;
  if (!alias.trim() || Buffer.byteLength(alias) > 128 || /[\u0000-\u001f\u007f]/u.test(alias)) throw new ClientError("INVALID_INPUT", "invalid connection alias");
  if (servers(root).some(item => item.name === alias) || pendingEnrollments(root).some(item => item.alias === alias && item.url !== canonical))
    throw new ClientError("CONFLICT", "connection alias already in use");
  if (options.fresh && pending) {
    // Fresh is deliberate, and only terminal requests can be replaced.
    let status = pending.status ?? (Date.now() >= pending.expiresAtMs ? "expired" : "pending");
    if (status === "pending") {
      try { status = (await bounded(signal => api(canonical, "/v1/auth/enrollments/status", {signal}, pending!.token), Math.min(pending.expiresAtMs, waitDeadline))).status; }
      catch (error) { if (error instanceof RemoteError && error.status === 401) status = "expired"; else throw error; }
    }
    if (!["denied", "expired"].includes(status)) throw new ClientError("CONFLICT", "Only denied or expired requests may be replaced with --fresh");
    await withCredentialRegistry(root, () => cleanupCredentialRecords(root, [`pending/${pendingPath.split("/").pop()!}`], options)); pending = undefined;
  }
  if (!pending) {
    if (!deviceName || Buffer.byteLength(deviceName)>128 || /[\u0000-\u001f\u007f]/u.test(deviceName)) throw new ClientError("INVALID_INPUT", "invalid device name");
    const secret = password ?? await options.password?.();
    if (!secret) throw new ClientError("INPUT_REQUIRED", "owner password required for first enrollment");
    options.onEvent?.({ type: 'connecting' });
    pending = { url: canonical, token: await bounded(signal => login(canonical, secret, signal), waitDeadline), deviceId: randomUUID(), name: deviceName, alias,
      fingerprint: randomBytes(32).toString("base64url"), serverId: randomUUID(), expiresAtMs: Date.now() + 24 * 60 * 60_000 };
    await withCredentialRegistry(root, () => writeCredentialRecord(root, `pending/${pendingPath.split("/").pop()!}`, {...pending}, options));
  }
  if (options.signal?.aborted) throw interrupted();
  const request = pending;
  options.onEvent?.({ type: 'verification', deviceId: request.deviceId, verificationCode: enrollmentVerificationCode(request.deviceId, request.fingerprint) });
  const until = Math.min(request.expiresAtMs, waitMs === 0 ? Date.now() : waitDeadline);
  let delay = 250;
  async function retry<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    while (true) {
      if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Enrollment interrupted; run the same connections add command to resume", 130);
      if (waitMs !== 0 && Date.now() >= until) return null;
      if (Date.now() >= request.expiresAtMs) return null;
      try { return await bounded(operation, waitMs === 0 ? request.expiresAtMs : until); }
      catch (error) {
        if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        if (!(error instanceof TypeError || error instanceof ClientError && error.code === "REQUEST_TIMEOUT" || error instanceof RemoteError && (error.status >= 500 || error.status === 429))) throw error;
        if (Date.now() >= until) { options.onEvent?.({ type: 'outage-retained' }); return null; }
        options.onEvent?.({ type: 'retrying', delayMs: delay });
        await pause(Math.min(delay, Math.max(0, until - Date.now()))); delay = Math.min(5000, delay * 2);
      }
    }
  }
  const caps = await retry(signal => api(canonical, "/v1/capabilities", {signal}));
  if (caps) {
    let capabilities;
    try { capabilities = parseCapabilityResponse(caps); }
    catch { throw new ClientError('INVALID_RESPONSE', 'Invalid server capabilities', 5); }
    const admin = capabilities.webAdministration;
    if (admin.enabled && admin.url) options.onEvent?.({ type: 'administration', url: admin.url });
  }
  let status = Date.now() >= request.expiresAtMs ? "expired" : request.status ?? "pending";
  if (status === "pending") {
    try {
      const response = await retry(signal => api(canonical, "/v1/auth/enrollments", { method: "POST", body: JSON.stringify({ protocolVersion: 1,
        deviceId: request.deviceId, displayName: request.name, platform: process.platform, clientVersion: "1", fingerprint: request.fingerprint }), signal }, request.token));
      status = response?.status ?? "pending";
      if (status === "pending") {
        options.onEvent?.({ type: 'waiting', progress: Date.now() < until });
      }
      while (status === "pending" && Date.now() < until) {
        if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        await pause(Math.min(1000, until - Date.now()));
        if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        if (Date.now() >= request.expiresAtMs) { status = "expired"; break; }
        status = (await retry(signal => api(canonical, "/v1/auth/enrollments/status", {signal}, request.token)))?.status ?? "pending";
      }
    } catch (error) {
      if (error instanceof RemoteError && error.status === 401) status = "expired";
      else throw error;
    }
  }
  if (status === "pending" && Date.now() >= request.expiresAtMs) status = "expired";
  if (!['pending', 'approved', 'denied', 'expired'].includes(status)) throw new ClientError('INVALID_RESPONSE', 'Invalid enrollment response', 5);
  if (status === "approved") {
    const info: ServerRegistration = { version: 1, serverId: request.serverId, baseUrl: canonical, deviceId: request.deviceId, name: alias, token: request.token };
    const path = join(dir(root, "servers"), `${request.serverId}.json`);
    if (existsSync(path)) {
      const current = await authenticatedServer(root, info.serverId, options);
      if (current.token !== info.token || current.deviceId !== info.deviceId) throw new ClientError('CONFLICT', 'saved credential differs from pending enrollment');
    } else await withCredentialRegistry(root, () => writeCredentialRecord(root, `servers/${request.serverId}.json`, {...info}, options));
    await withCredentialRegistry(root, async () => { unlinkSync(pendingPath); syncPrivateDirectory(dir(root, "pending")); });
    options.onEvent?.({ type: 'approved' });
    return connectionSummary(info);
  }
  if (options.signal?.aborted) throw new ClientError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
  if (status === "denied" || status === "expired") {
    await withCredentialRegistry(root, () => writeCredentialRecord(root, `pending/${pendingPath.split("/").pop()!}`, {...request, status}, options));
    options.onEvent?.({ type: 'terminal', status });
  }
  return { status: status as 'pending' | 'denied' | 'expired', alias, url: canonical, deviceId: request.deviceId, deviceName: request.name };
}

export async function unlockVault(root: string, info: ServerMetadata, vaultId: string, secret: string, options: CredentialOptions = {}): Promise<void> {
  assertNoRemoval(root);
  return withCredentialOperation(root, async () => {
  const credential = await authenticatedServer(root, info.serverId, options);
  const wrap = await api(credential.baseUrl, "/v1/recovery-wrap", { headers: { "x-nanosync-vault-id": vaultId } }, credential.token);
  let recoveryWrap;
  try { recoveryWrap = parseRecoveryWrap(wrap.recoveryWrap); }
  catch { throw new ClientError('INVALID_RESPONSE', 'Invalid server recovery wrap', 5); }
  const recovery = await decodeRecoverySecret(secret);
  try {
    const master = await unwrapMasterKey(recoveryWrap, recovery, vaultId);
    try { await saveKey(root, info, vaultId, master, options); } finally { master.fill(0); }
  } finally { recovery.fill(0); }
  });
}

export interface RemoteVault { vaultId: string; name: string }
export async function listRemoteVaults(root: string, info: ServerMetadata, options: CredentialOptions = {}): Promise<RemoteVault[]> {
  const credential = await authenticatedServer(root, info.serverId, options);
  const value = (await api(credential.baseUrl, '/v1/vaults', {}, credential.token)).vaults;
  if (!Array.isArray(value) || value.length > 10000) throw new ClientError('INVALID_RESPONSE', 'Invalid vault list', 5);
  const seen = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || typeof item.name !== 'string' || !item.name.trim() || Buffer.byteLength(item.name) > 1024 || /[\u0000-\u001f\u007f]/u.test(item.name))
      throw new ClientError('INVALID_RESPONSE', 'Invalid vault list', 5);
    let vaultId: string;
    try { vaultId = parseVaultId(item.vaultId); } catch { throw new ClientError('INVALID_RESPONSE', 'Invalid vault list', 5); }
    if (seen.has(vaultId)) throw new ClientError('INVALID_RESPONSE', 'Invalid vault list', 5);
    seen.add(vaultId);
    return { vaultId, name: item.name };
  });
}
export function resolveRemoteVault(list: RemoteVault[], choice: string): RemoteVault {
  const matches = list.filter(vault => vault.vaultId === choice || vault.name === choice);
  if (matches.length !== 1) throw new ClientError('NOT_FOUND', 'vault not found or ambiguous');
  return matches[0]!;
}

export async function enrollServer(root: string, url: string, password: string | undefined, deviceName: string,
  waitMs = 60_000, options: Parameters<typeof enrollLocked>[5] & {credentialMode?: CredentialMode} = {}) {
  const interrupted = () => new ClientError('INTERRUPTED', 'Enrollment interrupted; retry the same command to resume', 130);
  if (options.signal?.aborted) throw interrupted();
  initializeCredentials(root, options.credentialMode);
  try {
    const result = await withCredentialOperation(root, () => enrollLocked(root, url, password, deviceName, waitMs, options));
    if (options.signal?.aborted) throw interrupted();
    return result;
  } catch (error) {
    if (options.signal?.aborted) throw interrupted();
    throw error;
  }
}
