import { afterEach, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ClientLocal } from '@nanosync/client-local';
import { collectDiagnostics, exportDiagnostics, type DiagnosticsRuntime } from '../src/diagnostics.ts';
import { createConnection, withConnectionRegistry } from '../src/connections.ts';
import { initializeCredentials, migrateCredentials, type CredentialStore } from '../src/credentials.ts';
import { privateDirectory, secureCreate } from '../src/security.ts';
import { acquireSyncLock } from '../src/sync-lock.ts';
import { writeRemoval } from '../src/removal-state.ts';
import { writeObservation, type SyncObservation } from '../src/status.ts';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const runtime: DiagnosticsRuntime = {
  applicationVersion: '0.1.0', toolkitVersion: null,
  native: {
    startup: 'not-probed', tray: 'not-probed', session: 'not-probed',
    notifications: 'not-probed', notificationActions: 'not-probed',
  },
};
function fixture(bound = false) {
  const base = fs.mkdtempSync(join(tmpdir(), 'nanosync-diagnostics-'));
  roots.push(base);
  const state = join(base, 'state'), output = join(base, 'Documents');
  const data = join(base, 'private-folder');
  fs.mkdirSync(state, { mode: 0o700 });
  fs.mkdirSync(output, { mode: 0o755 });
  fs.chmodSync(output, 0o755);
  fs.mkdirSync(data, { mode: 0o700 });
  const binding = bound ? createConnection(state, data, randomUUID(), randomUUID(), randomUUID()) : null;
  return { base, state, output, data, binding, destination: join(output, 'report.json') };
}
function errorCode(action: () => unknown) {
  try { action(); throw new Error('expected failure'); }
  catch (error) { return (error as { code: string }).code; }
}

function descriptorAt(descriptor: unknown, path: string): boolean {
  if (typeof descriptor !== 'number') return false;
  try {
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const named = fs.lstatSync(path, { bigint: true });
    return opened.dev === named.dev && opened.ino === named.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function privateInventory(root: string) {
  return fs.readdirSync(root, { recursive: true }).map(name => {
    const path = join(root, String(name)), stat = fs.lstatSync(path, { bigint: true });
    return { name, dev: stat.dev, ino: stat.ino, mode: stat.mode,
      content: stat.isFile() ? fs.readFileSync(path, 'utf8') : null };
  });
}

test('headless collection is allowlisted, noncreating, unknown facts are not zero', () => {
  const item = fixture(true);
  const before = fs.readdirSync(item.state, { recursive: true });
  const probe = spyOn(Bun.secrets, 'get').mockImplementation(() => { throw new Error('store probe'); });
  try {
    const report = collectDiagnostics(item.state, runtime);
    expect(Object.keys(report).sort()).toEqual([
      'bindings', 'complete', 'counts', 'credentials', 'native', 'recovery',
      'schemas', 'supportedSchemas', 'version', 'versions',
    ]);
    expect(report.schemas).toEqual({ settings: null, observation: [null], journal: null,
      credentialDescriptor: null });
    expect(report.bindings[0]).toMatchObject({ ordinal: 1, phase: 'not-started',
      freshness: 'stale-or-unknown', heads: null, pending: null, conflicts: null, ownerKind: null });
    expect(report.counts).toEqual({ bindings: 1, conflicts: null, pending: null });
    expect(report.versions.electrobun).toBeNull();
    expect(report.native.notifications).toBe('not-probed');
    expect(probe).not.toHaveBeenCalled();
    expect(fs.readdirSync(item.state, { recursive: true })).toEqual(before);
  } finally { probe.mockRestore(); }
});

test('default and identifier opt-in never disclose credentials, hashes, raw errors or environment', () => {
  const item = fixture(true), canary = 'PRIVATE-CANARY-token-key-recovery-ref-hash';
  initializeCredentials(item.state, 'protected-file');
  const servers = join(item.state, 'servers');
  fs.mkdirSync(servers, { mode: 0o700 });
  secureCreate(join(servers, `${randomUUID()}.json`), JSON.stringify({
    token: canary, password: canary, credentialHash: canary,
    credential: { generation: canary, reference: canary },
    url: 'https://private-canary.example', alias: 'private-alias', deviceName: 'private-device',
  }));
  const originalOpen = fs.openSync;
  const open = spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (String(args[0]).startsWith(servers + '/')) throw new Error('secret read attempted');
    return originalOpen(...args);
  });
  process.env.NANOSYNC_DIAGNOSTICS_CANARY = canary;
  const replica = join(item.state, 'replicas', item.binding!.connectionId);
  secureCreate(join(replica, 'status.json'), JSON.stringify({
    version: 1, error: { code: 'FORBIDDEN', message: canary, token: canary },
    remoteError: { message: canary }, logs: canary,
  }));
  try {
    for (const includeIdentifiers of [false, true]) {
      const report = collectDiagnostics(item.state, runtime, { includeIdentifiers });
      const text = JSON.stringify(report);
      for (const secret of [canary, 'private-canary.example', 'private-alias', 'private-device'])
        expect(text).not.toContain(secret);
      expect(report.complete).toBe(false);
      expect(report.bindings[0]!.issueCodes).toContain('STATUS_INVALID');
      expect(report.schemas.observation).toEqual([null]);
      expect(text).not.toContain(item.binding!.vaultId);
      expect(text).not.toContain(item.binding!.deviceId);
      if (includeIdentifiers) {
        expect(report.identifiers).toEqual({ bindings: [{ ordinal: 1,
          bindingId: item.binding!.connectionId, root: item.data }] });
      } else {
        expect(text).not.toContain(item.base);
        expect(text).not.toContain(item.binding!.connectionId);
        expect(report).not.toHaveProperty('identifiers');
      }
    }
  } finally {
    open.mockRestore();
    delete process.env.NANOSYNC_DIAGNOSTICS_CANARY;
  }
});

test('validated schemas and aggregates omit revision IDs and root identity', () => {
  const item = fixture(true), binding = item.binding!;
  const replica = join(item.state, 'replicas', binding.connectionId);
  const local = new ClientLocal(replica, binding.vaultId, binding.deviceId);
  const facts = local.statusFacts();
  local.close();
  const observation: SyncObservation = {
    version: 1, observedAt: 100, phase: 'offline', owner: null, lock: null,
    progress: { upload: { count: 0, bytes: 0 }, download: { count: 0, bytes: 0 } },
    facts, enginePhase: null, verified: false, lastRemoteCheck: 90, lastSuccess: null,
    error: 'UNAVAILABLE', attentionError: 'UNAVAILABLE', statusIssues: [],
  };
  writeObservation(replica, observation);
  const report = collectDiagnostics(item.state, runtime);
  expect(report.schemas.observation).toEqual([1]);
  expect(report.schemas.journal).toBeNull();
  expect(report.supportedSchemas.journal).toBe(7);
  expect(report.counts.pending).toEqual(facts.pending);
  expect(report.counts.conflicts).toBe(facts.conflicts);
  expect(report.bindings[0]).toMatchObject({ phase: 'offline', errorCode: 'UNAVAILABLE',
    pending: facts.pending, conflicts: facts.conflicts });
  expect(Object.keys(report.bindings[0]!.heads!)).toEqual(['observed', 'accepted', 'applied']);
  expect(JSON.stringify(report)).not.toContain('rootIdentity');
  expect(JSON.stringify(report)).not.toContain('revisionId');
});

test('0755 Documents export is exclusive 0600, flushes file then parent and matches collection', () => {
  const item = fixture();
  const flushed: string[] = [], original = fs.fsyncSync;
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if (descriptorAt(descriptor, item.destination)) flushed.push('file');
    if (descriptorAt(descriptor, item.output)) flushed.push('directory');
    original(descriptor);
  });
  try {
    expect(exportDiagnostics(item.state, item.destination, runtime)).toEqual({
      version: 1, exported: true, includeIdentifiers: false,
    });
    expect(flushed).toEqual(['file', 'directory']);
    expect(fs.statSync(item.destination).mode & 0o777).toBe(0o600);
    expect(fs.statSync(item.output).mode & 0o777).toBe(0o755);
    const written = JSON.parse(fs.readFileSync(item.destination, 'utf8'));
    expect(written).toEqual(collectDiagnostics(item.state, runtime));
  } finally { flush.mockRestore(); }
});

test.each(['regular', 'symlink', 'dangling', 'hardlink'] as const)('existing %s is never replaced', kind => {
  const item = fixture(), source = join(item.output, 'original');
  fs.writeFileSync(source, 'preserved', { mode: 0o600 });
  if (kind === 'regular') fs.writeFileSync(item.destination, 'existing', { mode: 0o600 });
  if (kind === 'symlink') fs.symlinkSync(source, item.destination);
  if (kind === 'dangling') fs.symlinkSync(join(item.output, 'missing'), item.destination);
  if (kind === 'hardlink') fs.linkSync(source, item.destination);
  const before = fs.lstatSync(item.destination);
  expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
    .toBe('DIAGNOSTICS_DESTINATION_EXISTS');
  expect(fs.lstatSync(item.destination).ino).toBe(before.ino);
  expect(fs.readFileSync(source, 'utf8')).toBe('preserved');
});

test('source overlap, symlink ancestry and writable parent are rejected without changing state', () => {
  const item = fixture(true), link = join(item.base, 'link');
  fs.symlinkSync(item.output, link);
  for (const destination of [join(item.state, 'report.json'), join(item.data, 'report.json'),
    item.state, item.data, join(link, 'report.json')]) {
    expect(errorCode(() => exportDiagnostics(item.state, destination, runtime)))
      .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
  }
  fs.chmodSync(item.output, 0o777);
  expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
    .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
  expect(fs.existsSync(item.destination)).toBe(false);
  expect(fs.statSync(item.state).mode & 0o777).toBe(0o700);
});

test.each(['write', 'file-fsync', 'directory-fsync'] as const)('%s failure retains artifact', fault => {
  const item = fixture(), canary = 'private exception path token';
  const originalWrite = fs.writeFileSync, originalSync = fs.fsyncSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    if (fault === 'write' && descriptorAt(args[0], item.destination)) throw new Error(canary);
    return originalWrite(...args);
  });
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if ((fault === 'directory-fsync' && descriptorAt(descriptor, item.output)) ||
        (fault === 'file-fsync' && descriptorAt(descriptor, item.destination)))
      throw new Error(canary);
    originalSync(descriptor);
  });
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_WRITE_FAILED');
    expect(fs.statSync(item.destination).mode & 0o777).toBe(0o600);
  } finally { write.mockRestore(); flush.mockRestore(); }
});

test('target substitution during write is detected and replacement is never removed', () => {
  const item = fixture(), moved = join(item.output, 'failed-artifact');
  const original = fs.writeFileSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    if (descriptorAt(args[0], item.destination)) {
      fs.renameSync(item.destination, moved);
      original(item.destination, 'replacement', { mode: 0o600 });
    }
    return original(...args);
  });
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_WRITE_FAILED');
    expect(fs.readFileSync(item.destination, 'utf8')).toBe('replacement');
    expect(fs.statSync(moved).mode & 0o777).toBe(0o600);
  } finally { write.mockRestore(); }
});

test('parent substitution at file fsync is detected without deleting either directory', () => {
  const item = fixture(), moved = join(item.base, 'old-documents');
  const original = fs.fsyncSync;
  let swapped = false;
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if (!swapped && descriptorAt(descriptor, item.destination)) {
      swapped = true;
      fs.renameSync(item.output, moved);
      fs.mkdirSync(item.output, { mode: 0o755 });
    }
    original(descriptor);
  });
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
    expect(fs.existsSync(join(moved, 'report.json'))).toBe(true);
    expect(fs.readdirSync(item.output)).toEqual([]);
  } finally { flush.mockRestore(); }
});

test('OS-store mode is diagnosable without accessing the credential store', () => {
  const item = fixture();
  initializeCredentials(item.state, 'os-store');
  const get = spyOn(Bun.secrets, 'get').mockImplementation(() => { throw new Error('locked'); });
  try {
    expect(collectDiagnostics(item.state, runtime).credentials.mode).toBe('os-store');
    expect(exportDiagnostics(item.state, item.destination, runtime).exported).toBe(true);
    expect(get).not.toHaveBeenCalled();
  } finally { get.mockRestore(); }
});

test('missing bound root produces an explicit partial report with unknown aggregates', () => {
  const item = fixture(true);
  fs.renameSync(item.data, item.data + '-missing');
  const report = collectDiagnostics(item.state, runtime);
  expect(report.complete).toBe(false);
  expect(report.counts.conflicts).toBeNull();
  expect(report.counts.pending).toBeNull();
  expect(report.bindings[0]).toMatchObject({ phase: 'folder-unavailable',
    errorCode: 'FOLDER_UNAVAILABLE' });
});

test('a bound root replaced by a symlink cannot hide export overlap', () => {
  const item = fixture(true);
  fs.renameSync(item.data, item.data + '-original');
  fs.symlinkSync(item.output, item.data);
  expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
    .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
  expect(fs.existsSync(item.destination)).toBe(false);
});

test.each(['target', 'parent'] as const)('adjacent 64-bit %s inode substitution is refused', kind => {
  const item = fixture(), high = 1n << 53n;
  const originalOpen = fs.openSync, originalStat = fs.fstatSync, originalLstat = fs.lstatSync;
  let watched: number | undefined;
  const watchedPath = kind === 'target' ? item.destination : item.output;
  const open = spyOn(fs, 'openSync').mockImplementation((...args) => {
    const descriptor = originalOpen(...args);
    if (args[0] === watchedPath) watched = descriptor;
    return descriptor;
  });
  const stat = spyOn(fs, 'fstatSync').mockImplementation(((descriptor, options) => {
    const found = originalStat(descriptor, options);
    if (descriptor !== watched) return found;
    return Object.defineProperty(Object.create(found), 'ino', {
      value: typeof found.ino === 'bigint' ? high : 9_007_199_254_740_992,
    });
  }) as typeof fs.fstatSync);
  const lstat = spyOn(fs, 'lstatSync').mockImplementation(((path, options) => {
    const found = originalLstat(path, options);
    if (!found || path !== watchedPath) return found;
    return Object.defineProperty(Object.create(found), 'ino', {
      value: typeof found.ino === 'bigint' ? high + 1n : 9_007_199_254_740_992,
    });
  }) as typeof fs.lstatSync);
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe(kind === 'target' ? 'DIAGNOSTICS_WRITE_FAILED' : 'DIAGNOSTICS_DESTINATION_UNSAFE');
    if (kind === 'parent') expect(fs.existsSync(item.destination)).toBe(false);
    else expect(fs.statSync(item.destination).size).toBe(0);
  } finally { open.mockRestore(); stat.mockRestore(); lstat.mockRestore(); }
});

test('registry lease excludes new bindings from destination creation through parent fsync', () => {
  const item = fixture(), attempts: string[] = [];
  const originalOpen = fs.openSync, originalSync = fs.fsyncSync;
  const attempt = (phase: string) => {
    attempts.push(phase);
    expect(() => createConnection(item.state, item.output,
      randomUUID(), randomUUID(), randomUUID(), true)).toThrow(/another live process/);
    expect(fs.existsSync(join(item.output, '.nanosync'))).toBe(false);
  };
  const open = spyOn(fs, 'openSync').mockImplementation((...args) => {
    if (args[0] === item.destination) attempt('create');
    return originalOpen(...args);
  });
  const flush = spyOn(fs, 'fsyncSync').mockImplementation(descriptor => {
    if (descriptorAt(descriptor, item.destination)) attempt('file-fsync');
    if (descriptorAt(descriptor, item.output)) attempt('parent-fsync');
    originalSync(descriptor);
  });
  try {
    expect(exportDiagnostics(item.state, item.destination, runtime,
      { includeIdentifiers: true }).exported).toBe(true);
    expect(attempts).toEqual(['create', 'file-fsync', 'parent-fsync']);
  } finally { open.mockRestore(); flush.mockRestore(); }
  expect(withConnectionRegistry(item.state, () => 'released')).toBe('released');
});

test('a binding published after collection is reread under the registry lease', () => {
  const item = fixture();
  const original = fs.openSync;
  let published = false;
  const open = spyOn(fs, 'openSync').mockImplementation((...args) => {
    const path = String(args[0]);
    if (!published && path.startsWith(join(item.state, 'registry-lock', '.sync-owner-'))) {
      published = true;
      createConnection(item.state, item.output, randomUUID(), randomUUID(), randomUUID());
    }
    return original(...args);
  });
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
    expect(published).toBe(true);
    expect(fs.existsSync(item.destination)).toBe(false);
  } finally { open.mockRestore(); }
});

test('missing bound root beneath a symlink ancestor cannot alias an export filename', () => {
  const item = fixture();
  const parent = join(item.base, 'canonical-parent'), bound = join(parent, 'sync');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(bound, { mode: 0o700 });
  createConnection(item.state, bound, randomUUID(), randomUUID(), randomUUID());
  fs.renameSync(parent, parent + '-original');
  fs.symlinkSync(item.output, parent);
  const destination = join(item.output, 'sync');
  expect(fs.existsSync(bound)).toBe(false);
  expect(errorCode(() => exportDiagnostics(item.state, destination, runtime)))
    .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
  expect(fs.existsSync(destination)).toBe(false);
});

test('legitimate missing bound ancestors still permit an explicit partial export', () => {
  const item = fixture();
  const parent = join(item.base, 'canonical-parent'), bound = join(parent, 'sync');
  fs.mkdirSync(parent, { mode: 0o700 });
  fs.mkdirSync(bound, { mode: 0o700 });
  createConnection(item.state, bound, randomUUID(), randomUUID(), randomUUID());
  fs.renameSync(parent, parent + '-missing');
  expect(exportDiagnostics(item.state, item.destination, runtime).exported).toBe(true);
  const report = JSON.parse(fs.readFileSync(item.destination, 'utf8'));
  expect(report.complete).toBe(false);
  expect(report.bindings[0].errorCode).toBe('FOLDER_UNAVAILABLE');
});

test.each(['removing-bindings', 'cleaning-credentials', 'credentials-complete'] as const)(
  'pending removal %s remains exportable without recovery mutation', phase => {
    const item = fixture(true), binding = item.binding!;
    const stat = fs.lstatSync(item.data, { bigint: true });
    privateDirectory(join(item.state, 'registry-lock'));
    writeRemoval(item.state, {
      version: 1, requestId: randomUUID(), kind: 'disconnect', serverId: null, force: false, phase,
      bindings: [{ connection: binding, rootIdentity: {
        device: String(stat.dev), inode: String(stat.ino),
      }, rootWasMissing: false }], credentialPaths: [],
    });
    const before = privateInventory(item.state);
    const get = spyOn(Bun.secrets, 'get').mockImplementation(() => { throw new Error('keyring probe'); });
    const set = spyOn(Bun.secrets, 'set').mockImplementation(() => { throw new Error('keyring write'); });
    const remove = spyOn(Bun.secrets, 'delete').mockImplementation(() => {
      throw new Error('keyring delete');
    });
    try {
      expect(exportDiagnostics(item.state, item.destination, runtime).exported).toBe(true);
      const report = JSON.parse(fs.readFileSync(item.destination, 'utf8'));
      expect(report.recovery).toEqual({ removalPending: true, phase });
      expect(report.complete).toBe(false);
      expect(report.bindings[0].errorCode).toBe('REMOVAL_PENDING');
      expect(JSON.stringify(report)).not.toContain(binding.connectionId);
      expect(JSON.stringify(report)).not.toContain(item.base);
      expect(privateInventory(item.state)).toEqual(before);
      expect(get).not.toHaveBeenCalled();
      expect(set).not.toHaveBeenCalled();
      expect(remove).not.toHaveBeenCalled();
    } finally { get.mockRestore(); set.mockRestore(); remove.mockRestore(); }
  },
);

test.each([
  ['migration-intent', 'copying'], ['migration-target-ready', 'target-ready'],
  ['migration-cleanup-intent', 'cleanup'],
] as const)('pending %s exports without recovery effects', async (checkpoint, phase) => {
  const item = fixture(true), binding = item.binding!, values = new Map<string, string>();
  const calls: string[] = [];
  const store: CredentialStore = {
    async get({ name }) { calls.push('get'); return values.get(name) ?? null; },
    async set({ name, value }) { calls.push('set'); values.set(name, value); },
    async delete({ name }) { calls.push('delete'); return values.delete(name); },
  };
  const servers = privateDirectory(join(item.state, 'servers'));
  const keys = privateDirectory(join(item.state, 'keys'));
  secureCreate(join(servers, `${binding.serverId}.json`), JSON.stringify({
    version: 1, serverId: binding.serverId, deviceId: binding.deviceId,
    baseUrl: 'https://private-migration.example', name: 'private-migration-alias',
    token: 'A'.repeat(43),
  }));
  secureCreate(join(keys, `${binding.serverId}-${binding.vaultId}.json`), JSON.stringify({
    version: 1, serverId: binding.serverId, vaultId: binding.vaultId, masterKey: 'ab'.repeat(32),
  }));

  await expect(migrateCredentials(item.state, true, {
    store, checkpoint(name) {
      if (name === checkpoint) throw new Error('fixture interruption');
    },
  })).rejects.toThrow('fixture interruption');

  const before = privateInventory(item.state), providerBefore = Array.from(values.entries());
  const migrationFile = join(item.state, 'credential-migration.json');
  const migration = JSON.parse(fs.readFileSync(migrationFile, 'utf8'));
  const privateReferences = [
    migration.source.rootId, migration.source.generation, migration.target.generation,
  ];
  const callsBefore = calls.slice();

  const originalOpen = fs.openSync;
  const open = spyOn(fs, 'openSync').mockImplementation((...args) => {
    const path = String(args[0]);
    if (path.startsWith(join(item.state, 'servers') + '/') ||
        path.startsWith(join(item.state, 'keys') + '/')) throw new Error('secret read attempted');
    return originalOpen(...args);
  });
  const get = spyOn(Bun.secrets, 'get').mockImplementation(() => { throw new Error('keyring probe'); });
  try {
    expect(exportDiagnostics(item.state, item.destination, runtime).exported).toBe(true);
    const report = JSON.parse(fs.readFileSync(item.destination, 'utf8'));
    expect(report.credentials).toMatchObject({ migrationPending: true, phase });
    expect(report.complete).toBe(false);
    expect(report.bindings[0]).toMatchObject({ ordinal: 1, phase: null, ownerPresent: null,
      heads: null, pending: null, conflicts: null,
      errorCode: 'CREDENTIAL_MIGRATION_PENDING', issueCodes: ['CREDENTIAL_MIGRATION_PENDING'] });
    expect(report.schemas.observation).toEqual([null]);
    for (const secret of [item.base, binding.connectionId, binding.serverId, binding.vaultId,
      'A'.repeat(43), 'ab'.repeat(32), 'private-migration.example', 'private-migration-alias'])
      expect(JSON.stringify(report)).not.toContain(secret);
    const identifiedFile = join(item.output, 'identified.json');
    expect(exportDiagnostics(item.state, identifiedFile, runtime, { includeIdentifiers: true }).exported)
      .toBe(true);
    const identified = JSON.parse(fs.readFileSync(identifiedFile, 'utf8'));
    expect(identified.identifiers).toEqual({ bindings: [{ ordinal: 1,
      bindingId: binding.connectionId, root: item.data }] });
    for (const forbidden of [...privateReferences, binding.serverId, binding.vaultId,
      'A'.repeat(43), 'ab'.repeat(32), 'private-migration.example', 'private-migration-alias']) {
      expect(JSON.stringify(report)).not.toContain(forbidden);
      expect(JSON.stringify(identified)).not.toContain(forbidden);
    }
    expect(calls).toEqual(callsBefore);
    expect(Array.from(values.entries())).toEqual(providerBefore);
    expect(get).not.toHaveBeenCalled();
  } finally { open.mockRestore(); get.mockRestore(); }
  expect(privateInventory(item.state)).toEqual(before);
});

test('a held registry owner is not bypassed or stolen for diagnostics', () => {
  const item = fixture(), directory = privateDirectory(join(item.state, 'registry-lock'));
  const release = acquireSyncLock(directory), before = privateInventory(item.state);
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_COLLECTION_FAILED');
    expect(fs.existsSync(item.destination)).toBe(false);
    expect(privateInventory(item.state)).toEqual(before);
  } finally { release(); }
});

test('unowned destination parent is rejected using metadata without changing its mode', () => {
  const item = fixture();
  const original = fs.lstatSync;
  const stat = spyOn(fs, 'lstatSync').mockImplementation(((path, options) => {
    const found = original(path, options);
    if (!found || path !== item.output) return found;
    const foreign = process.getuid!() + 1;
    return Object.defineProperty(Object.create(found), 'uid', {
      value: typeof found.uid === 'bigint' ? BigInt(foreign) : foreign,
    });
  }) as typeof fs.lstatSync);
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
    expect(fs.statSync(item.output).mode & 0o777).toBe(0o755);
    expect(fs.existsSync(item.destination)).toBe(false);
  } finally { stat.mockRestore(); }
});

test('hardlink introduced after creation fails single-link verification without cleanup', () => {
  const item = fixture(), linked = join(item.output, 'new-hardlink');
  const original = fs.writeFileSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    const report = descriptorAt(args[0], item.destination);
    original(...args);
    if (report) fs.linkSync(item.destination, linked);
  });
  try {
    expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
      .toBe('DIAGNOSTICS_WRITE_FAILED');
    expect(fs.statSync(item.destination).nlink).toBe(2);
    expect(fs.statSync(linked).ino).toBe(fs.statSync(item.destination).ino);
  } finally { write.mockRestore(); }
});

test('OS failures do not expose exception text or private destination paths', () => {
  const item = fixture(), canary = 'SECRET-REMOTE-MESSAGE-path-token';
  const original = fs.writeFileSync;
  const write = spyOn(fs, 'writeFileSync').mockImplementation((...args) => {
    if (descriptorAt(args[0], item.destination)) throw new Error(canary);
    return original(...args);
  });
  try {
    try {
      exportDiagnostics(item.state, item.destination, runtime);
      throw new Error('expected failure');
    } catch (error) {
      expect((error as { code: string }).code).toBe('DIAGNOSTICS_WRITE_FAILED');
      expect((error as Error).message).not.toContain(canary);
      expect((error as Error).message).not.toContain(item.base);
      expect(error).not.toHaveProperty('cause');
    }
  } finally { write.mockRestore(); }
});

test('collection/input failures are fixed and create no output or missing parent', () => {
  const item = fixture();
  secureCreate(join(item.state, 'settings.json'), 'private-malformed-settings');
  expect(errorCode(() => exportDiagnostics(item.state, item.destination, runtime)))
    .toBe('DIAGNOSTICS_COLLECTION_FAILED');
  expect(fs.existsSync(item.destination)).toBe(false);
  const clean = fixture();
  expect(errorCode(() => exportDiagnostics(clean.state, 'relative.json', runtime)))
    .toBe('DIAGNOSTICS_INVALID_INPUT');
  const invalidRuntime = { ...runtime, applicationVersion: 'secret/path' };
  expect(errorCode(() => collectDiagnostics(clean.state, invalidRuntime)))
    .toBe('DIAGNOSTICS_INVALID_INPUT');
  expect(errorCode(() => collectDiagnostics(clean.state, runtime, { includeIdentifiers: 'yes' } as never)))
    .toBe('DIAGNOSTICS_INVALID_INPUT');
  const missingParent = join(clean.output, 'missing', 'report.json');
  expect(errorCode(() => exportDiagnostics(clean.state, missingParent, runtime)))
    .toBe('DIAGNOSTICS_WRITE_FAILED');
  expect(fs.existsSync(join(clean.output, 'missing'))).toBe(false);
});
