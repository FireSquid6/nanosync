import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readdirSync, unlinkSync, openSync, closeSync, writeSync } from "node:fs";
import { join } from "node:path";
import { isatty } from "node:tty";
import { encryptManifest, generateRecoverySecret, generateVaultMasterKey, displayRecoverySecret, decodeRecoverySecret,
  wrapMasterKey, unwrapMasterKey, referenceSetMac } from "@nanosync/sync-core";
import { parsePersistedRevisionEnvelope, parseRecoveryWrap, parseVaultId, type RevisionEnvelope } from "@nanosync/protocol";
import { api, baseUrl, enroll, login, secretPrompt } from "./client.ts";
import { privateDirectory, secureCreate, secureRead } from "./security.ts";

export interface ServerRegistration { version: 1; serverId: string; baseUrl: string; deviceId: string; name: string; token: string }
interface VaultKey { version: 1; serverId: string; vaultId: string; masterKey: string }
interface VaultCreationCheckpoint { version: 1; serverId: string; name: string; vaultId: string; masterKey: string; secret: string;
  request: { vaultId: string; name: string; recoveryWrap: unknown; genesisRevision: RevisionEnvelope; frame: string } }
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
  if (selected.length !== 1) throw new Error(selected.length ? "server is ambiguous; select by ID" : "server not found; run nanosync enroll");
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

export async function enrollServer(root: string, url: string, password: string | undefined, deviceName: string,
  waitMs = 60_000): Promise<{ status: string; deviceName: string }> {
  privateDirectory(root);
  if (!deviceName || Buffer.byteLength(deviceName)>128 || /[\u0000-\u001f\u007f]/u.test(deviceName)) throw new Error("invalid device name");
  const canonical = baseUrl(url), pendingPath = join(root, "enrollment.json");
  if (servers(root).some(item => item.baseUrl === canonical)) throw new Error("server already registered");
  let pending: { url: string; token: string; deviceId: string; name: string; fingerprint: string; serverId: string };
  if (existsSync(pendingPath)) {
    pending = JSON.parse(secureRead(pendingPath, 2048).toString("utf8"));
    if (pending.url !== canonical || pending.name !== deviceName) throw new Error("another enrollment is pending");
  } else {
    if (!password) throw new Error("password required for first enrollment request");
    pending = { url: canonical, token: await login(canonical, password), deviceId: randomUUID(), name: deviceName,
      fingerprint: randomBytes(32).toString("base64url"), serverId: randomUUID() };
    secureCreate(pendingPath, JSON.stringify(pending));
  }
  const request = () => api(canonical, "/v1/auth/enrollments", { method: "POST", body: JSON.stringify({ protocolVersion: 1,
    deviceId: pending.deviceId, displayName: pending.name, platform: "linux", clientVersion: "1", fingerprint: pending.fingerprint }) }, pending.token);
  let response = await request();
  const until = Date.now() + waitMs;
  if (response.status === "pending" && waitMs) console.error(`Waiting for approval, run \`nanosync approve ${deviceName}\` on the server`);
  while (response.status === "pending" && Date.now() < until) {
    await Bun.sleep(Math.min(1000, until - Date.now()));
    response = await api(canonical, "/v1/auth/enrollments/status", {}, pending.token);
  }
  if (response.status === "approved") {
    const path = join(dir(root, "servers"), `${pending.serverId}.json`);
    secureCreate(path, JSON.stringify({ version: 1, serverId: pending.serverId, baseUrl: canonical,
      deviceId: pending.deviceId, name: deviceName, token: pending.token } satisfies ServerRegistration));
    unlinkSync(pendingPath);
  }
  return { status: response.status, deviceName };
}

/** Returns a recovery secret only to the caller, never to a server or log. */
export async function createVault(root: string, info: ServerRegistration, name: string,
  deliver: (secret: string) => Promise<void>): Promise<{ vaultId: string; name: string }> {
  if (!name || name !== name.trim() || Buffer.byteLength(name)>128) throw new Error("invalid vault name");
  const checkpointPath = join(privateDirectory(root), "vault-creation.json");
  let checkpoint: VaultCreationCheckpoint;
  if (existsSync(checkpointPath)) {
    checkpoint = JSON.parse(secureRead(checkpointPath, 16_384).toString("utf8"));
    if (checkpoint.version !== 1 || checkpoint.serverId !== info.serverId || checkpoint.name !== name ||
        checkpoint.vaultId !== checkpoint.request?.vaultId || checkpoint.name !== checkpoint.request.name ||
        !/^[0-9a-f]{64}$/.test(checkpoint.masterKey) || !/^[a-z2-7-]+$/.test(checkpoint.secret))
      throw new Error("another vault creation is pending; retry its server and name");
    parseVaultId(checkpoint.vaultId);
    parseRecoveryWrap(checkpoint.request.recoveryWrap);
    parsePersistedRevisionEnvelope(checkpoint.request.genesisRevision);
  } else {
    const vaultId = randomUUID(), revisionId = randomUUID(), master = generateVaultMasterKey(), recovery = generateRecoverySecret();
    try {
    const wrap = await wrapMasterKey(master, recovery, vaultId);
    const manifest = { version: 1 as const, vaultId, revisionId, parents: [], creatingDeviceId: info.deviceId,
      entries: [{ id: randomUUID(), parentId: null, name: "", kind: "directory" as const }] };
    const encrypted = await encryptManifest(manifest, master);
    const unsigned = { protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId, parents: [],
      creatingDeviceId: info.deviceId, createdAt: new Date().toISOString(), encryptedManifestObjectId: encrypted.reference.objectId,
      references: [encrypted.reference], referenceSetMac: "0".repeat(64) };
    const genesisRevision: RevisionEnvelope = parsePersistedRevisionEnvelope({ ...unsigned,
      referenceSetMac: await referenceSetMac(parsePersistedRevisionEnvelope(unsigned), master) });
    checkpoint = { version: 1, serverId: info.serverId, name, vaultId, masterKey: Buffer.from(master).toString("hex"),
      secret: await displayRecoverySecret(recovery), request: { vaultId, name, recoveryWrap: wrap,
        genesisRevision, frame: Buffer.from(encrypted.frame).toString("base64url") } };
    secureCreate(checkpointPath, JSON.stringify(checkpoint));
    } finally { master.fill(0); recovery.fill(0); }
  }
  await deliver(checkpoint.secret); // Exact same secret on every retry.
  const master = Buffer.from(checkpoint.masterKey, "hex");
  try { saveKey(root, info, checkpoint.vaultId, master); } finally { master.fill(0); }
  await api(info.baseUrl, "/v1/vaults", { method: "POST", body: JSON.stringify(checkpoint.request) }, info.token);
  unlinkSync(checkpointPath);
  return { vaultId: checkpoint.vaultId, name };
}
export async function unlockVault(root: string, info: ServerRegistration, vaultId: string, secret: string): Promise<void> {
  const wrap = await api(info.baseUrl, "/v1/recovery-wrap", { headers: { "x-nanosync-vault-id": vaultId } }, info.token);
  const recovery = await decodeRecoverySecret(secret);
  try {
    const master = await unwrapMasterKey(wrap.recoveryWrap, recovery, vaultId);
    try { saveKey(root, info, vaultId, master); } finally { master.fill(0); }
  } finally { recovery.fill(0); }
}

export async function prompt(label: string): Promise<string> {
  const fd = openSync("/dev/tty", "r+");
  try { if (!isatty(fd)) throw new Error(`${label} requires a usable terminal`); writeSync(fd, `${label}: `); }
  finally { closeSync(fd); }
  const value = await import("node:readline/promises");
  const input = await import("node:fs");
  const io = value.createInterface({ input: input.createReadStream("/dev/tty"), output: input.createWriteStream("/dev/tty") });
  try { return await io.question(""); } finally { io.close(); }
}
export { secretPrompt };
