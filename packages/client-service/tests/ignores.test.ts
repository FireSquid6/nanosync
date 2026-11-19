import { afterEach, expect, spyOn, test } from 'bun:test';
import * as filesystem from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ClientLocal } from '@nanosync/client-local';
import { IgnoreRules, saveIgnoreFile, LinuxScanner } from '@nanosync/linux-client';
import {
  initializeCredentials,
  createConnection,
  privateDirectory,
  secureCreate,
  setIgnores,
  viewIgnores,
  validateIgnoreText,
  openBoundSync,
  observeSyncLock,
  setPaused,
  readSettings,
  readPreferences,
} from '../src/index.ts';
import { SyncRunner } from '../src/sync-runner.ts';
import { clientStatus, readObservation, writeObservation } from '../src/status.ts';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(url = 'http://localhost:1') {
  const base = mkdtempSync(join(tmpdir(), 'ns-ignores-'));
  roots.push(base);
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
      baseUrl: url.replace(/\/$/, ''),
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
  const binding = createConnection(root, files, serverId, vaultId, deviceId),
    replica = join(root, 'replicas', binding.connectionId);
  return { base, root, files, binding, replica };
}
test('pure validation retains exact exclusions dialect and never echoes patterns', () => {
  for (const text of ['', '# comment\r\n*.tmp\r\n/build/\nproject/**/cache/?', 'a'.repeat(65536)])
    expect(validateIgnoreText(text)).toEqual({ valid: true });
  for (const text of [
    '!PRIVATE_PATTERN_SENTINEL',
    '[private]',
    'a\\b',
    'a/***/b',
    '../a',
    'a//b',
    'a'.repeat(65537),
    '\ud800',
  ]) {
    const result = validateIgnoreText(text);
    expect(result.valid).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE_PATTERN_SENTINEL');
  }
});
test('safe staged CAS preserves another editor, rejects unsafe stages and reserves only exact root control family', () => {
  const setup = fixture(),
    path = join(setup.files, '.nanosyncignore');
  expect(viewIgnores(setup.root, setup.files).fileSignature).toBe('absent');
  expect(() =>
    saveIgnoreFile(setup.files, '*.tmp', 'absent', (phase) => {
      if (phase === 'ignore-staged') writeFileSync(path, '# another editor\n', { mode: 0o600 });
    }),
  ).toThrow('changed');
  expect(readFileSync(path, 'utf8')).toBe('# another editor\n');
  expect(readdirSync(setup.files).filter((name) => name.endsWith('.stage'))).toEqual([]);
  const stage = `.nanosyncignore.${'a'.repeat(32)}.stage`;
  writeFileSync(join(setup.files, stage), '', { mode: 0o600 });
  const rules = new IgnoreRules(setup.files);
  expect(rules.ignores(stage)).toBe(true);
  expect(rules.ignores('nested/' + stage)).toBe(false);
  expect(rules.ignores('.nanosync-arbitrary')).toBe(false);
  saveIgnoreFile(setup.files, '', rules.signature);
  expect(existsSync(join(setup.files, stage))).toBe(false);
  symlinkSync(path, join(setup.files, stage));
  expect(() =>
    saveIgnoreFile(setup.files, '# next', new IgnoreRules(setup.files).signature),
  ).toThrow('unsafe ignore stage');
  expect(lstatSync(join(setup.files, stage)).isSymbolicLink()).toBe(true);
});
test('unowned save needs no credentials or journal creation, is signature checked and preserves pauses', async () => {
  const setup = fixture();
  setPaused(setup.root, { all: true }, true);
  setPaused(setup.root, { binding: setup.binding.connectionId }, true);
  const before = readSettings(setup.root);
  await setIgnores(setup.root, setup.files, {
    text: '*.tmp\n',
    expectedFileSignature: 'absent',
  });
  expect(readSettings(setup.root)).toEqual(before);
  expect(existsSync(join(setup.replica, 'local.sqlite'))).toBe(false);
  await expect(
    setIgnores(setup.root, setup.files, {
      text: '# stale',
      expectedFileSignature: 'absent',
    }),
  ).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(readFileSync(join(setup.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp\n');
});
test('full-content removal inventory streams and yields each bounded chunk instead of freezing large-file work', async () => {
  const setup = fixture(),
    bytes = Buffer.alloc(1024 * 1024, 7),
    revision = randomUUID();
  writeFileSync(join(setup.files, 'large'), bytes);
  const local = new ClientLocal(setup.replica, setup.binding.vaultId, setup.binding.deviceId);
  try {
    local.upsertEntry({
      id: randomUUID(),
      path: 'large',
      kind: 'file',
      fingerprint: createHash('sha256').update(bytes).digest('hex'),
      hydration: 'downloaded',
      revision,
      executable: 0,
    });
    let yields = 0;
    expect(
      await new LinuxScanner(setup.files, local).hasUnsyncedChanges(async () => {
        yields++;
      }),
    ).toBe(false);
    expect(yields).toBeGreaterThanOrEqual(bytes.length / 65536);
    writeFileSync(join(setup.files, 'large'), Buffer.alloc(bytes.length, 8));
    expect(await new LinuxScanner(setup.files, local).hasUnsyncedChanges(async () => {})).toBe(
      true,
    );
  } finally {
    local.close();
  }
});

test('pending durable apply refuses new ignore basis even with paused and inactive owner', async () => {
  const setup = fixture();
  const local = new ClientLocal(setup.replica, setup.binding.vaultId, setup.binding.deviceId),
    revision = randomUUID();
  local.recordHead('accepted', { revisionId: revision, sequence: 1 });
  local.prepareApply(randomUUID(), revision, 1, '{}');
  local.close();
  await expect(
    setIgnores(setup.root, setup.files, {
      text: '*.tmp',
      expectedFileSignature: 'absent',
    }),
  ).rejects.toMatchObject({ code: 'IGNORE_RECOVERY_REQUIRED' });
  expect(existsSync(join(setup.files, '.nanosyncignore'))).toBe(false);
});
test('live CLI owner retains origin/lock while authenticated save handles full 64KiB and escaped JSON', async () => {
  const setup = fixture(),
    instanceId = randomUUID();
  const owner = await openBoundSync(setup.root, setup.files, {
    origin: 'cli',
    instanceId,
  });
  try {
    const lock = observeSyncLock(setup.replica)!,
      metadata = readFileSync(join(setup.replica, '.sync-control'));
    const text = '#' + '\t'.repeat(65535);
    await setIgnores(setup.root, setup.files, {
      text,
      expectedFileSignature: 'absent',
    });
    expect(readFileSync(join(setup.files, '.nanosyncignore'), 'utf8')).toBe(text);
    expect(observeSyncLock(setup.replica)?.inode).toEqual(lock.inode);
    expect(readFileSync(join(setup.replica, '.sync-control'))).toEqual(metadata);
    expect(readPreferences(setup.root).continuousRequested).toEqual({});
  } finally {
    await owner.close();
  }
});
test('coordinated edit preserves CLI continuous provenance and a concurrent user pause blocks subsequent work', async () => {
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    },
  });
  const setup = fixture(http.url.href),
    controller = new AbortController();
  const owner = await openBoundSync(setup.root, setup.files, {
    origin: 'cli',
    instanceId: randomUUID(),
  });
  const watching = owner.watch(
    controller.signal,
    () => {},
    () => {},
  );
  try {
    await entered.promise;
    const saving = setIgnores(setup.root, setup.files, {
      text: '*.tmp',
      expectedFileSignature: 'absent',
    });
    setPaused(setup.root, { all: true }, true);
    release.resolve();
    await saving;
    expect(readPreferences(setup.root).continuousRequested[setup.binding.connectionId]).toBe('cli');
    expect(readSettings(setup.root).globalPaused).toBe(true);
    await expect(owner.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
    expect(observeSyncLock(setup.replica)?.live).toBe(true);
  } finally {
    controller.abort();
    release.resolve();
    await watching;
    await owner.close();
    http.stop(true);
  }
});

test('stop retains ownership until active work and admitted maintenance settle', async () => {
  const setup = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const runner = SyncRunner.start({
    clientDirectory: setup.replica,
    syncDirectory: setup.files,
    vaultId: setup.binding.vaultId,
    deviceId: setup.binding.deviceId,
    masterKey: new Uint8Array(32).fill(1),
    baseUrl: 'https://example.test',
    token: 'A'.repeat(43),
    async fetch() {
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    },
  });
  const active = runner.syncOnce().catch(() => {});
  await entered.promise;
  const saving = runner.saveIgnores('*.tmp', 'absent', () => {}).catch((error) => error);
  const stopped = runner.stop();
  expect(observeSyncLock(setup.replica)?.live).toBe(true);
  release.resolve();
  await active;
  expect(await saving).toMatchObject({ code: 'OWNER_STOPPED' });
  await stopped;
  expect(observeSyncLock(setup.replica)).toBeNull();
  expect(existsSync(join(setup.files, '.nanosyncignore'))).toBe(false);
});

test('maintenance waits active work without deadlocking its checkpoints, blocks new admission and stop awaits it', async () => {
  const setup = fixture(),
    entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  let requests = 0;
  const runner = SyncRunner.start({
    clientDirectory: setup.replica,
    syncDirectory: setup.files,
    vaultId: setup.binding.vaultId,
    deviceId: setup.binding.deviceId,
    masterKey: new Uint8Array(32).fill(1),
    baseUrl: 'https://example.test',
    token: 'A'.repeat(43),
    async fetch() {
      requests++;
      entered.resolve();
      await release.promise;
      return new Response(null, { status: 503 });
    },
  });
  const active = runner.syncOnce().catch(() => {});
  await entered.promise;
  const saving = runner.saveIgnores('*.tmp', 'absent', () => {
    setPaused(setup.root, { all: true }, true);
  });
  const queued = runner.syncOnce().catch(() => {});
  expect(requests).toBe(1);
  expect(existsSync(join(setup.files, '.nanosyncignore'))).toBe(false);
  release.resolve();
  await active;
  await saving;
  expect(readFileSync(join(setup.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp');
  await runner.stop();
  await queued;
  expect(observeSyncLock(setup.replica)).toBeNull();
  expect(readSettings(setup.root).globalPaused).toBe(true);
});

test('a post-rename ignore failure durably invalidates an earlier verified observation', async () => {
  const setup = fixture();
  const local = new ClientLocal(setup.replica, setup.binding.vaultId, setup.binding.deviceId);
  const head = { revisionId: randomUUID(), sequence: 1 };
  for (const kind of ['observed', 'accepted', 'applied'] as const) local.recordHead(kind, head);
  local.close();
  const runner = SyncRunner.start({
    clientDirectory: setup.replica, syncDirectory: setup.files,
    vaultId: setup.binding.vaultId, deviceId: setup.binding.deviceId,
    masterKey: new Uint8Array(32).fill(1), baseUrl: 'http://localhost:1', token: 'A'.repeat(43),
    owner: { origin: 'cli', instanceId: randomUUID() },
  });
  const observation = readObservation(setup.replica)!;
  observation.verified = true;
  writeObservation(setup.replica, observation);
  expect(clientStatus(setup.root).bindings[0]!.upToDate).toBe(true);
  const nativeSync = filesystem.fsyncSync;
  const failure = spyOn(filesystem, 'fsyncSync').mockImplementation(fd => {
    if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === setup.files)
      throw new Error('ignore directory fsync failed');
    nativeSync(fd);
  });
  try {
    await expect(runner.saveIgnores('*.tmp', 'absent', () => {})).rejects.toThrow('ignore directory fsync failed');
    expect(readFileSync(join(setup.files, '.nanosyncignore'), 'utf8')).toBe('*.tmp');
    expect(readObservation(setup.replica)!.verified).toBe(false);
    expect(clientStatus(setup.root).bindings[0]!.upToDate).toBe(false);
    expect(observeSyncLock(setup.replica)?.live).toBe(true);
  } finally {
    failure.mockRestore();
    await runner.stop();
  }
});
