import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { key, listServerMetadata, migrateCredentials, saveKey, server } from "../src/credentials.ts";
import { privateDirectory, secureCreate, secureReplace } from "../src/security.ts";
import { CredentialStoreError, type CredentialStore } from "../src/credential-store.ts";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'credentials-')); roots.push(root);
  const info = { version: 1 as const, serverId: randomUUID(), deviceId: randomUUID(), name: 'home', baseUrl: 'https://example.com', token: 'private-token' };
  secureCreate(join(privateDirectory(join(root, 'servers')), `${info.serverId}.json`), JSON.stringify(info));
  const vaultId = randomUUID(), master = new Uint8Array(32).fill(42);
  saveKey(root, info, vaultId, master);
  const values = new Map<string, string>();
  const store: CredentialStore = { get: id => values.get(id) ?? null, set: (id, value) => { values.set(id, value); }, delete: id => { values.delete(id); } };
  return { root, info, vaultId, master, values, store };
}
test('file mode stays compatible; metadata has no credentials', () => {
  const { root, info, vaultId, master } = fixture();
  expect(server(root, info.serverId)).toEqual(info);
  expect(key(root, info.serverId, vaultId)).toEqual(master);
  expect(listServerMetadata(root)).toEqual([{ serverId: info.serverId, baseUrl: info.baseUrl, deviceId: info.deviceId, name: info.name, credentialMode: 'protected-file' }]);
});
test('migration verifies OS storage, removes file secrets, and supports later key writes', () => {
  const { root, info, vaultId, master, store, values } = fixture();
  migrateCredentials(root, info.serverId, store);
  expect(server(root, info.serverId, store).token).toBe(info.token);
  expect(key(root, info.serverId, vaultId, store)).toEqual(master);
  expect(existsSync(join(root, 'keys', `${info.serverId}-${vaultId}.json`))).toBe(false);
  expect(readFileSync(join(root, 'servers', `${info.serverId}.json`), 'utf8')).not.toContain(info.token);
  const second = randomUUID(); saveKey(root, info, second, master, store);
  expect(key(root, info.serverId, second, store)).toEqual(master);
  expect(values.size).toBe(1);
  migrateCredentials(root, info.serverId, store);
  expect(values.size).toBe(1);
});
test('metadata never contacts locked store; credentials fail without plaintext fallback', () => {
  const { root, info, store } = fixture(); migrateCredentials(root, info.serverId, store);
  const locked: CredentialStore = { get() { throw new CredentialStoreError(); }, set() { throw new CredentialStoreError(); }, delete() { throw new CredentialStoreError(); } };
  expect(listServerMetadata(root)[0]?.credentialMode).toBe('os');
  expect(() => server(root, info.serverId, locked)).toThrow(CredentialStoreError);
});
test('failed verification leaves migration fail-closed and retryable', () => {
  const { root, info, vaultId, master, store } = fixture();
  const broken: CredentialStore = { ...store, set() {} };
  expect(() => migrateCredentials(root, info.serverId, broken)).toThrow();
  expect(() => server(root, info.serverId, store)).toThrow('migration');
  migrateCredentials(root, info.serverId, store);
  expect(key(root, info.serverId, vaultId, store)).toEqual(master);
});
test('post-commit interrupted cleanup blocks use, verifies leftovers and resumes', () => {
  const { root, info, vaultId, master, store } = fixture();
  const path = join(root, 'keys', `${info.serverId}-${vaultId}.json`);
  const original = readFileSync(path, 'utf8');
  let reads = 0;
  const interrupted: CredentialStore = { ...store, get(id) {
    const value = store.get(id);
    if (++reads === 2) secureReplace(path, JSON.stringify({ version: 1, serverId: info.serverId, vaultId, masterKey: 'ff'.repeat(32) }));
    return value;
  } };
  expect(() => migrateCredentials(root, info.serverId, interrupted)).toThrow('keys differ');
  expect(listServerMetadata(root)[0]?.credentialMode).toBe('os');
  expect(listServerMetadata(root)[0]?.migrationPending).toBe(true);
  expect(() => key(root, info.serverId, vaultId, store)).toThrow('migration');
  expect(existsSync(path)).toBe(true);
  secureReplace(path, original);
  migrateCredentials(root, info.serverId, store);
  expect(key(root, info.serverId, vaultId, store)).toEqual(master);
  expect(listServerMetadata(root)[0]?.migrationPending).toBeUndefined();
  expect(existsSync(path)).toBe(false);
});
test('migration refuses a pending enrollment that still duplicates the token', () => {
  const { root, info, store } = fixture();
  secureCreate(join(privateDirectory(join(root, 'pending')), 'pending.json'), JSON.stringify({ serverId: info.serverId, token: info.token }));
  expect(() => migrateCredentials(root, info.serverId, store)).toThrow('pending enrollment');
  expect(server(root, info.serverId)).toEqual(info);
});
test('CLI recovery unlock writes to the shared OS mode with the same error class identity', async () => {
  const { root, info, master, store } = fixture();
  const { unlockVault } = await import('../../cli/src/vault-client.ts');
  const { CliError } = await import('../../cli/src/prompts.ts');
  const { CliError: SharedError } = await import('../src/errors.ts');
  expect(CliError).toBe(SharedError);
  const { generateRecoverySecret, displayRecoverySecret, wrapMasterKey } = await import('@nanosync/sync-core');
  const recovery = generateRecoverySecret(), vaultId = randomUUID();
  const recoveryWrap = await wrapMasterKey(master, recovery, vaultId);
  const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) {
    expect(request.headers.get('authorization')).toBe(`Bearer ${info.token}`);
    return Response.json({ recoveryWrap });
  } });
  try {
    info.baseUrl = `http://127.0.0.1:${remote.port}`;
    secureReplace(join(root, 'servers', `${info.serverId}.json`), JSON.stringify(info));
    migrateCredentials(root, info.serverId, store);
    await unlockVault(root, server(root, info.serverId, store), vaultId, await displayRecoverySecret(recovery), store);
    expect(key(root, info.serverId, vaultId, store)).toEqual(master);
    expect(existsSync(join(root, 'keys', `${info.serverId}-${vaultId}.json`))).toBe(false);
  } finally { remote.stop(true); recovery.fill(0); }
});
test('migration refuses active affected owners before touching credential files or the store', async () => {
  const { root, info, vaultId, store, values } = fixture();
  const { createConnection } = await import('../src/connections.ts');
  const { acquireSyncLock } = await import('../src/sync-lock.ts');
  // Sync roots must not overlap private state.
  const outside = mkdtempSync(join(tmpdir(), 'migration-files-')); roots.push(outside);
  createConnection(root, outside, info.serverId, vaultId, info.deviceId);
  const second = mkdtempSync(join(tmpdir(), 'migration-files-')); roots.push(second);
  const binding = createConnection(root, second, info.serverId, randomUUID(), info.deviceId);
  const replica = privateDirectory(join(privateDirectory(join(root, 'replicas')), binding.connectionId));
  const release = acquireSyncLock(replica);
  const before = readFileSync(join(root, 'servers', `${info.serverId}.json`), 'utf8');
  try {
    expect(() => migrateCredentials(root, info.serverId, store)).toThrow('active sync owner');
    expect(readFileSync(join(root, 'servers', `${info.serverId}.json`), 'utf8')).toBe(before);
    expect(existsSync(join(root, 'credential-migrations', `${info.serverId}.json`))).toBe(false);
    expect(values.size).toBe(0);
    expect(key(root, info.serverId, vaultId)).toHaveLength(32);
  } finally { release(); }
});
test('OS server removal deletes the entire store item after detaching bindings', async () => {
  const { root, info, vaultId, store, values } = fixture();
  const { createConnection, removeServerConnection, records } = await import('../src/connections.ts');
  const outside = mkdtempSync(join(tmpdir(), 'remove-files-')); roots.push(outside);
  createConnection(root, outside, info.serverId, vaultId, info.deviceId);
  migrateCredentials(root, info.serverId, store);
  expect(() => removeServerConnection(root, info.serverId, false, store)).toThrow('Vaults remain attached');
  expect(values.size).toBe(1);
  removeServerConnection(root, info.serverId, true, store);
  expect(values.size).toBe(0);
  expect(records(root)).toEqual([]);
  expect(listServerMetadata(root)).toEqual([]);
  expect(existsSync(join(outside, '.nanosync'))).toBe(false);
});
test('locked store removal and active-owner removal preserve metadata, bindings and credentials', async () => {
  const { root, info, vaultId, store, values } = fixture();
  const { createConnection, removeServerConnection, records } = await import('../src/connections.ts');
  const { acquireSyncLock } = await import('../src/sync-lock.ts');
  const outside = mkdtempSync(join(tmpdir(), 'remove-files-')); roots.push(outside);
  const binding = createConnection(root, outside, info.serverId, vaultId, info.deviceId);
  migrateCredentials(root, info.serverId, store);
  const locked: CredentialStore = { ...store, get() { throw new CredentialStoreError(); } };
  expect(() => removeServerConnection(root, info.serverId, true, locked)).toThrow(CredentialStoreError);
  expect(records(root)).toEqual([binding]);
  expect(server(root, info.serverId, store).token).toBe(info.token);
  expect(existsSync(join(outside, '.nanosync'))).toBe(true);
  expect(values.size).toBe(1);
  const replica = privateDirectory(join(privateDirectory(join(root, 'replicas')), binding.connectionId));
  const release = acquireSyncLock(replica);
  try {
    expect(() => removeServerConnection(root, info.serverId, true, store)).toThrow('live process');
    expect(records(root)).toEqual([binding]);
    expect(existsSync(join(root, 'credential-removals', `${info.serverId}.json`))).toBe(false);
    expect(values.size).toBe(1);
  } finally { release(); }
});
test('failed OS deletion is blocked and retryable, including interruption after actual deletion', async () => {
  for (const afterDelete of [false, true]) {
    const { root, info, vaultId, store, values } = fixture();
    const { createConnection, connectRegisteredVault, removeServerConnection, records } = await import('../src/connections.ts');
    const outside = mkdtempSync(join(tmpdir(), 'remove-files-')); roots.push(outside);
    createConnection(root, outside, info.serverId, vaultId, info.deviceId);
    migrateCredentials(root, info.serverId, store);
    const broken: CredentialStore = { ...store, delete(id) {
      expect(records(root)).toEqual([]);
      if (afterDelete) store.delete(id);
      throw new CredentialStoreError();
    } };
    expect(() => removeServerConnection(root, info.serverId, true, broken)).toThrow(CredentialStoreError);
    expect(listServerMetadata(root)).toHaveLength(1);
    expect(() => server(root, info.serverId, store)).toThrow('removal incomplete');
    expect(() => key(root, info.serverId, vaultId, store)).toThrow('removal incomplete');
    expect(() => migrateCredentials(root, info.serverId, store)).toThrow('removal incomplete');
    expect(() => connectRegisteredVault(root, outside, info.serverId, vaultId, info.deviceId)).toThrow('removal incomplete');
    removeServerConnection(root, info.serverId, true, store);
    expect(listServerMetadata(root)).toEqual([]);
    expect(values.size).toBe(0);
  }
});
test('a no-op OS delete never reports removal success', async () => {
  const { root, info, store } = fixture();
  const { removeServerConnection } = await import('../src/connections.ts');
  migrateCredentials(root, info.serverId, store);
  expect(() => removeServerConnection(root, info.serverId, true, { ...store, delete() {} })).toThrow(CredentialStoreError);
  expect(listServerMetadata(root)).toHaveLength(1);
  expect(() => server(root, info.serverId, store)).toThrow('removal incomplete');
  removeServerConnection(root, info.serverId, true, store);
});
test('interrupted binding cleanup resumes when its marker was already removed', async () => {
  const { root, info, vaultId, store, values } = fixture();
  const { createConnection, removeServerConnection, records } = await import('../src/connections.ts');
  const { unlinkSync } = await import('node:fs');
  const outside = mkdtempSync(join(tmpdir(), 'remove-files-')); roots.push(outside);
  createConnection(root, outside, info.serverId, vaultId, info.deviceId);
  migrateCredentials(root, info.serverId, store);
  let interrupted = false;
  const fault: CredentialStore = { ...store, get(id) {
    if (!interrupted) { interrupted = true; unlinkSync(join(outside, '.nanosync')); }
    return store.get(id);
  } };
  expect(() => removeServerConnection(root, info.serverId, true, fault)).toThrow();
  expect(records(root)).toHaveLength(1);
  expect(values.size).toBe(1);
  expect(() => server(root, info.serverId, store)).toThrow('removal incomplete');
  removeServerConnection(root, info.serverId, true, store);
  expect(records(root)).toEqual([]);
  expect(values.size).toBe(0);
});
test('enrollment metadata and alias checks never resolve unrelated OS tokens', async () => {
  const { root, info, store } = fixture();
  const other = { ...info, serverId: randomUUID(), name: 'os-server', baseUrl: 'https://other.example' };
  secureCreate(join(root, 'servers', `${other.serverId}.json`), JSON.stringify(other));
  migrateCredentials(root, other.serverId, store);
  const { defaultCredentialStore } = await import('../src/credential-store.ts');
  const { enrollServer } = await import('../../cli/src/vault-client.ts');
  const original = defaultCredentialStore.get;
  let reads = 0;
  defaultCredentialStore.get = () => { reads++; throw new CredentialStoreError(); };
  try {
    expect(await enrollServer(root, info.baseUrl, undefined, 'desktop')).toMatchObject({ serverId: info.serverId });
    expect(await enrollServer(root, other.baseUrl, undefined, 'desktop')).toMatchObject({ serverId: other.serverId });
    await expect(enrollServer(root, 'https://new.example', undefined, 'new-alias')).rejects.toThrow('owner password required');
    expect(reads).toBe(0);
  } finally { defaultCredentialStore.get = original; }
});
