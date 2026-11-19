import type { SyncObservation } from '../src/status.ts';
import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { readSettings, setPaused } from '../src/settings.ts';
import { credentialStatus } from '../src/credentials.ts';
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function root() { const path = mkdtempSync(join(tmpdir(), 'nanosync-status-')); roots.push(path); return path; }
test('global resume preserves independent durable folder pause and settings alone do not select credentials', () => {
  const directory = root(), binding = randomUUID();
  expect(readSettings(directory).revision).toBe(0);
  setPaused(directory, { binding }, true);
  setPaused(directory, { all: true }, true);
  setPaused(directory, { all: true }, false);
  expect(readSettings(directory)).toEqual({ version: 1, revision: 3, globalPaused: false, bindingPaused: { [binding]: true } });
  expect(credentialStatus(directory).mode).toBe('uninitialized');
  expect(() => setPaused(directory, { all: true }, true, 0)).toThrow(/changed/);
  expect(readSettings(directory).bindingPaused[binding]).toBe(true);
});

test('new bindings retain filesystem identity and reject copied marker replacement', async () => {
  const { createConnection, assertBindingRoot } = await import('../src/connections.ts');
  const { mkdirSync, renameSync, copyFileSync } = await import('node:fs');
  const directory = root(), data = join(directory, 'data'), state = join(directory, 'state');
  mkdirSync(data, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const binding = createConnection(state, data, randomUUID(), randomUUID(), randomUUID());
  assertBindingRoot(state, binding);
  renameSync(data, data + '-old'); mkdirSync(data, { mode: 0o700 });
  copyFileSync(join(data + '-old', '.nanosync'), join(data, '.nanosync'));
  expect(() => assertBindingRoot(state, binding)).toThrow(/identity/);
});

test('a validated interrupted settings stage neither selects credential mode nor overrides committed pause', async () => {
  const { secureCreate } = await import('../src/security.ts');
  const directory = root();
  const stage = join(directory, `settings.json.${'a'.repeat(32)}.stage`);
  secureCreate(stage, JSON.stringify({ version: 1, revision: 1, globalPaused: true, bindingPaused: {} }));
  expect(credentialStatus(directory).mode).toBe('uninitialized');
  expect(readSettings(directory).globalPaused).toBe(false);
  secureCreate(join(directory, `settings.json.${'b'.repeat(32)}.stage`), '');
  expect(credentialStatus(directory).mode).toBe('uninitialized');
  setPaused(directory, { all: true }, false);
  expect(readSettings(directory)).toMatchObject({ revision: 1, globalPaused: false });
  expect(() => setPaused(directory, { all: true, binding: randomUUID() } as never, true)).toThrow(/exactly one/);
});

test('passive status of a never-started binding creates no journal and selects missing saved roots', async () => {
  const { createConnection } = await import('../src/connections.ts');
  const { clientStatus } = await import('../src/status.ts');
  const { mkdirSync, readdirSync, renameSync } = await import('node:fs');
  const directory = root(), data = join(directory, 'data'), state = join(directory, 'state');
  mkdirSync(data, { mode: 0o700 }); mkdirSync(state, { mode: 0o700 });
  const binding = createConnection(state, data, randomUUID(), randomUUID(), randomUUID());
  const replica = join(state, 'replicas', binding.connectionId), before = readdirSync(replica);
  expect(clientStatus(state).bindings[0]).toMatchObject({ phase: 'not-started', upToDate: false, facts: null });
  expect(readdirSync(replica)).toEqual(before);
  renameSync(data, data + '-gone');
  expect(clientStatus(state, data).bindings[0]).toMatchObject({ phase: 'folder-unavailable', facts: null });
  expect(readdirSync(replica)).toEqual(before);
});

test.each(['connect', 'copy'] as const)('%s flushes the root identity ancestry before binding publication', async operation => {
  const fs = await import('node:fs');
  const { spyOn } = await import('bun:test');
  const { createConnection, repairConnection } = await import('../src/connections.ts');
  const base = root(), state = join(base, 'state'), data = join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  if (operation === 'copy') {
    const source = join(base, 'source'); fs.mkdirSync(source, { mode: 0o700 });
    createConnection(state, source, randomUUID(), randomUUID(), randomUUID());
    fs.copyFileSync(join(source, '.nanosync'), join(data, '.nanosync'));
  }
  const synced: string[] = [], native = fs.fsyncSync;
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    synced.push(fs.readlinkSync(`/proc/self/fd/${fd}`)); native(fd);
  });
  try {
    const binding = operation === 'connect'
      ? createConnection(state, data, randomUUID(), randomUUID(), randomUUID())
      : repairConnection(state, data, 'copy', true);
    const replica = join(state, 'replicas', binding.connectionId);
    const identity = synced.indexOf(join(replica, 'root-identity.json'));
    const ancestors = [replica, join(state, 'replicas'), state, base];
    let previous = identity;
    expect(identity).toBeGreaterThanOrEqual(0);
    for (const ancestor of ancestors) {
      const next = synced.indexOf(ancestor, previous + 1);
      expect(next).toBeGreaterThan(previous); previous = next;
    }
    const record = synced.indexOf(join(state, 'connections', `${binding.connectionId}.json`));
    expect(record).toBeGreaterThan(previous);
    const marker = synced.findIndex(path => path === join(data, '.nanosync') || path.startsWith(join(data, '.nanosync.')));
    expect(marker).toBeGreaterThan(record);
  } finally { flush.mockRestore(); }
});

test.each([
  ['connect', 'replicas'], ['connect', 'state'], ['connect', 'parent'],
  ['copy', 'replicas'], ['copy', 'state'], ['copy', 'parent'],
] as const)('%s with failed %s ancestry flush leaves binding publication unchanged', async (operation, failure) => {
  const fs = await import('node:fs');
  const { spyOn } = await import('bun:test');
  const { createConnection, repairConnection } = await import('../src/connections.ts');
  const base = root(), state = join(base, 'state'), data = join(base, 'data');
  fs.mkdirSync(data, { mode: 0o700 }); fs.mkdirSync(state, { mode: 0o700 });
  if (operation === 'copy') {
    const source = join(base, 'source'); fs.mkdirSync(source, { mode: 0o700 });
    createConnection(state, source, randomUUID(), randomUUID(), randomUUID());
    fs.copyFileSync(join(source, '.nanosync'), join(data, '.nanosync'));
  }
  const before = fs.existsSync(join(state, 'connections')) ? fs.readdirSync(join(state, 'connections')) : [];
  const marker = fs.existsSync(join(data, '.nanosync')) ? fs.readFileSync(join(data, '.nanosync'), 'utf8') : null;
  const target = failure === 'replicas' ? join(state, 'replicas') : failure === 'state' ? state : base;
  const native = fs.fsyncSync;
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(fd => {
    if (fs.readlinkSync(`/proc/self/fd/${fd}`) === target) throw new Error('controlled ancestry flush failure');
    native(fd);
  });
  try {
    expect(() => operation === 'connect'
      ? createConnection(state, data, randomUUID(), randomUUID(), randomUUID())
      : repairConnection(state, data, 'copy', true)).toThrow(/flush failure/);
    if (marker === null) expect(fs.existsSync(join(data, '.nanosync'))).toBe(false);
    else expect(fs.readFileSync(join(data, '.nanosync'), 'utf8')).toBe(marker);
    expect(fs.readdirSync(join(state, 'connections'))).toEqual(before);
  } finally { flush.mockRestore(); }
});

test('malformed settings and observations never echo JSON snippets or native errors', async () => {
  const { secureCreate } = await import('../src/security.ts');
  const { readObservation } = await import('../src/status.ts');
  const directory = root(), sentinel = 'secret-json-sentinel';
  secureCreate(join(directory, 'settings.json'), `{"${sentinel}":`);
  secureCreate(join(directory, 'status.json'), `{"${sentinel}":`);
  for (const read of [() => readSettings(directory), () => readObservation(directory)]) {
    try { read(); throw new Error('expected read failure'); }
    catch (error) {
      expect(error).toMatchObject({ exitCode: 2 });
      expect(String(error)).not.toContain(sentinel);
      expect(String(error)).not.toContain('JSON Parse');
    }
  }
});

test('saved observation validates owner, lock, and every nested facts shape', async () => {
  const { secureCreate, secureReplace } = await import('../src/security.ts');
  const { readObservation } = await import('../src/status.ts');
  const { ClientLocal } = await import('@nanosync/client-local');
  const directory = root(), local = new ClientLocal(directory, randomUUID(), randomUUID());
  const facts = local.statusFacts(); local.close();
  const valid: SyncObservation = { version: 1, observedAt: 100, phase: 'idle', owner: null, lock: null,
    progress: { upload: { count: 0, bytes: 0 }, download: { count: 0, bytes: 0 } },
    facts, enginePhase: null, verified: false, lastRemoteCheck: null, lastSuccess: null,
    error: null, attentionError: null, statusIssues: [] };
  const path = join(directory, 'status.json');
  secureCreate(path, JSON.stringify(valid));
  expect(readObservation(directory)).toEqual(valid);
  const invalid = [
    { owner: false }, { owner: { origin: 'desktop', instanceId: 'bad-id-secret' } },
    { lock: false }, { lock: { owner: { pid: process.pid, starttime: '1' }, inode: { dev: 1 }, live: true } },
    { lock: { owner: { pid: -1, starttime: '1' }, inode: { dev: 1, ino: 1 }, live: true } },
    { facts: false }, { facts: { ...facts, pending: { ...facts.pending, transfers: 'secret-count' } } },
    { facts: { ...facts, rootIdentity: { device: 'bad-device-secret', inode: '1' } } },
    { facts: { ...facts, heads: { ...facts.heads, applied: { revisionId: null, sequence: 1 } } } },
    { facts: { ...facts, unexpected: 'secret-field' } },
  ];
  for (const change of invalid) {
    secureReplace(path, JSON.stringify({ ...valid, ...change }));
    expect(() => readObservation(directory)).toThrow(/Saved sync status/);
  }
});

async function twoBindings() {
  const { mkdirSync } = await import('node:fs');
  const { createConnection } = await import('../src/connections.ts');
  const { ClientLocal } = await import('@nanosync/client-local');
  const base = root(), state = join(base, 'state'); mkdirSync(state, { mode: 0o700 });
  const bindings = ['first', 'second'].map(name => {
    const data = join(base, name); mkdirSync(data, { mode: 0o700 });
    return createConnection(state, data, randomUUID(), randomUUID(), randomUUID());
  });
  for (const binding of bindings) new ClientLocal(join(state, 'replicas', binding.connectionId), binding.vaultId, binding.deviceId).close();
  return { state, first: bindings[0]!, second: bindings[1]! };
}

test.each(['recovery', 'unsafe', 'corrupt'] as const)('all-folder status contains a %s journal failure to that binding', async kind => {
  const { chmodSync, writeFileSync, readdirSync } = await import('node:fs');
  const { secureCreate } = await import('../src/security.ts');
  const { clientStatus } = await import('../src/status.ts');
  const { state, first, second } = await twoBindings();
  const replica = join(state, 'replicas', first.connectionId), database = join(replica, 'local.sqlite');
  if (kind === 'recovery') secureCreate(database + '-wal', 'interrupted WAL fixture');
  if (kind === 'unsafe') chmodSync(database, 0o644);
  if (kind === 'corrupt') writeFileSync(database, 'secret-corrupt-sentinel');
  const before = readdirSync(replica).sort();
  const status = clientStatus(state);
  const unavailable = status.bindings.find(binding => binding.connectionId === first.connectionId)!;
  const available = status.bindings.find(binding => binding.connectionId === second.connectionId)!;
  expect(unavailable).toMatchObject({ facts: null, upToDate: false, attentionRequired: true });
  expect(unavailable.statusIssues[0]).toMatchObject({ retryable: false });
  expect(unavailable.statusIssues[0]!.recoveryAction.length).toBeGreaterThan(0);
  expect(available.facts).not.toBeNull();
  expect(available.statusIssues).toEqual([]);
  expect(clientStatus(state, first.root).bindings).toHaveLength(1);
  expect(readdirSync(replica).sort()).toEqual(before);
  expect(JSON.stringify(status)).not.toContain('secret-corrupt-sentinel');
});

test('a snapshot race is visible as retryable unknown, not corruption or a failure of other folders', async () => {
  const { spyOn } = await import('bun:test');
  const { ClientLocal, StatusReadError } = await import('@nanosync/client-local');
  const { clientStatus } = await import('../src/status.ts');
  const { state, first, second } = await twoBindings();
  const native = ClientLocal.readStatus;
  const read = spyOn(ClientLocal, 'readStatus').mockImplementation((directory, vault, device) => {
    if (directory.endsWith(first.connectionId)) throw new StatusReadError('STATUS_RACE');
    return native(directory, vault, device);
  });
  try {
    const status = clientStatus(state);
    expect(status.bindings.find(binding => binding.connectionId === first.connectionId)).toMatchObject({
      facts: null, upToDate: false, attentionRequired: false, freshness: 'stale-or-unknown',
      statusIssues: [{ code: 'STATUS_RACE', retryable: true, recoveryAction: 'Refresh status and retry.' }],
    });
    expect(status.bindings.find(binding => binding.connectionId === second.connectionId)!.facts).not.toBeNull();
  } finally { read.mockRestore(); }
});

test('recording unavailable credentials preserves the primary error when the journal also needs recovery', async () => {
  const { ClientError } = await import('../src/errors.ts');
  const { secureCreate } = await import('../src/security.ts');
  const { recordCredentialUnavailable, clientStatus } = await import('../src/status.ts');
  const { state, first } = await twoBindings();
  const replica = join(state, 'replicas', first.connectionId);
  secureCreate(join(replica, 'local.sqlite-wal'), 'interrupted WAL fixture');
  expect(() => recordCredentialUnavailable(state, first, new ClientError('CREDENTIALS_UNAVAILABLE', 'Unlock the user session.'))).not.toThrow();
  const status = clientStatus(state, first.root).bindings[0]!;
  expect(status).toMatchObject({ phase: 'credentials-locked', error: 'CREDENTIALS_UNAVAILABLE', facts: null, upToDate: false });
  expect(status.statusIssues.some(issue => issue.code === 'JOURNAL_RECOVERY_REQUIRED')).toBe(true);
});

test.each(['observation', 'lock'] as const)('an invalid %s does not poison other binding status or echo its contents', async kind => {
  const { secureCreate } = await import('../src/security.ts');
  const { clientStatus } = await import('../src/status.ts');
  const { state, first, second } = await twoBindings();
  const replica = join(state, 'replicas', first.connectionId);
  secureCreate(join(replica, kind === 'observation' ? 'status.json' : '.sync-owner'), 'secret-malformed-sentinel');
  const status = clientStatus(state);
  expect(status.bindings.find(binding => binding.connectionId === first.connectionId)).toMatchObject({
    upToDate: false, attentionRequired: true,
    statusIssues: [{ code: kind === 'observation' ? 'STATUS_INVALID' : 'OWNER_UNAVAILABLE' }],
  });
  expect(status.bindings.find(binding => binding.connectionId === second.connectionId)!.statusIssues).toEqual([]);
  expect(JSON.stringify(status)).not.toContain('secret-malformed-sentinel');
});

test('a secondary status write failure cannot replace the primary credential error or expose native details', async () => {
  const { chmodSync } = await import('node:fs');
  const { ClientError } = await import('../src/errors.ts');
  const { secureCreate } = await import('../src/security.ts');
  const { recordCredentialUnavailable } = await import('../src/status.ts');
  const { state, first } = await twoBindings();
  const path = join(state, 'replicas', first.connectionId, 'status.json');
  secureCreate(path, 'secret-malformed-sentinel'); chmodSync(path, 0o644);
  const primary = new ClientError('CREDENTIALS_UNAVAILABLE', 'Unlock the user session and retry.');
  expect(() => recordCredentialUnavailable(state, first, primary)).not.toThrow();
  expect(primary).toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', exitCode: 2 });
  expect(primary.message).toContain('Unlock the user session');
  expect(primary.message).toContain('status could not be recorded');
  expect(primary.message).not.toContain('secret-malformed-sentinel');
  expect(primary.message).not.toContain(path);
});

async function legacyWalBinding(historicalRoot: boolean) {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { createConnection } = await import('../src/connections.ts');
  const { initializeCredentials } = await import('../src/credentials.ts');
  const { privateDirectory, secureCreate } = await import('../src/security.ts');
  const base = root(), state = join(base, 'state'), data = join(base, 'data');
  fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
  initializeCredentials(state, 'protected-file');
  const serverId = randomUUID(), vaultId = randomUUID(), deviceId = randomUUID();
  secureCreate(join(privateDirectory(join(state, 'servers')), `${serverId}.json`), JSON.stringify({
    version: 1, serverId, deviceId, baseUrl: 'http://localhost:1', name: 'fixture', token: 'A'.repeat(43),
  }));
  secureCreate(join(privateDirectory(join(state, 'keys')), `${serverId}-${vaultId}.json`), JSON.stringify({
    version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32),
  }));
  const binding = createConnection(state, data, serverId, vaultId, deviceId);
  const replica = join(state, 'replicas', binding.connectionId);
  const local = new ClientLocal(replica, vaultId, deviceId);
  if (historicalRoot) {
    const stat = fs.lstatSync(data, { bigint: true }), rootId = randomUUID();
    local.recordScan([{ id: rootId, path: '', kind: 'directory', fingerprint: null, hydration: 'downloaded', revision: null }],
      [{ entryId: rootId, device: String(stat.dev), inode: String(stat.ino) }]);
  }
  local.enqueueOperation(randomUUID(), 'publish');
  const facts = local.statusFacts(), wal = fs.readFileSync(join(replica, 'local.sqlite-wal'));
  local.close();
  fs.unlinkSync(join(replica, 'root-identity.json'));
  fs.writeFileSync(join(replica, 'local.sqlite-wal'), wal, { mode: 0o600 });
  expect(fs.existsSync(join(replica, 'local.sqlite-shm'))).toBe(false);
  return { state, data, binding, replica, facts };
}

test.each(['unscanned', 'scanned'] as const)('public bound start recovers %s legacy WAL before verifying historical root', async kind => {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { observeSyncLock } = await import('../src/sync-lock.ts');
  const { state, data, binding, replica, facts } = await legacyWalBinding(kind === 'scanned');
  expect(() => ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toThrow(/recovery/i);
  let transfers = 0;
  const runner = await startBoundSync(state, data, { fetch: async () => { transfers++; throw new Error('unexpected HTTP'); } });
  try {
    expect(fs.existsSync(join(replica, 'root-identity.json'))).toBe(true);
    expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
    expect(transfers).toBe(0);
  } finally { await runner.stop(); }
  expect(observeSyncLock(replica)).toBeNull();
});

test('legacy status reports journal recovery without misclassifying a present root and marker', async () => {
  const fs = await import('node:fs');
  const { clientStatus } = await import('../src/status.ts');
  const { assertBindingRoot } = await import('../src/connections.ts');
  const { state, data, binding, replica } = await legacyWalBinding(true);
  const before = fs.readdirSync(replica).sort();
  let failure: unknown;
  try { assertBindingRoot(state, binding); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'JOURNAL_RECOVERY_REQUIRED' });
  const status = clientStatus(state, data).bindings[0]!;
  expect(status).toMatchObject({ phase: 'failed', error: 'JOURNAL_RECOVERY_REQUIRED', facts: null, upToDate: false });
  expect(status.statusIssues).toMatchObject([{ code: 'JOURNAL_RECOVERY_REQUIRED', retryable: false }]);
  expect(fs.readdirSync(replica).sort()).toEqual(before);
  expect(fs.existsSync(join(data, '.nanosync'))).toBe(true);
});

test('root guards preserve bigint device/inode precision for new and scanned legacy bindings', async () => {
  const fs = await import('node:fs');
  const { spyOn } = await import('bun:test');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { createConnection, assertBindingRoot } = await import('../src/connections.ts');
  const base = root(), state = join(base, 'state'), data = join(base, 'data');
  fs.mkdirSync(state, { mode: 0o700 }); fs.mkdirSync(data, { mode: 0o700 });
  const device = 9007199254740992n, original = 9007199254740992n;
  let inode = original;
  const native = fs.lstatSync;
  const stats = spyOn(fs, 'lstatSync').mockImplementation(((path: import('node:fs').PathLike, options?: import('node:fs').StatOptions) => {
    const stat = native(path, options as never);
    if (path === data && options?.bigint) return Object.assign(stat, { dev: device, ino: inode });
    return stat;
  }) as typeof fs.lstatSync);
  try {
    const binding = createConnection(state, data, randomUUID(), randomUUID(), randomUUID());
    const replica = join(state, 'replicas', binding.connectionId), identity = join(replica, 'root-identity.json');
    expect(JSON.parse(fs.readFileSync(identity, 'utf8'))).toEqual({ version: 1, device: String(device), inode: String(original) });
    expect(() => assertBindingRoot(state, binding)).not.toThrow();
    inode++;
    expect(Number(inode)).toBe(Number(original));
    expect(() => assertBindingRoot(state, binding)).toThrow(/identity/);
    inode = original;
    fs.unlinkSync(identity);
    const local = new ClientLocal(replica, binding.vaultId, binding.deviceId), rootId = randomUUID();
    local.recordScan([{ id: rootId, path: '', kind: 'directory', fingerprint: null, hydration: 'downloaded', revision: null }],
      [{ entryId: rootId, device: String(device), inode: String(original) }]);
    local.close();
    expect(() => assertBindingRoot(state, binding)).not.toThrow();
    inode++;
    expect(() => assertBindingRoot(state, binding)).toThrow(/identity/);
  } finally { stats.mockRestore(); }
});

test('a race in the second legacy identity observation remains retryable unknown, not a missing folder', async () => {
  const fs = await import('node:fs');
  const { spyOn } = await import('bun:test');
  const { ClientLocal, StatusReadError } = await import('@nanosync/client-local');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { clientStatus } = await import('../src/status.ts');
  const { state, data, replica } = await legacyWalBinding(true);
  const runner = await startBoundSync(state, data);
  try {
    fs.unlinkSync(join(replica, 'root-identity.json'));
    expect(clientStatus(state, data).bindings[0]!.freshness).toBe('observed');
    const native = ClientLocal.readStatus;
    let reads = 0;
    const snapshot = spyOn(ClientLocal, 'readStatus').mockImplementation((directory, vault, device) => {
      if (directory === replica && ++reads === 2) throw new StatusReadError('STATUS_RACE');
      return native(directory, vault, device);
    });
    try {
      const status = clientStatus(state, data).bindings[0]!;
      expect(reads).toBe(2);
      expect(status.facts).not.toBeNull();
      expect(status).toMatchObject({ phase: 'idle', error: 'STATUS_RACE', freshness: 'stale-or-unknown',
        attentionRequired: false, upToDate: false, ownerPresent: true });
      expect(status.statusIssues).toMatchObject([{ code: 'STATUS_RACE', retryable: true }]);
    } finally { snapshot.mockRestore(); }
  } finally { await runner.stop(); }
});

test('owned legacy WAL recovery rejects a replaced root before scans or transfers and preserves pending intent', async () => {
  const fs = await import('node:fs');
  const { spyOn } = await import('bun:test');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { LinuxScanner } = await import('@nanosync/linux-client');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { observeSyncLock } = await import('../src/sync-lock.ts');
  const { state, data, binding, replica, facts } = await legacyWalBinding(true);
  fs.writeFileSync(join(data, 'retained'), 'original user data', { mode: 0o600 });
  fs.renameSync(data, data + '-original'); fs.mkdirSync(data, { mode: 0o700 });
  fs.copyFileSync(join(data + '-original', '.nanosync'), join(data, '.nanosync'));
  let transfers = 0;
  const scans = spyOn(LinuxScanner.prototype, 'snapshot').mockImplementation(() => { throw new Error('unexpected scan'); });
  try {
    await expect(startBoundSync(state, data, { fetch: async () => { transfers++; throw new Error('unexpected HTTP'); } }))
      .rejects.toMatchObject({ code: 'FOLDER_UNAVAILABLE' });
    expect(scans).not.toHaveBeenCalled();
    expect(transfers).toBe(0);
  } finally { scans.mockRestore(); }
  expect(observeSyncLock(replica)).toBeNull();
  expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
  expect(fs.existsSync(join(replica, 'root-identity.json'))).toBe(false);
  expect(fs.readdirSync(data)).toEqual(['.nanosync']);
  expect(fs.readFileSync(join(data + '-original', 'retained'), 'utf8')).toBe('original user data');
});

test('scanned cross-inode move repair refuses before publishing rather than succeeding into a broken owner', async () => {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { repairConnection, records } = await import('../src/connections.ts');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { observeSyncLock } = await import('../src/sync-lock.ts');
  const { state, data, binding, replica } = await legacyWalBinding(true);
  const recovered = await startBoundSync(state, data); await recovered.stop();
  const local = new ClientLocal(replica, binding.vaultId, binding.deviceId);
  for (const work of local.listWork('operations')) {
    local.transition('operations', String(work.id), 'running'); local.transition('operations', String(work.id), 'done');
  }
  const facts = local.statusFacts(); local.close();
  const identity = fs.readFileSync(join(replica, 'root-identity.json'), 'utf8');
  const moved = data + '-copied'; fs.cpSync(data, moved, { recursive: true }); fs.rmSync(data, { recursive: true });
  expect(() => repairConnection(state, moved, 'move')).toThrow(/copy repair/i);
  expect(records(state)).toEqual([binding]);
  expect(fs.readFileSync(join(replica, 'root-identity.json'), 'utf8')).toBe(identity);
  expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
  expect(observeSyncLock(replica)).toBeNull();
  expect(JSON.parse(fs.readFileSync(join(moved, '.nanosync'), 'utf8')).connectionId).toBe(binding.connectionId);
});

test('same-inode move repair recovers the owned journal, retains pending intent, and permits public start', async () => {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { repairConnection } = await import('../src/connections.ts');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { state, data, binding, replica, facts } = await legacyWalBinding(true);
  const moved = data + '-renamed'; fs.renameSync(data, moved);
  expect(repairConnection(state, moved, 'move')).toEqual({ ...binding, root: moved });
  expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
  let transfers = 0;
  const runner = await startBoundSync(state, moved, { fetch: async () => { transfers++; throw new Error('unexpected HTTP'); } });
  try { expect(transfers).toBe(0); } finally { await runner.stop(); }
});

test('interrupted cross-inode move repair refuses without discarding recovery or blessing the new root', async () => {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { repairConnection, records } = await import('../src/connections.ts');
  const { observeSyncLock } = await import('../src/sync-lock.ts');
  const { state, data, binding, replica, facts } = await legacyWalBinding(true);
  const moved = data + '-copied'; fs.cpSync(data, moved, { recursive: true }); fs.rmSync(data, { recursive: true });
  let failure: unknown;
  try { repairConnection(state, moved, 'move'); } catch (error) { failure = error; }
  expect(failure).toMatchObject({ code: 'MOVE_RECOVERY_REQUIRED', exitCode: 2 });
  expect(records(state)).toEqual([binding]);
  expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
  expect(fs.existsSync(join(replica, 'root-identity.json'))).toBe(false);
  expect(observeSyncLock(replica)).toBeNull();
});

test('move repair cannot modify binding or root identity around a live replica owner', async () => {
  const fs = await import('node:fs');
  const { repairConnection, records } = await import('../src/connections.ts');
  const { acquireSyncLock } = await import('../src/sync-lock.ts');
  const { state, data, binding, replica } = await legacyWalBinding(true);
  const moved = data + '-renamed'; fs.renameSync(data, moved);
  const wal = fs.readFileSync(join(replica, 'local.sqlite-wal'));
  const release = acquireSyncLock(replica);
  try {
    expect(() => repairConnection(state, moved, 'move')).toThrow(/live process/);
    expect(records(state)).toEqual([binding]);
    expect(fs.existsSync(join(replica, 'root-identity.json'))).toBe(false);
    expect(fs.readFileSync(join(replica, 'local.sqlite-wal'))).toEqual(wal);
  } finally { release(); }
});

test('failed runner construction zeroes its copied key even when journal close throws', async () => {
  const { spyOn } = await import('bun:test');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { SyncRunner } = await import('../src/sync-runner.ts');
  const { observeSyncLock } = await import('../src/sync-lock.ts');
  const { data, binding, replica } = await legacyWalBinding(true);
  const masterKey = new Uint8Array(32).fill(7);
  const from = spyOn(Uint8Array, 'from'), nativeClose = ClientLocal.prototype.close;
  const close = spyOn(ClientLocal.prototype, 'close').mockImplementation(function(this: import('@nanosync/client-local').ClientLocal) {
    nativeClose.call(this); throw new Error('controlled close failure');
  });
  try {
    expect(() => SyncRunner.start({ clientDirectory: replica, syncDirectory: data,
      vaultId: binding.vaultId, deviceId: binding.deviceId, masterKey, baseUrl: 'http://localhost:1', token: 'A'.repeat(43),
      validateRoot() { throw new Error('controlled initialization failure'); },
    })).toThrow('controlled close failure');
    const copied = from.mock.calls.findIndex(([input]) => input === masterKey);
    expect(copied).toBeGreaterThanOrEqual(0);
    expect(from.mock.results[copied]!.value).toEqual(new Uint8Array(32));
    expect(masterKey).toEqual(new Uint8Array(32).fill(7));
    expect(observeSyncLock(replica)).toBeNull();
  } finally { close.mockRestore(); from.mockRestore(); }
});

test('unscanned move with no recovery work can still select a copied directory explicitly', async () => {
  const fs = await import('node:fs');
  const { ClientLocal } = await import('@nanosync/client-local');
  const { repairConnection } = await import('../src/connections.ts');
  const { startBoundSync } = await import('../src/bound-sync.ts');
  const { state, data, binding, replica } = await legacyWalBinding(false);
  const recovered = await startBoundSync(state, data); await recovered.stop();
  const local = new ClientLocal(replica, binding.vaultId, binding.deviceId);
  for (const work of local.listWork('operations')) {
    local.transition('operations', String(work.id), 'running'); local.transition('operations', String(work.id), 'done');
  }
  const facts = local.statusFacts(); local.close();
  const moved = data + '-copied'; fs.cpSync(data, moved, { recursive: true }); fs.rmSync(data, { recursive: true });
  expect(repairConnection(state, moved, 'move')).toEqual({ ...binding, root: moved });
  expect(ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId)).toEqual(facts);
  const runner = await startBoundSync(state, moved); await runner.stop();
});
