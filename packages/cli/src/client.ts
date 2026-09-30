import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { openSync, closeSync, readSync, writeSync, createReadStream, createWriteStream, existsSync, unlinkSync } from "node:fs";
import { isatty } from "node:tty";
import { spawnSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { encryptManifest, decryptManifest, generateRecoverySecret, generateVaultMasterKey, displayRecoverySecret, decodeRecoverySecret, wrapMasterKey, unwrapMasterKey, referenceSetMac, verifyReferenceSetMac, type ManifestV1 } from "@nanosync/sync-core";
import { RemoteError } from "@nanosync/sync-core";
import { decodeCanonicalBase64Url, parseAuthToken, parseDeviceId, parseVaultId, parsePrincipalId, parseRevisionId, parseReferenceSetMac, parsePersistedRevisionEnvelope, parseRecoveryWrap, type RecoveryWrapV1, type RevisionEnvelope } from "@nanosync/protocol";
import { privateDirectory, secureCreate, secureInstall, secureRead, syncPrivateDirectory } from "./security.ts";

export interface ClientCredentials { baseUrl: string; vaultId: string; deviceId: string; token: string; masterKey: string }
export function credentials(directory: string): ClientCredentials {
  const value = JSON.parse(secureRead(join(privateDirectory(directory), "client.json")).toString("utf8")) as ClientCredentials;
  if (typeof value.baseUrl !== "string" || !/^https?:\/\//.test(value.baseUrl) || new URL(value.baseUrl).username || new URL(value.baseUrl).password ||
    new URL(value.baseUrl).search || new URL(value.baseUrl).hash || typeof value.masterKey !== "string" || !/^[0-9a-f]{64}$/.test(value.masterKey)) throw new Error("invalid client credentials");
  parseVaultId(value.vaultId); parseDeviceId(value.deviceId); parseAuthToken(value.token);
  return value;
}
export function saveCredentials(directory: string, value: ClientCredentials): void {
  privateDirectory(directory); secureInstall(join(directory, "client.json"), JSON.stringify(value));
}
export function baseUrl(url: string): string {
  const parsed = new URL(url);
  if (!/^(http:|https:)$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("invalid server URL");
  if (parsed.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname))
    throw new Error("HTTP is permitted only for loopback; use HTTPS for remote servers");
  return parsed.href.replace(/\/$/, "");
}
export async function api(url: string, path: string, init: RequestInit = {}, token?: string, bootstrapProof?: string): Promise<any> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (bootstrapProof) headers.set("x-nanosync-bootstrap-authorization", bootstrapProof);
  if (init.body && !headers.has("content-type") && !(init.body instanceof Uint8Array)) headers.set("content-type", "application/json");
  const response = await fetch(`${baseUrl(url)}${path}`, { ...init, headers });
  const result = await response.json() as Record<string, any>;
  if (!response.ok) throw new RemoteError(response.status, String(result.code ?? "ERROR"), `server ${response.status}: ${String(result.code ?? "ERROR")}`);
  return result;
}
export async function secretPrompt(label: string): Promise<string> {
  const fd = openSync("/dev/tty", "r+");
  try {
    if (!isatty(fd)) throw new Error(`${label} requires an interactive terminal`);
    if (spawnSync("stty", ["-echo"], { stdio: [fd, fd, fd] }).status !== 0) throw new Error("cannot disable terminal echo");
    const tty = createInterface({ input: createReadStream("/dev/tty"), output: createWriteStream("/dev/tty"), terminal: false });
    try { return await tty.question(`${label}: `); }
    finally { tty.close(); spawnSync("stty", ["echo"], { stdio: [fd, fd, fd] }); writeSync(fd, "\n"); }
  } finally { closeSync(fd); }
}
export function readPassword(): string {
  const buffer = Buffer.alloc(1026); let length = 0;
  while (length < buffer.length) {
    const count = readSync(0, buffer, length, buffer.length - length, null);
    if (!count) break;
    length += count;
  }
  if (length === buffer.length) throw new Error("password input exceeds limit");
  const password = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, length)).replace(/\r?\n$/, "");
  if (!password || Buffer.byteLength(password) > 1024) throw new Error("password on stdin must be 1..1024 bytes");
  return password;
}
export async function login(url: string, password: string): Promise<string> {
  const result = await api(url, "/v1/auth/password", { method: "POST", body: JSON.stringify({ protocolVersion: 1, password }) });
  return parseAuthToken(result.sessionToken);
}
const fingerprint = () => randomBytes(32).toString("base64url");
export async function enroll(url: string, token: string, deviceId: string, proof?: string, deviceFingerprint = fingerprint()) {
  return api(url, "/v1/auth/enrollments", { method: "POST", body: JSON.stringify({ protocolVersion: 1, deviceId,
    displayName: "nanosync Linux", platform: "linux", clientVersion: "1", fingerprint: deviceFingerprint }) }, token, proof);
}
interface BootstrapCheckpoint {
  version: 1; url: string; vaultId: string; deviceId: string; principalId: string;
  masterKey: string; recoveryWrap: RecoveryWrapV1;
  genesisRevision: RevisionEnvelope; frame: string; uploadKey: string; fingerprint: string;
}
async function verifiedCheckpoint(directory: string, url: string): Promise<BootstrapCheckpoint> {
  const checkpoint = JSON.parse(secureRead(join(directory, "bootstrap.checkpoint"), 16_384).toString("utf8")) as BootstrapCheckpoint;
  const fields = ["version", "url", "vaultId", "deviceId", "principalId", "masterKey", "recoveryWrap", "genesisRevision", "frame", "uploadKey", "fingerprint"];
  if (!checkpoint || typeof checkpoint !== "object" || Object.keys(checkpoint).length !== fields.length ||
      fields.some(field => !Object.hasOwn(checkpoint, field)) || checkpoint.version !== 1 || checkpoint.url !== baseUrl(url) ||
      !/^[0-9a-f]{64}$/.test(checkpoint.masterKey) || !/^[0-9a-f]{64}$/.test(checkpoint.uploadKey)) throw new Error("invalid bootstrap checkpoint");
  parseVaultId(checkpoint.vaultId); parseDeviceId(checkpoint.deviceId); parsePrincipalId(checkpoint.principalId);
  decodeCanonicalBase64Url(checkpoint.fingerprint, 32); parseRecoveryWrap(checkpoint.recoveryWrap);
  const master = Buffer.from(checkpoint.masterKey, "hex");
  const envelope = parsePersistedRevisionEnvelope(checkpoint.genesisRevision), frame = Buffer.from(checkpoint.frame, "base64url");
  if (frame.toString("base64url") !== checkpoint.frame || envelope.vaultId !== checkpoint.vaultId || envelope.creatingDeviceId !== checkpoint.deviceId ||
      envelope.parents.length || envelope.references.length !== 1 || !await verifyReferenceSetMac(envelope, master)) throw new Error("invalid bootstrap genesis checkpoint");
  const manifest = await decryptManifest(frame, envelope, master);
  if (manifest.revisionId !== envelope.revisionId || manifest.entries.length !== 1 || manifest.entries[0]?.kind !== "directory" ||
      manifest.entries[0]?.parentId !== null || manifest.vaultId !== checkpoint.vaultId) throw new Error("invalid bootstrap manifest checkpoint");
  return { ...checkpoint, genesisRevision: envelope };
}
/** Confirmation is called only when no durable checkpoint exists. The CLI passes a TTY-only callback. */
export async function bootstrapWorkflow(directory: string, url: string, proofFile: string, password: string,
  confirmRecovery: (display: string) => Promise<void>): Promise<{ vaultId: string; deviceId: string }> {
  const root = privateDirectory(directory), canonicalUrl = baseUrl(url), checkpointPath = join(root, "bootstrap.checkpoint");
  if (existsSync(join(root, "enrollment.json"))) throw new Error("another enrollment owns this directory");
  const proof = secureRead(proofFile, 64).toString("utf8");
  if (!/^[0-9a-f]{64}$/.test(proof)) throw new Error("invalid bootstrap proof file");
  let checkpoint: BootstrapCheckpoint;
  if (existsSync(checkpointPath)) checkpoint = await verifiedCheckpoint(root, canonicalUrl);
  else {
    if (existsSync(join(root, "client.json"))) throw new Error("client directory already contains credentials");
    if ((await api(canonicalUrl, "/v1/bootstrap/status")).status !== "uninitialized") throw new Error("server already initialized; cannot invent a new vault");
    const vaultId = randomUUID(), principalId = randomUUID(), deviceId = randomUUID(), revisionId = randomUUID();
    const master = generateVaultMasterKey(), recovery = generateRecoverySecret();
    try {
      const recoveryWrap = await wrapMasterKey(master, recovery, vaultId);
      const manifest: ManifestV1 = { version: 1, vaultId, revisionId, parents: [], creatingDeviceId: deviceId,
        entries: [{ id: randomUUID(), parentId: null, name: "", kind: "directory" }] };
      const encrypted = await encryptManifest(manifest, master);
      const unsigned: RevisionEnvelope = { protocolVersion: 1, revisionFormatVersion: 1, vaultId: parseVaultId(vaultId), revisionId: parseRevisionId(revisionId),
        parents: [], creatingDeviceId: parseDeviceId(deviceId), createdAt: new Date().toISOString(), encryptedManifestObjectId: encrypted.reference.objectId,
        references: [encrypted.reference], referenceSetMac: parseReferenceSetMac("0".repeat(64)) };
      const genesisRevision = parsePersistedRevisionEnvelope({ ...unsigned, referenceSetMac: await referenceSetMac(unsigned, master) });
      await confirmRecovery(await displayRecoverySecret(recovery));
      checkpoint = { version: 1, url: canonicalUrl, principalId, vaultId, deviceId, masterKey: Buffer.from(master).toString("hex"),
        recoveryWrap, genesisRevision, frame: Buffer.from(encrypted.frame).toString("base64url"),
        uploadKey: randomBytes(32).toString("hex"), fingerprint: fingerprint() };
      // This fsync includes the directory entry; no server mutation precedes it.
      secureCreate(checkpointPath, JSON.stringify(checkpoint));
    } finally { master.fill(0); recovery.fill(0); }
  }
  const result = { vaultId: checkpoint.vaultId, deviceId: checkpoint.deviceId };
  const credentialPath = join(root, "client.json"), sessionPath = join(root, "bootstrap.session");
  if (existsSync(credentialPath)) {
    const saved = credentials(root);
    if (saved.baseUrl !== canonicalUrl || saved.vaultId !== result.vaultId || saved.deviceId !== result.deviceId || saved.masterKey !== checkpoint.masterKey)
      throw new Error("client credential differs from bootstrap checkpoint");
    if (existsSync(sessionPath) && saved.token !== parseAuthToken(secureRead(sessionPath, 128).toString("utf8")))
      throw new Error("client credential differs from bootstrap session");
    if (existsSync(`${credentialPath}.stage`)) {
      if (secureRead(`${credentialPath}.stage`).toString("utf8") !== JSON.stringify(saved)) throw new Error("unexpected credential stage");
      unlinkSync(`${credentialPath}.stage`); syncPrivateDirectory(root);
    }
    if (existsSync(sessionPath)) { secureRead(sessionPath, 128); unlinkSync(sessionPath); }
    unlinkSync(checkpointPath); syncPrivateDirectory(root);
    return result;
  }
  const status = (await api(canonicalUrl, "/v1/bootstrap/status")).status;
  // The operator proof authorizes completion independently of the password.
  // Only after sealing can normal login verify the supplied password. Failure
  // retains the checkpoint and exact genesis for a retry with the right one.
  const verifiedSession = status === "sealed" ? await login(canonicalUrl, password) : null;
  if (status === "uninitialized") {
    await api(canonicalUrl, "/v1/bootstrap/initialize", { method: "POST", body: JSON.stringify({ protocolVersion: 1,
      principalId: checkpoint.principalId, vaultId: checkpoint.vaultId, initialDeviceId: checkpoint.deviceId,
      password, recoveryWrap: checkpoint.recoveryWrap }) }, undefined, proof);
  } else if (status !== "initializedWithoutHead" && status !== "sealed") throw new Error("unexpected bootstrap lifecycle");
  if (status !== "sealed") {
    const frame = Buffer.from(checkpoint.frame, "base64url"), reference = checkpoint.genesisRevision.references[0]!;
    const upload = await fetch(`${canonicalUrl}/v1/bootstrap/objects/manifest/${reference.objectId}`, { method: "PUT", headers: {
      "x-nanosync-bootstrap-authorization": proof, "content-length": String(frame.length), "x-nanosync-protocol-version": "1",
      "x-nanosync-object-format-version": "1", "x-nanosync-ciphertext-sha256": createHash("sha256").update(frame).digest("hex"), "idempotency-key": checkpoint.uploadKey
    }, body: frame });
    if (!upload.ok) throw new Error(`bootstrap object upload failed (${upload.status}); checkpoint retained`);
    await api(canonicalUrl, "/v1/bootstrap/complete", { method: "POST", body: JSON.stringify({ protocolVersion: 1,
      vaultId: checkpoint.vaultId, genesisRevision: checkpoint.genesisRevision }) }, undefined, proof);
  }
  const token = existsSync(sessionPath) ? parseAuthToken(secureRead(sessionPath, 128).toString("utf8")) : verifiedSession ?? await login(canonicalUrl, password);
  if (!existsSync(sessionPath)) secureCreate(sessionPath, token); // Before first enrollment request.
  const enrollment = await enroll(canonicalUrl, token, checkpoint.deviceId, proof, checkpoint.fingerprint);
  if (enrollment.status !== "approved") throw new Error("initial device approval is pending; checkpoint retained");
  // Credential must be bound to this exact genesis, not just an unrelated sealed server.
  const head = await api(canonicalUrl, "/v1/head", {}, token);
  if (head.revisionId !== checkpoint.genesisRevision.revisionId || head.sequence !== 1) throw new Error("bootstrap genesis differs from checkpoint");
  saveCredentials(root, { baseUrl: canonicalUrl, vaultId: checkpoint.vaultId, deviceId: checkpoint.deviceId, token, masterKey: checkpoint.masterKey });
  unlinkSync(sessionPath); unlinkSync(checkpointPath); syncPrivateDirectory(root);
  return result;
}
export async function bootstrap(directory: string, url: string, proofFile: string): Promise<{ vaultId: string; deviceId: string }> {
  const password = readPassword();
  return bootstrapWorkflow(directory, url, proofFile, password, async display => {
    const terminal = openSync("/dev/tty", "r+");
    try {
      if (!isatty(terminal)) throw new Error("bootstrap requires an interactive terminal");
      writeSync(terminal, `Recovery key (record offline; shown once): ${display}\n`);
    } finally { closeSync(terminal); }
    if (await secretPrompt("Type the recovery key to confirm it was saved") !== display) throw new Error("recovery confirmation failed; server unchanged");
  });
}
export async function joinVault(directory: string, url: string, deviceId: string, password: string | undefined, recoveryDisplay?: string) {
  privateDirectory(directory);
  if (existsSync(join(directory, "client.json"))) throw new Error("client directory already contains credentials");
  const pendingPath = join(directory, "enrollment.json");
  let token: string, deviceFingerprint: string;
  if (existsSync(pendingPath)) {
    const pending = JSON.parse(secureRead(pendingPath).toString("utf8")) as { url: string; deviceId: string; token: string; fingerprint: string };
    if (pending.url !== baseUrl(url) || pending.deviceId !== deviceId) throw new Error("another enrollment is pending in this directory");
    token = parseAuthToken(pending.token); decodeCanonicalBase64Url(pending.fingerprint, 32); deviceFingerprint = pending.fingerprint;
  } else {
    if (password === undefined) throw new Error("password on stdin required for first enrollment request");
    token = await login(url, password);
    deviceFingerprint = fingerprint();
    // A dropped enrollment response can be retried byte-for-byte with the same
    // session and fingerprint; never issue a fresh login for an ambiguous send.
    secureCreate(pendingPath, JSON.stringify({ url: baseUrl(url), deviceId, token, fingerprint: deviceFingerprint }));
  }
  const result = await enroll(url, token, parseDeviceId(deviceId), undefined, deviceFingerprint);
  if (result.status === "pending") return { status: "pending", deviceId };
  const status = await api(url, "/v1/auth/enrollments/status", {}, token);
  if (status.status !== "approved") return { status: status.status, deviceId };
  const wrap = await api(url, "/v1/recovery-wrap", {}, token);
  const display = recoveryDisplay ?? await secretPrompt("Recovery key");
  const recovery = await decodeRecoverySecret(display);
  // Vault ID is not exposed by the wrap route. The authenticated head's revision carries it.
  const head = await api(url, "/v1/head", {}, token);
  const revision = await api(url, `/v1/revisions/${head.revisionId}`, {}, token);
  const vaultId = parseVaultId(revision.revision.vaultId);
  const master = await unwrapMasterKey(wrap.recoveryWrap, recovery, vaultId);
  saveCredentials(directory, { baseUrl: baseUrl(url), vaultId, deviceId, token, masterKey: Buffer.from(master).toString("hex") });
  unlinkSync(pendingPath);
  master.fill(0); recovery.fill(0);
  return { status: "approved", deviceId };
}
