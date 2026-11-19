import { afterEach, expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createConnection,
  disconnectConnections,
  removeServerConnection,
  removalStatus,
  resumeRemoval,
  records,
  initializeCredentials,
  migrateCredentials,
  privateDirectory,
  secureCreate,
  credentialStatus,
  onboardingSnapshot,
  inspectRemoval,
  openBoundSync,
  acquireSyncLock,
  setPaused,
  readSettings,
  type CredentialStore,
} from '../src/index.ts';
const temporary: string[] = [];
afterEach(() => {
  for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true });
});
class Store implements CredentialStore {
  values = new Map<string, string>();
  locked = false;
  async get(ref: { name: string }) {
    return this.locked ? null : (this.values.get(ref.name) ?? null);
  }
  async set(ref: { name: string; value: string }) {
    if (this.locked) throw Error('PRIVATE_STORE_SENTINEL');
    this.values.set(ref.name, ref.value);
  }
  async delete(ref: { name: string }) {
    return !this.locked && this.values.delete(ref.name);
  }
}
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'ns-removal-'));
  temporary.push(base);
  const root = join(base, 'state'),
    files = join(base, 'files');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(files);
  initializeCredentials(root, 'protected-file');
  const serverId = randomUUID(),
    vaultId = randomUUID(),
    deviceId = randomUUID();
  secureCreate(
    join(privateDirectory(join(root, 'servers')), `${serverId}.json`),
    JSON.stringify({
      version: 1,
      serverId,
      deviceId,
      baseUrl: 'https://example.test',
      name: 'test',
      token: 'A'.repeat(43),
    }),
  );
  secureCreate(
    join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`),
    JSON.stringify({
      version: 1,
      serverId,
      vaultId,
      masterKey: 'ab'.repeat(32),
    }),
  );
  const binding = createConnection(root, files, serverId, vaultId, deviceId);
  writeFileSync(join(files, 'preserved-conflict'), 'LOCAL_CONTENT_SENTINEL');
  writeFileSync(join(files, '.nanosyncignore'), '*.tmp\n', { mode: 0o600 });
  return { base, root, files, binding, serverId, vaultId, deviceId };
}
for (const checkpoint of [
  'removal-intent',
  'removal-marker',
  'removal-record',
  'removal-replica-file',
  'removal-bindings',
  'cleanup-intent-staged',
  'cleanup-intent-published',
  'cleanup-marker',
  'cleanup-deleted',
  'cleanup-files',
  'removal-credentials',
  'removal-cleanup-finalized',
]) {
  test(`server removal reopens and rolls forward after ${checkpoint} with original identities and provider inventory`, async () => {
    const setup = fixture(),
      store = new Store();
    await migrateCredentials(setup.root, true, { store });
    const other = randomUUID();
    store.values.set('unrelated-server-reference', 'OTHER_SERVER_SECRET');
    await expect(
      removeServerConnection(setup.root, setup.serverId, true, {
        store,
        checkpoint(phase) {
          if (phase === checkpoint) throw Error('injected crash');
        },
      }),
    ).rejects.toThrow('injected crash');
    const intent = removalStatus(setup.root)!;
    expect(intent.bindings[0]!.connection).toEqual(setup.binding);
    expect(records(setup.root)).toEqual([setup.binding]);
    const summary = onboardingSnapshot(setup.root);
    expect(summary.removal?.requestId).toBe(intent.requestId);
    expect(summary.status).toBeNull();
    const serialized = JSON.stringify(summary);
    for (const secret of [
      'A'.repeat(43),
      'ab'.repeat(32),
      'LOCAL_CONTENT_SENTINEL',
      'PRIVATE_STORE_SENTINEL',
    ])
      expect(serialized).not.toContain(secret);
    await expect(
      openBoundSync(setup.root, setup.files, {
        origin: 'desktop',
        instanceId: other,
      }),
    ).rejects.toMatchObject({ code: 'REMOVAL_PENDING' });
    expect(() =>
      createConnection(setup.root, setup.files, setup.serverId, setup.vaultId, setup.deviceId),
    ).toThrow('Removal pending');
    await expect(migrateCredentials(setup.root, true, { store })).rejects.toMatchObject({
      code: 'REMOVAL_PENDING',
    });
    store.locked = true;
    if (intent.phase !== 'credentials-complete')
      await expect(
        resumeRemoval(setup.root, intent.requestId, true, { store }),
      ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(onboardingSnapshot(setup.root).removal?.requestId).toBe(intent.requestId);
    store.locked = false;
    await resumeRemoval(setup.root, intent.requestId, true, { store });
    expect(removalStatus(setup.root)).toBeNull();
    expect(records(setup.root)).toEqual([]);
    expect(credentialStatus(setup.root).cleanupPending).toBe(false);
    expect(store.values.get('unrelated-server-reference')).toBe('OTHER_SERVER_SECRET');
    expect(store.values.size).toBe(1);
    expect(readFileSync(join(setup.files, 'preserved-conflict'), 'utf8')).toBe(
      'LOCAL_CONTENT_SENTINEL',
    );
    expect(readFileSync(join(setup.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp\n');
  });
}
test('unpublished intent stages are not authority and malformed intent/cleanup values never escape diagnostics', async () => {
  const setup = fixture();
  await expect(
    disconnectConnections(setup.root, [setup.binding], true, {
      checkpoint(phase) {
        if (phase === 'removal-intent-staged') throw Error('stage cut');
      },
    }),
  ).rejects.toThrow('stage cut');
  expect(removalStatus(setup.root)).toBeNull();
  expect(records(setup.root)).toEqual([setup.binding]);
  await expect(
    removeServerConnection(setup.root, setup.serverId, true, {
      checkpoint(phase) {
        if (phase === 'removal-bindings') throw Error('published cut');
      },
    }),
  ).rejects.toThrow('published cut');
  const intent = removalStatus(setup.root)!;
  for (const mutate of [
    (value: unknown) => {
      (value as typeof intent).bindings[0]!.rootIdentity!.device = 123 as unknown as string;
    },
    (value: unknown) => {
      (value as typeof intent).bindings[0]!.rootIdentity!.inode = 456 as unknown as string;
    },
    (value: unknown) => {
      (value as typeof intent).credentialPaths.push('pending/abc.json');
    },
    (value: unknown) => {
      (value as typeof intent).credentialPaths.push(`keys/${setup.serverId}-abc.json`);
    },
    (value: unknown) => {
      (value as typeof intent).credentialPaths.push('servers/abc.json');
    },
  ]) {
    const changed = structuredClone(intent);
    mutate(changed);
    writeFileSync(join(setup.root, 'removal.json'), JSON.stringify(changed));
    expect(() => removalStatus(setup.root)).toThrow('unsafe or invalid');
  }
  writeFileSync(join(setup.root, 'removal.json'), JSON.stringify(intent));
  writeFileSync(join(setup.root, 'credential-cleanup.json'), '{"PRIVATE_PARSE_SENTINEL":', {
    mode: 0o600,
  });
  let failure: unknown;
  try {
    await resumeRemoval(setup.root, intent.requestId, true);
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: 'REMOVAL_INVALID' });
  expect(String(failure)).not.toContain('PRIVATE_PARSE_SENTINEL');
});

test('visible intent after interrupted publication is flushed before replay can delete a marker', async () => {
  const setup = fixture();
  await expect(
    disconnectConnections(setup.root, [setup.binding], true, {
      checkpoint(phase) {
        if (phase === 'removal-intent-published') throw Error('rename cut');
      },
    }),
  ).rejects.toThrow('rename cut');
  const pending = removalStatus(setup.root)!,
    journal = join(setup.root, 'removal.json'),
    native = filesystem.fsyncSync;
  const blocked = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === journal)
      throw Error('durability refused');
    native(fd);
  });
  try {
    await expect(resumeRemoval(setup.root, pending.requestId, true)).rejects.toThrow(
      'durability refused',
    );
  } finally {
    blocked.mockRestore();
  }
  expect(existsSync(join(setup.files, '.nanosync'))).toBe(true);
  const events: string[] = [];
  const trace = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    native(fd);
    events.push(filesystem.readlinkSync(`/proc/self/fd/${fd}`));
  });
  try {
    await expect(
      resumeRemoval(setup.root, pending.requestId, true, {
        checkpoint(phase) {
          if (phase === 'removal-marker') {
            events.push('marker-deleted');
            throw Error('marker cut');
          }
        },
      }),
    ).rejects.toThrow('marker cut');
  } finally {
    trace.mockRestore();
  }
  const journalSync = events.indexOf(journal),
    parentSync = events.indexOf(setup.root, journalSync + 1);
  expect(journalSync).toBeGreaterThanOrEqual(0);
  expect(parentSync).toBeGreaterThan(journalSync);
  expect(events.indexOf('marker-deleted')).toBeGreaterThan(parentSync);
});

test('retained cleanup journal is durably flushed before provider erasure on replay', async () => {
  const setup = fixture(),
    store = new Store();
  await migrateCredentials(setup.root, true, { store });
  const journal = join(setup.root, 'credential-cleanup.json'),
    native = filesystem.fsyncSync;
  const cut = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === setup.root && existsSync(journal))
      throw Error('cleanup publication cut');
    native(fd);
  });
  try {
    await expect(
      removeServerConnection(setup.root, setup.serverId, true, { store }),
    ).rejects.toThrow('cleanup publication cut');
  } finally {
    cut.mockRestore();
  }
  expect(store.values.size).toBe(2);
  const pending = removalStatus(setup.root)!,
    events: string[] = [],
    originalSet = store.set.bind(store);
  store.set = async (ref) => {
    if (ref.value.startsWith('nanosync-deleted:')) events.push('provider-erase');
    await originalSet(ref);
  };
  const trace = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    native(fd);
    events.push(filesystem.readlinkSync(`/proc/self/fd/${fd}`));
  });
  try {
    await resumeRemoval(setup.root, pending.requestId, true, { store });
  } finally {
    trace.mockRestore();
  }
  const journalSync = events.indexOf(journal),
    parentSync = events.indexOf(setup.root, journalSync + 1);
  expect(journalSync).toBeGreaterThanOrEqual(0);
  expect(parentSync).toBeGreaterThan(journalSync);
  expect(events.indexOf('provider-erase')).toBeGreaterThan(parentSync);
});

test('visible credentials-complete phase is made durable before retained cleanup inventory is unlinked', async () => {
  const setup = fixture(),
    store = new Store();
  await migrateCredentials(setup.root, true, { store });
  const journal = join(setup.root, 'removal.json'),
    cleanup = join(setup.root, 'credential-cleanup.json'),
    native = filesystem.fsyncSync;
  const cut = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    if (
      filesystem.readlinkSync(`/proc/self/fd/${fd}`) === setup.root &&
      existsSync(journal) &&
      JSON.parse(readFileSync(journal, 'utf8')).phase === 'credentials-complete'
    )
      throw Error('complete publication cut');
    native(fd);
  });
  try {
    await expect(
      removeServerConnection(setup.root, setup.serverId, true, { store }),
    ).rejects.toThrow('complete publication cut');
  } finally {
    cut.mockRestore();
  }
  expect(existsSync(cleanup)).toBe(true);
  const pending = removalStatus(setup.root)!;
  const events: string[] = [],
    nativeUnlink = filesystem.unlinkSync;
  const trace = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
    native(fd);
    events.push(filesystem.readlinkSync(`/proc/self/fd/${fd}`));
  });
  const unlinks = spyOn(filesystem, 'unlinkSync').mockImplementation((path) => {
    if (path === cleanup) events.push('cleanup-unlinked');
    nativeUnlink(path);
  });
  store.locked = true;
  try {
    await resumeRemoval(setup.root, pending.requestId, true, { store });
  } finally {
    trace.mockRestore();
    unlinks.mockRestore();
  }
  const journalSync = events.indexOf(journal),
    parentSync = events.indexOf(setup.root, journalSync + 1);
  expect(journalSync).toBeGreaterThanOrEqual(0);
  expect(parentSync).toBeGreaterThan(journalSync);
  expect(events.indexOf('cleanup-unlinked')).toBeGreaterThan(parentSync);
});

for (const leaf of ['root', 'records'] as const) {
  test(`replay fsyncs already absent ${leaf} entries after unlink-to-fsync failure`, async () => {
    const setup = fixture(),
      directory = leaf === 'root' ? setup.files : join(setup.root, 'connections');
    const target =
      leaf === 'root'
        ? join(setup.files, '.nanosync')
        : join(directory, `${setup.binding.connectionId}.json`);
    const native = filesystem.fsyncSync;
    const failure = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
      if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === directory && !existsSync(target))
        throw Error('fsync cut');
      native(fd);
    });
    try {
      await expect(disconnectConnections(setup.root, [setup.binding], true)).rejects.toThrow(
        'fsync cut',
      );
    } finally {
      failure.mockRestore();
    }
    expect(existsSync(target)).toBe(false);
    const pending = removalStatus(setup.root)!;
    let flushed = false;
    const replay = spyOn(filesystem, 'fsyncSync').mockImplementation((fd) => {
      if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === directory) flushed = true;
      native(fd);
    });
    try {
      await resumeRemoval(setup.root, pending.requestId, true);
    } finally {
      replay.mockRestore();
    }
    expect(flushed).toBe(true);
    expect(removalStatus(setup.root)).toBeNull();
  });
}

test('all replica locks precede intent; contention preserves every binding even with force', async () => {
  const setup = fixture(),
    secondRoot = join(setup.base, 'second');
  mkdirSync(secondRoot);
  const second = createConnection(
    setup.root,
    secondRoot,
    setup.serverId,
    setup.vaultId,
    setup.deviceId,
  );
  const release = acquireSyncLock(join(setup.root, 'replicas', second.connectionId));
  try {
    await expect(removeServerConnection(setup.root, setup.serverId, true)).rejects.toThrow(
      'live process',
    );
  } finally {
    release();
  }
  expect(removalStatus(setup.root)).toBeNull();
  expect(records(setup.root)).toHaveLength(2);
  expect(existsSync(join(setup.files, '.nanosync'))).toBe(true);
  expect(existsSync(join(secondRoot, '.nanosync'))).toBe(true);
});
test('dirty unscanned content requires force; missing root and foreign replacement are never empty inventories', async () => {
  const setup = fixture();
  expect(
    (await inspectRemoval(setup.root, { binding: setup.binding.connectionId })).bindings[0]?.dirty,
  ).toBe(true);
  await expect(disconnectConnections(setup.root, [setup.binding])).rejects.toMatchObject({
    code: 'UNSYNCED_WORK',
  });
  expect(removalStatus(setup.root)).toBeNull();
  renameSync(setup.files, setup.files + '-saved');
  await expect(disconnectConnections(setup.root, [setup.binding])).rejects.toMatchObject({
    code: 'FOLDER_UNAVAILABLE',
  });
  mkdirSync(setup.files);
  copyFileSync(join(setup.files + '-saved', '.nanosync'), join(setup.files, '.nanosync'));
  await expect(disconnectConnections(setup.root, [setup.binding], true)).rejects.toMatchObject({
    code: 'FOLDER_UNAVAILABLE',
  });
  rmSync(setup.files, { recursive: true });
  await disconnectConnections(setup.root, [setup.binding], true);
  expect(existsSync(setup.files)).toBe(false);
  expect(existsSync(join(setup.files + '-saved', 'preserved-conflict'))).toBe(true);
});
test('partial removal refuses foreign markers, records and replacement roots without dropping recovery', async () => {
  const setup = fixture();
  await expect(
    disconnectConnections(setup.root, [setup.binding], true, {
      checkpoint(phase) {
        if (phase === 'removal-marker') throw Error('cut');
      },
    }),
  ).rejects.toThrow('cut');
  const intent = removalStatus(setup.root)!;
  writeFileSync(
    join(setup.files, '.nanosync'),
    JSON.stringify({ version: 1, connectionId: randomUUID() }),
    { mode: 0o600 },
  );
  const foreign = readFileSync(join(setup.files, '.nanosync'));
  await expect(resumeRemoval(setup.root, intent.requestId, true)).rejects.toThrow('Foreign marker');
  expect(readFileSync(join(setup.files, '.nanosync'))).toEqual(foreign);
  expect(removalStatus(setup.root)?.requestId).toBe(intent.requestId);
  rmSync(join(setup.files, '.nanosync'));
  renameSync(setup.files, setup.files + '-saved');
  symlinkSync(setup.files + '-saved', setup.files);
  await expect(resumeRemoval(setup.root, intent.requestId, true)).rejects.toThrow('symlinks');
  expect(onboardingSnapshot(setup.root).removal?.requestId).toBe(intent.requestId);
});
test('removal never overwrites concurrent independent pause intent and ignores --yes as abandonment', async () => {
  const setup = fixture();
  setPaused(setup.root, { binding: setup.binding.connectionId }, true);
  await disconnectConnections(setup.root, [setup.binding], true, {
    checkpoint(phase) {
      if (phase === 'removal-intent') setPaused(setup.root, { all: true }, true);
    },
  });
  expect(readSettings(setup.root)).toMatchObject({
    globalPaused: true,
    bindingPaused: { [setup.binding.connectionId]: true },
  });
});
