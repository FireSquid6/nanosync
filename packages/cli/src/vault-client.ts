import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { decodeRecoverySecret, unwrapMasterKey, RemoteError } from "@nanosync/sync-core";
import { enrollmentVerificationCode, parseCapabilityResponse, parseDeviceId, parseAuthToken, decodeCanonicalBase64Url } from "@nanosync/protocol";
import { api, baseUrl, login } from "./client.ts";
import { privateDirectory, secureCreate, secureRead, secureReplace, syncPrivateDirectory } from "./security.ts";

import { hidden as secretPrompt, CliError } from "./prompts.ts";
import { output } from './output.ts';

export interface ServerRegistration { version: 1; serverId: string; baseUrl: string; deviceId: string; name: string; token: string }
interface VaultKey { version: 1; serverId: string; vaultId: string; masterKey: string }
const dir = (root: string, leaf: string) => privateDirectory(join(privateDirectory(root), leaf));

export function servers(root: string): ServerRegistration[] {
  const path = dir(root, "servers");
  return readdirSync(path).map(file => {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) throw new Error("unexpected server state file");
    const value = JSON.parse(secureRead(join(path, file), 2048).toString("utf8")) as ServerRegistration;
    if (value.version !== 1 || value.serverId !== file.slice(0,-5) || typeof value.token !== "string" ||
        typeof value.name !== "string" || baseUrl(value.baseUrl) !== value.baseUrl) throw new Error("invalid server registration");
    return value;
  });
}
export function server(root: string, choice?: string): ServerRegistration {
  const list = servers(root);
  const selected = choice ? list.filter(item => item.serverId === choice || item.name === choice || item.baseUrl === choice) : list;
  if (selected.length !== 1) throw new Error(selected.length ? "server is ambiguous; select by ID" : "server not found; run nanosync client connections add");
  return selected[0]!;
}
export function key(root: string, serverId: string, vaultId: string): Uint8Array | null {
  const path = join(dir(root, "keys"), `${serverId}-${vaultId}.json`);
  if (!existsSync(path)) return null;
  const value = JSON.parse(secureRead(path, 1024).toString("utf8")) as VaultKey;
  if (value.serverId !== serverId || value.vaultId !== vaultId || !/^[0-9a-f]{64}$/.test(value.masterKey))
    throw new Error("stored vault key is invalid");
  return Buffer.from(value.masterKey, "hex");
}
function saveKey(root: string, info: ServerRegistration, vaultId: string, master: Uint8Array): void {
  const path = join(dir(root, "keys"), `${info.serverId}-${vaultId}.json`);
  if (existsSync(path)) {
    const current = key(root, info.serverId, vaultId);
    if (!current || !Buffer.from(current).equals(Buffer.from(master))) throw new Error("vault key differs from stored key");
    return;
  }
  secureCreate(path, JSON.stringify({ version: 1, serverId: info.serverId, vaultId, masterKey: Buffer.from(master).toString("hex") }));
}

export interface PendingEnrollment { url: string; token: string; deviceId: string; name: string; alias: string; fingerprint: string; serverId: string; expiresAtMs: number; status?: string }
export function pendingEnrollments(root: string): PendingEnrollment[] {
  return readdirSync(dir(root, "pending")).map(file => {
    if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error("unexpected pending enrollment file");
    const value = JSON.parse(secureRead(join(dir(root, "pending"), file), 4096).toString("utf8")) as PendingEnrollment;
    if (pendingFile(root, value.url) !== join(dir(root, "pending"), file)) throw new Error("invalid pending enrollment URL");
    parseDeviceId(value.deviceId); parseDeviceId(value.serverId); parseAuthToken(value.token); decodeCanonicalBase64Url(value.fingerprint, 32);
    if (!value.name || !value.alias || !Number.isSafeInteger(value.expiresAtMs) || value.status && !["pending", "denied", "expired"].includes(value.status)) throw new Error("invalid pending enrollment");
    return value;
  });
}
function pendingFile(root: string, url: string) { return join(dir(root, "pending"), createHash("sha256").update(baseUrl(url)).digest("hex") + ".json"); }
export function connectionSummary(info: ServerRegistration) {
  return { serverId: info.serverId, alias: info.name, url: info.baseUrl, deviceId: info.deviceId, status: "approved" };
}
export async function enrollServer(root: string, url: string, password: string | undefined, deviceName: string,
  waitMs = 60_000, options: { alias?: string; fresh?: boolean; signal?: AbortSignal; password?: () => Promise<string> } = {}): Promise<Record<string, unknown> & { status: string }> {
  const waitDeadline = waitMs > 0 ? Date.now() + waitMs : Infinity;
  const interrupted = () => new CliError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
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
      if (timeout.signal.aborted) throw new CliError("REQUEST_TIMEOUT", "Server request timed out; retry the same command to resume", 5);
      throw error;
    } finally { clearTimeout(timer); }
  }
  async function pause(ms: number) {
    try { await sleep(ms, undefined, {signal:options.signal}); }
    catch (error) { if (options.signal?.aborted) throw interrupted(); throw error; }
  }
  privateDirectory(root);
  const canonical = baseUrl(url), pendingPath = pendingFile(root, canonical);
  const existing = servers(root).find(item => item.baseUrl === canonical);
  if (existing) {
    if (existsSync(pendingPath)) {
      const saved = JSON.parse(secureRead(pendingPath, 4096).toString("utf8")) as PendingEnrollment;
      if (saved.deviceId !== existing.deviceId || saved.token !== existing.token || saved.serverId !== existing.serverId)
        throw new CliError("CONFLICT", "pending identity differs from saved connection; inspect local state");
      unlinkSync(pendingPath); syncPrivateDirectory(dir(root, "pending"));
    }
    return connectionSummary(existing);
  }
  let pending: PendingEnrollment | undefined = existsSync(pendingPath) ? JSON.parse(secureRead(pendingPath, 4096).toString("utf8")) : undefined;
  if (pending && options.alias && pending.alias !== options.alias) throw new CliError("CONFLICT", "Pending request has a different alias; resume that alias");
  const alias = pending?.alias ?? options.alias ?? deviceName;
  if (!alias.trim() || Buffer.byteLength(alias) > 128 || /[\u0000-\u001f\u007f]/u.test(alias)) throw new CliError("INVALID_INPUT", "invalid connection alias");
  if (servers(root).some(item => item.name === alias) || pendingEnrollments(root).some(item => item.alias === alias && item.url !== canonical))
    throw new CliError("CONFLICT", "connection alias already in use");
  if (options.fresh && pending) {
    // Fresh is deliberate, and only terminal requests can be replaced.
    let status = pending.status ?? (Date.now() >= pending.expiresAtMs ? "expired" : "pending");
    if (status === "pending") {
      try { status = (await bounded(signal => api(canonical, "/v1/auth/enrollments/status", {signal}, pending!.token), Math.min(pending.expiresAtMs, waitDeadline))).status; }
      catch (error) { if (error instanceof RemoteError && error.status === 401) status = "expired"; else throw error; }
    }
    if (!["denied", "expired"].includes(status)) throw new CliError("CONFLICT", "Only denied or expired requests may be replaced with --fresh");
    unlinkSync(pendingPath); syncPrivateDirectory(dir(root, "pending")); pending = undefined;
  }
  if (!pending) {
    if (!deviceName || Buffer.byteLength(deviceName)>128 || /[\u0000-\u001f\u007f]/u.test(deviceName)) throw new CliError("INVALID_INPUT", "invalid device name");
    const secret = password ?? await options.password?.();
    if (!secret) throw new CliError("INPUT_REQUIRED", "owner password required for first enrollment");
    output().progress('Connecting to server…');
    pending = { url: canonical, token: await bounded(signal => login(canonical, secret, signal), waitDeadline), deviceId: randomUUID(), name: deviceName, alias,
      fingerprint: randomBytes(32).toString("base64url"), serverId: randomUUID(), expiresAtMs: Date.now() + 24 * 60 * 60_000 };
    secureCreate(pendingPath, JSON.stringify(pending));
  }
  const request = pending;
  output().info(`nanosync server devices approve --device-id ${request.deviceId}`);
  output().info(`Verification code: ${enrollmentVerificationCode(request.deviceId, request.fingerprint)}`);
  const until = Math.min(request.expiresAtMs, waitMs === 0 ? Date.now() : waitDeadline);
  let delay = 250;
  async function retry<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
    while (true) {
      if (options.signal?.aborted) throw new CliError("INTERRUPTED", "Enrollment interrupted; run the same connections add command to resume", 130);
      if (waitMs !== 0 && Date.now() >= until) return null;
      if (Date.now() >= request.expiresAtMs) return null;
      try { return await bounded(operation, waitMs === 0 ? request.expiresAtMs : until); }
      catch (error) {
        if (options.signal?.aborted) throw new CliError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        if (!(error instanceof TypeError || error instanceof CliError && error.code === "REQUEST_TIMEOUT" || error instanceof RemoteError && (error.status >= 500 || error.status === 429))) throw error;
        if (Date.now() >= until) { output().info("Temporary outage; pending request retained. Retry the same command."); return null; }
        output().info(`Temporary outage; retrying in ${delay}ms (request retained)`);
        await pause(Math.min(delay, Math.max(0, until - Date.now()))); delay = Math.min(5000, delay * 2);
      }
    }
  }
  const caps = await retry(signal => api(canonical, "/v1/capabilities", {signal}));
  if (caps) { const admin = parseCapabilityResponse(caps).webAdministration; if (admin.enabled && admin.url) output().info(`Administration: ${admin.url}`); }
  let status = Date.now() >= request.expiresAtMs ? "expired" : request.status ?? "pending";
  if (status === "pending") {
    try {
      const response = await retry(signal => api(canonical, "/v1/auth/enrollments", { method: "POST", body: JSON.stringify({ protocolVersion: 1,
        deviceId: request.deviceId, displayName: request.name, platform: process.platform, clientVersion: "1", fingerprint: request.fingerprint }), signal }, request.token));
      status = response?.status ?? "pending";
      if (status === "pending") {
        output().info("Waiting for approval; Ctrl-C preserves this request for resume.");
        if (Date.now() < until) output().progress('Waiting for device approval…');
      }
      while (status === "pending" && Date.now() < until) {
        if (options.signal?.aborted) throw new CliError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        await pause(Math.min(1000, until - Date.now()));
        if (options.signal?.aborted) throw new CliError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
        if (Date.now() >= request.expiresAtMs) { status = "expired"; break; }
        status = (await retry(signal => api(canonical, "/v1/auth/enrollments/status", {signal}, request.token)))?.status ?? "pending";
      }
    } catch (error) {
      if (error instanceof RemoteError && error.status === 401) status = "expired";
      else throw error;
    }
  }
  if (status === "pending" && Date.now() >= request.expiresAtMs) status = "expired";
  if (status === "approved") {
    const info: ServerRegistration = { version: 1, serverId: request.serverId, baseUrl: canonical, deviceId: request.deviceId, name: alias, token: request.token };
    const path = join(dir(root, "servers"), `${request.serverId}.json`);
    if (existsSync(path)) {
      if (secureRead(path).toString("utf8") !== JSON.stringify(info)) throw new CliError("CONFLICT", "saved credential differs from pending enrollment");
    } else secureCreate(path, JSON.stringify(info));
    unlinkSync(pendingPath); syncPrivateDirectory(dir(root, "pending"));
    output().info("Approved. Next: nanosync client vaults connect (no files transferred).");
    return connectionSummary(info);
  }
  if (options.signal?.aborted) throw new CliError("INTERRUPTED", "Enrollment interrupted; retry the same command to resume", 130);
  if (status === "denied" || status === "expired") {
    secureReplace(pendingPath, JSON.stringify({...request, status}));
    output().info(`Enrollment ${status}; review with the owner, then explicitly use --fresh for a new identity.`);
  }
  return { status, alias, url: canonical, deviceId: request.deviceId, deviceName: request.name };
}

export async function unlockVault(root: string, info: ServerRegistration, vaultId: string, secret: string): Promise<void> {
  const wrap = await api(info.baseUrl, "/v1/recovery-wrap", { headers: { "x-nanosync-vault-id": vaultId } }, info.token);
  const recovery = await decodeRecoverySecret(secret);
  try {
    const master = await unwrapMasterKey(wrap.recoveryWrap, recovery, vaultId);
    try { saveKey(root, info, vaultId, master); } finally { master.fill(0); }
  } finally { recovery.fill(0); }
}

export { text as prompt } from "./prompts.ts";
export { secretPrompt };
