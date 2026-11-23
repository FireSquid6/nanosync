import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { parseDeviceId, parseVaultId } from "@nanosync/protocol";
import { baseUrl } from "./url.ts";
import { inspectSyncOwner } from "./sync-lock.ts";
import { storeId, assertNotRemoving } from "./credential-state.ts";
import { privateDirectory, secureRead, secureCreate, secureReplace, syncPrivateDirectory } from "./security.ts";
import { records, withConnectionRegistry } from "./connections.ts";
import { CredentialStoreError, defaultCredentialStore, type CredentialStore } from "./credential-store.ts";

export interface ServerRegistration { version: 1; serverId: string; baseUrl: string; deviceId: string; name: string; token: string }
export interface ServerMetadata { serverId: string; baseUrl: string; deviceId: string; name: string; credentialMode: "protected-file" | "os"; migrationPending?: boolean }
type OsRegistration = Omit<ServerRegistration, "version" | "token"> & { version: 2; credentialMode: "os" };
type Registration = ServerRegistration | OsRegistration;
interface VaultKey { version: 1; serverId: string; vaultId: string; masterKey: string }
interface Secrets { version: 1; serverId: string; token: string; keys: Record<string, string> }
const dir = (root: string, leaf: string) => privateDirectory(join(privateDirectory(root), leaf));
const registrationPath = (root: string, id: string) => join(dir(root, "servers"), `${parseVaultId(id)}.json`);
const journalPath = (root: string, id: string) => join(dir(root, "credential-migrations"), `${parseVaultId(id)}.json`);

function registrations(root: string): Registration[] {
  const path = dir(root, "servers");
  return readdirSync(path).map(file => {
    if (!/^[0-9a-f-]{36}\.json$/.test(file)) throw new Error("unexpected server state file");
    const value = JSON.parse(secureRead(join(path, file), 2048).toString("utf8")) as Registration;
    if (!value || value.serverId !== file.slice(0, -5) || typeof value.name !== "string" || baseUrl(value.baseUrl) !== value.baseUrl)
      throw new Error("invalid server registration");
    if (value.version === 1 && typeof value.token === "string") return value;
    if (value.version !== 2 || value.credentialMode !== "os" || Object.keys(value).sort().join() !== "baseUrl,credentialMode,deviceId,name,serverId,version")
      throw new Error("invalid server registration");
    parseDeviceId(value.deviceId); parseVaultId(value.serverId);
    return value;
  });
}
function selected(root: string, choice?: string): Registration {
  const list = registrations(root);
  const matches = choice ? list.filter(item => item.serverId === choice || item.name === choice || item.baseUrl === choice) : list;
  if (matches.length !== 1) throw new Error(matches.length ? "server is ambiguous; select by ID" : "server not found; run nanosync client connections add");
  return matches[0]!;
}
export function listServerMetadata(root: string): ServerMetadata[] {
  return registrations(root).map(info => ({ serverId: info.serverId, baseUrl: info.baseUrl, deviceId: info.deviceId, name: info.name,
    credentialMode: info.version === 1 ? "protected-file" : "os",
    ...(existsSync(journalPath(root, info.serverId)) ? { migrationPending: true } : {}) }));
}
function assertReady(root: string, id: string): void {
  assertNotRemoving(root, id);
  if (existsSync(journalPath(root, id))) throw new Error("credential migration incomplete; retry migrateCredentials for this server");
}
function readSecrets(root: string, id: string, store: CredentialStore): Secrets {
  const text = store.get(storeId(root, id));
  if (!text) throw new CredentialStoreError();
  try {
    const value = JSON.parse(text) as Secrets;
    if (value.version !== 1 || value.serverId !== id || typeof value.token !== "string" || !value.token ||
        !value.keys || typeof value.keys !== "object" || Array.isArray(value.keys) || Object.keys(value).sort().join() !== "keys,serverId,token,version") throw new Error();
    for (const [vault, master] of Object.entries(value.keys)) {
      parseVaultId(vault);
      if (typeof master !== "string" || !/^[0-9a-f]{64}$/.test(master)) throw new Error();
    }
    return value;
  } catch { throw new CredentialStoreError(); }
}
function writeSecrets(root: string, id: string, value: Secrets, store: CredentialStore): void {
  const text = JSON.stringify(value);
  store.set(storeId(root, id), text);
  if (store.get(storeId(root, id)) !== text) throw new CredentialStoreError();
}
function resolveRegistration(root: string, info: Registration, store: CredentialStore): ServerRegistration {
  assertReady(root, info.serverId);
  if (info.version === 1) return info;
  const { credentialMode: _, ...metadata } = info;
  return { ...metadata, version: 1, token: readSecrets(root, info.serverId, store).token };
}
export function server(root: string, choice?: string, store: CredentialStore = defaultCredentialStore): ServerRegistration {
  return resolveRegistration(root, selected(root, choice), store);
}
export function servers(root: string, store: CredentialStore = defaultCredentialStore): ServerRegistration[] {
  return registrations(root).map(info => resolveRegistration(root, info, store));
}
function fileKey(root: string, serverId: string, vaultId: string): Uint8Array | null {
  const path = join(dir(root, "keys"), `${parseVaultId(serverId)}-${parseVaultId(vaultId)}.json`);
  if (!existsSync(path)) return null;
  const value = JSON.parse(secureRead(path, 1024).toString("utf8")) as VaultKey;
  if (value.serverId !== serverId || value.vaultId !== vaultId || !/^[0-9a-f]{64}$/.test(value.masterKey)) throw new Error("stored vault key is invalid");
  return Buffer.from(value.masterKey, "hex");
}
export function key(root: string, serverId: string, vaultId: string, store: CredentialStore = defaultCredentialStore): Uint8Array | null {
  parseVaultId(vaultId); assertReady(root, serverId);
  // Legacy callers may inspect a key before a server registration exists.
  const info = registrations(root).find(info => info.serverId === serverId);
  if (!info || info.version === 1) return fileKey(root, serverId, vaultId);
  const value = readSecrets(root, serverId, store).keys[vaultId];
  return value ? Buffer.from(value, "hex") : null;
}
export function saveKey(root: string, info: ServerRegistration, vaultId: string, master: Uint8Array, store: CredentialStore = defaultCredentialStore): void {
  parseVaultId(vaultId);
  if (master.length !== 32) throw new Error("invalid vault key");
  withConnectionRegistry(root, () => {
    assertReady(root, info.serverId);
    const current = key(root, info.serverId, vaultId, store);
    if (current) {
      if (!Buffer.from(current).equals(Buffer.from(master))) throw new Error("vault key differs from stored key");
      return;
    }
    const saved = selected(root, info.serverId);
    const hex = Buffer.from(master).toString("hex");
    if (saved.version === 2) {
      const secrets = readSecrets(root, info.serverId, store); secrets.keys[vaultId] = hex;
      writeSecrets(root, info.serverId, secrets, store);
    } else secureCreate(join(dir(root, "keys"), `${info.serverId}-${vaultId}.json`), JSON.stringify({ version: 1, serverId: info.serverId, vaultId, masterKey: hex }));
  });
}
function fileKeys(root: string, id: string): string[] {
  return readdirSync(dir(root, "keys")).filter(name => name.startsWith(`${id}-`)).map(name => {
    const vault = name.slice(id.length + 1, -5);
    if (name !== `${id}-${parseVaultId(vault)}.json`) throw new Error("unexpected vault key file");
    return vault;
  });
}
/** A durable journal blocks credential use until verification, metadata commit and cleanup all finish. */
export function migrateCredentials(root: string, serverId: string, store: CredentialStore = defaultCredentialStore): void {
  withConnectionRegistry(root, () => {
    const info = selected(root, serverId), id = info.serverId;
    assertNotRemoving(root, id);
    for (const binding of records(root).filter(binding => binding.serverId === id)) {
      if (inspectSyncOwner(join(root, "replicas", binding.connectionId))) throw new Error("active sync owner; stop synchronization before migrating credentials");
    }
    const journal = journalPath(root, id);
    parseDeviceId(info.deviceId);
    if (info.version === 1 && !info.token) throw new Error("invalid server registration");
    const pending = join(privateDirectory(root), "pending");
    if (existsSync(pending)) {
      privateDirectory(pending);
      for (const name of readdirSync(pending)) {
        const value = JSON.parse(secureRead(join(pending, name)).toString("utf8"));
        if (value.serverId === id || info.version === 1 && value.token === info.token)
          throw new Error("pending enrollment retains this credential; resume enrollment before migrating");
      }
    }
    const vaults = fileKeys(root, id);
    if (existsSync(journal)) {
      if (secureRead(journal).toString() !== JSON.stringify({ version: 1, serverId: id })) throw new Error("invalid credential migration journal");
    } else secureCreate(journal, JSON.stringify({ version: 1, serverId: id }));
    let secrets: Secrets;
    if (info.version === 1) {
      secrets = { version: 1, serverId: id, token: info.token, keys: {} };
      for (const vault of vaults) secrets.keys[vault] = Buffer.from(fileKey(root, id, vault)!).toString("hex");
      const existing = store.get(storeId(root, id));
      if (existing !== null && existing !== JSON.stringify(secrets)) throw new Error("OS credentials differ; inspect credential migration state");
      writeSecrets(root, id, secrets, store);
      const metadata: OsRegistration = { version: 2, serverId: id, baseUrl: info.baseUrl, deviceId: info.deviceId, name: info.name, credentialMode: "os" };
      secureReplace(registrationPath(root, id), JSON.stringify(metadata));
    } else secrets = readSecrets(root, id, store);
    // On replay, never delete an unverified or differing leftover key.
    for (const vault of vaults) {
      if (secrets.keys[vault] !== Buffer.from(fileKey(root, id, vault)!).toString("hex")) throw new Error("file and OS keys differ; inspect credential migration state");
    }
    for (const vault of vaults) unlinkSync(join(dir(root, "keys"), `${id}-${vault}.json`));
    syncPrivateDirectory(dir(root, "keys"));
    unlinkSync(journal); syncPrivateDirectory(dir(root, "credential-migrations"));
  });
}
export function connectionSummary(info: Pick<ServerRegistration, "serverId" | "name" | "baseUrl" | "deviceId">) {
  return { serverId: info.serverId, alias: info.name, url: info.baseUrl, deviceId: info.deviceId, status: "approved" };
}
export type { CredentialStore } from "./credential-store.ts";
