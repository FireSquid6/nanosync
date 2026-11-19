import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  watch,
  renameSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeCredentials,
  clientStatus,
  readPreferences,
  pendingEnrollments,
  records,
  openBoundSync,
  type CredentialStore,
} from '@nanosync/client-service';
import { createDesktopBackend, validateCommand, safeDesktopError } from '../src/backend';
import type { DesktopCommand, DesktopReply } from '../src/rpc';
import { provisionLocalVault } from '../../../packages/cli/src/local-provision';
import {
  runServer,
  approveLocalDevice,
  initializeServerOwner,
} from '../../../packages/cli/src/server';

class MemoryStore implements CredentialStore {
  values = new Map<string, string>();
  locked = false;
  async get(ref: { name: string }) {
    return this.locked ? null : (this.values.get(ref.name) ?? null);
  }
  async set(ref: { name: string; value: string }) {
    if (this.locked) throw Error('native-secret');
    this.values.set(ref.name, ref.value);
  }
  async delete(ref: { name: string }) {
    return this.locked ? false : this.values.delete(ref.name);
  }
}
function successful(reply: DesktopReply) {
  if (!reply.ok) throw Error(`${reply.code}: ${reply.message}`);
  return reply;
}
const capabilities = {
  protocolVersions: [1],
  revisionFormatVersions: [1],
  objectFormatVersions: [1],
  objectTypes: ['manifest'],
  webAdministration: { enabled: true, url: 'https://example.test/admin' },
  limits: {
    maximumObjectCiphertextBytes: 8192,
    maximumReferencesPerRevision: 1,
    maximumParents: 1,
    maximumPresenceQuery: 1,
    maximumPageSize: 1,
    maximumJsonMetadataBytes: 1024,
    maximumIdempotencyKeyLength: 32,
    chunkSizeBytes: 4194304,
  },
};
function enroll(url: string): DesktopCommand {
  return {
    type: 'enroll',
    url,
    alias: 'test',
    deviceName: 'test-device',
    password: 'password-sentinel',
    fresh: false,
    retryCredentialWrite: false,
  };
}

test('RPC schemas reject malformed, oversized, extra-key and arbitrary filesystem/native commands; errors never reflect data', () => {
  for (const value of [
    null,
    [],
    {},
    { type: 'constructor' },
    { type: 'snapshot', root: '/tmp' },
    { type: 'start', binding: 'not-an-id' },
    { type: 'initialize', mode: 'protected-file' },
    { type: 'migrate', confirmed: false },
    { type: 'administration', urlIdentity: 'x', command: 'sh' },
    {
      type: 'settings',
      lifecycle: { startAtLogin: true, trayEnabled: null, keepSyncingAfterClose: true },
      expectedRevision: 0,
    },
    { ...enroll('https://example.test'), password: 'x'.repeat(17000) },
  ])
    expect(() => validateCommand(value)).toThrow();
  for (const error of [
    Error('password-sentinel'),
    Object.assign(Error('password-sentinel'), { code: 'password-sentinel' }),
    Object.assign(Error('password-sentinel'), { code: 'UNAVAILABLE' }),
  ])
    expect(JSON.stringify(safeDesktopError(error))).not.toContain('password-sentinel');
});
test('real HTTP enrollment resumes after restart, external admin is capability-only and cancellation preserves identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-desktop-enroll-')),
    store = new MemoryStore();
  let passwordCalls = 0,
    approved = false,
    delay = false;
  const received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/auth/password') {
        passwordCalls++;
        return Response.json({ sessionToken: 'A'.repeat(43) });
      }
      if (path === '/v1/capabilities') return Response.json(capabilities);
      if (delay) {
        received.resolve();
        await release.promise;
      }
      return Response.json({ status: approved ? 'approved' : 'pending' });
    },
  });
  const opened: string[] = [];
  const native = {
    async pickFolder() {
      return [];
    },
    async openAdministration(url: string) {
      opened.push(url);
      return { ok: true };
    },
    quit() {},
  };
  const first = createDesktopBackend(root, native, { store });
  try {
    successful(await first.execute({ type: 'initialize' }));
    const command = enroll(http.url.host);
    let reply = successful(await first.execute(command));
    expect(command).toMatchObject({ password: '' });
    const before = pendingEnrollments(root)[0]!;
    expect(reply.snapshot.pending[0]).toMatchObject({
      status: 'pending',
      deviceId: before.deviceId,
    });
    expect(reply.enrollment).toMatchObject({
      status: 'pending',
      url: http.url.href.replace(/\/$/, ''),
      alias: 'test',
    });
    expect(JSON.stringify(reply)).not.toContain(before.fingerprint);
    expect(JSON.stringify(reply)).not.toContain('A'.repeat(43));
    expect(JSON.stringify(reply)).not.toContain('password-sentinel');
    expect(
      (await first.execute({ type: 'administration', urlIdentity: 'https://evil.test/admin' })).ok,
    ).toBe(false);
    successful(
      await first.execute({
        type: 'administration',
        urlIdentity: http.url.href.replace(/\/$/, ''),
      }),
    );
    expect(opened).toEqual(['https://example.test/admin']);
    await first.shutdown();
    const second = createDesktopBackend(root, native, { store });
    reply = successful(await second.execute({ type: 'snapshot' }));
    expect(reply.snapshot.pending[0]?.deviceId).toBe(before.deviceId);
    expect(reply.snapshot.administration).toEqual([]);
    delay = true;
    const resumed = second.execute({ ...enroll(http.url.href), password: '' });
    await received.promise;
    await second.execute({ type: 'cancel-enrollment' });
    release.resolve();
    expect(await resumed).toMatchObject({ ok: false, code: 'INTERRUPTED' });
    expect(pendingEnrollments(root)[0]).toEqual(before);
    delay = false;
    approved = true;
    reply = successful(await second.execute({ ...enroll(http.url.href), password: '' }));
    expect(reply.snapshot.pending).toEqual([]);
    expect(reply.snapshot.connections[0]).toMatchObject({
      deviceId: before.deviceId,
      serverId: before.serverId,
    });
    expect(passwordCalls).toBe(1);
    reply = successful(
      await second.execute({
        ...enroll(http.url.href),
        alias: 'different-entered-alias',
        password: '',
      }),
    );
    expect(reply.enrollment).toEqual({
      status: 'approved',
      alias: 'test',
      url: before.url,
      deviceId: before.deviceId,
      serverId: before.serverId,
    });
    expect(reply.snapshot.connections).toHaveLength(1);
    expect(records(root)).toEqual([]);
    expect(passwordCalls).toBe(1);
    await second.shutdown();
  } finally {
    release.resolve();
    http.stop(true);
    await first.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
});
test('Quit drains an uncancellable credential write before native exit and cancels later enrollment requests', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-desktop-quit-write-')),
    store = new MemoryStore();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const write = store.set.bind(store);
  let completed = false,
    quitCalled = false;
  store.set = async (value) => {
    entered.resolve();
    await release.promise;
    await write(value);
    completed = true;
  };
  const calls: string[] = [];
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      calls.push(new URL(request.url).pathname);
      return Response.json({ sessionToken: 'A'.repeat(43) });
    },
  });
  const backend = createDesktopBackend(
    root,
    {
      async pickFolder() {
        return [];
      },
      async openAdministration() {
        return { ok: true };
      },
      quit() {
        expect(completed).toBe(true);
        quitCalled = true;
      },
    },
    { store },
  );
  try {
    successful(await backend.execute({ type: 'initialize' }));
    const command = enroll(http.url.href);
    const submitting = backend.execute(command);
    await entered.promise;
    const quitting = backend.execute({ type: 'quit' });
    expect(quitCalled).toBe(false);
    release.resolve();
    expect(await submitting).toMatchObject({ ok: false, code: 'INTERRUPTED' });
    successful(await quitting);
    expect(quitCalled).toBe(true);
    expect(command).toMatchObject({ password: '' });
    expect(calls).toEqual(['/v1/auth/password']);
  } finally {
    release.resolve();
    await backend.shutdown();
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
test('file-backed root decision and picker cancellation leave state unchanged; locked keys are not recovery requests', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ns-desktop-decision-')),
    root = join(parent, 'client');
  const backend = createDesktopBackend(
    root,
    {
      async pickFolder() {
        return [];
      },
      async openAdministration() {
        return { ok: true };
      },
      quit() {},
    },
    { store: new MemoryStore() },
  );
  try {
    successful(await backend.execute({ type: 'snapshot' }));
    expect(existsSync(root)).toBe(false);
    initializeCredentials(root, 'protected-file');
    const before = readdirSync(root);
    expect(await backend.execute(enroll('https://example.test'))).toMatchObject({
      ok: false,
      code: 'CREDENTIAL_DECISION_REQUIRED',
    });
    expect(readdirSync(root)).toEqual(before);
    successful(await backend.execute({ type: 'migrate', confirmed: true }));
    expect(successful(await backend.execute({ type: 'pick-folder' })).cancelled).toBe(true);
    expect(records(root)).toEqual([]);
  } finally {
    await backend.shutdown();
    rmSync(parent, { recursive: true, force: true });
  }
});
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw Error('port unavailable');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
function observed(
  root: string,
  binding: string,
  predicate: (value: ReturnType<typeof clientStatus>['bindings'][number]) => boolean,
) {
  const done = Promise.withResolvers<void>();
  const watcher = watch(join(root, 'replicas', binding), () => check());
  function check() {
    const value = clientStatus(root).bindings.find((item) => item.connectionId === binding);
    if (value && predicate(value)) {
      watcher.close();
      done.resolve();
    }
  }
  check();
  return { promise: done.promise, close: () => watcher.close() };
}
test('real vault recovery, nonempty connect without transfer, explicit continuous Start, duplicate Start, restart and independent CLI ownership', async () => {
  const parent = mkdtempSync(join(tmpdir(), 'ns-desktop-sync-')),
    serverRoot = join(parent, 'server'),
    bootstrapRoot = join(parent, 'bootstrap'),
    root = join(parent, 'client'),
    files = join(parent, 'files');
  const { mkdirSync } = await import('node:fs');
  for (const directory of [serverRoot, bootstrapRoot, root, files])
    mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(serverRoot, 'pepper.hex'), 'a'.repeat(64), { mode: 0o600 });
  let recovery = '';
  await initializeServerOwner(serverRoot, 'owner-password');
  await provisionLocalVault(serverRoot, 'test-vault', async (value) => {
    recovery = value;
  });
  const http = await runServer({
    directory: serverRoot,
    port: await freePort(),
    scanIntervalMs: 3600000,
  });
  const store = new MemoryStore();
  const native = {
    async pickFolder() {
      return [files];
    },
    async openAdministration() {
      return { ok: true };
    },
    quit() {},
  };
  let backend = createDesktopBackend(root, native, { store });
  let observer: ReturnType<typeof observed> | undefined;
  let cli: Awaited<ReturnType<typeof openBoundSync>> | undefined;
  let cliWatch: Promise<void> | undefined;
  const cliController = new AbortController();
  try {
    successful(await backend.execute({ type: 'initialize' }));
    successful(await backend.execute({ ...enroll(http.url), password: 'owner-password' }));
    approveLocalDevice(serverRoot, pendingEnrollments(root)[0]!.deviceId);
    const approved = successful(await backend.execute({ ...enroll(http.url), password: '' }));
    const serverId = approved.snapshot.connections[0]!.serverId;
    const vaultId = successful(await backend.execute({ type: 'vaults', serverId })).vaults![0]!
      .vaultId;
    expect(
      successful(await backend.execute({ type: 'key-status', serverId, vaultId })).key,
    ).toEqual({ keyRequired: true, credentialWritePending: false });
    const unlock: DesktopCommand = {
      type: 'unlock',
      serverId,
      vaultId,
      recovery,
      retryCredentialWrite: false,
    };
    expect(successful(await backend.execute(unlock)).key?.keyRequired).toBe(false);
    expect(unlock).toMatchObject({ recovery: '' });
    store.locked = true;
    expect(await backend.execute({ type: 'key-status', serverId, vaultId })).toMatchObject({
      ok: false,
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    store.locked = false;
    writeFileSync(join(files, 'existing.txt'), 'existing local bytes');
    let folder = successful(await backend.execute({ type: 'pick-folder' })).folder!;
    expect(folder.nonempty).toBe(true);
    expect(
      await backend.execute({
        type: 'connect',
        serverId,
        vaultId,
        selection: randomUUID(),
        confirmNonempty: true,
      }),
    ).toMatchObject({ ok: false, code: 'SELECTION_CHANGED' });
    renameSync(files, files + '-original');
    mkdirSync(files, { mode: 0o700 });
    expect(
      await backend.execute({
        type: 'connect',
        serverId,
        vaultId,
        selection: folder.selection,
        confirmNonempty: true,
      }),
    ).toMatchObject({ ok: false, code: 'SELECTION_CHANGED' });
    rmSync(files, { recursive: true });
    renameSync(files + '-original', files);
    folder = successful(await backend.execute({ type: 'pick-folder' })).folder!;
    expect(
      await backend.execute({
        type: 'connect',
        serverId,
        vaultId,
        selection: folder.selection,
        confirmNonempty: false,
      }),
    ).toMatchObject({ ok: false, code: 'NONEMPTY_CONFIRMATION' });
    const connect: DesktopCommand = {
      type: 'connect',
      serverId,
      vaultId,
      selection: folder.selection,
      confirmNonempty: true,
    };
    const binding = successful(await backend.execute(connect)).binding!;
    expect(successful(await backend.execute(connect)).binding).toBe(binding);
    expect(records(root)).toHaveLength(1);
    expect(readFileSync(join(files, 'existing.txt'), 'utf8')).toBe('existing local bytes');
    expect(existsSync(join(root, 'replicas', binding, 'local.sqlite'))).toBe(false);
    expect(clientStatus(root).bindings[0]?.phase).toBe('not-started');
    expect(readPreferences(root).continuousRequested).toEqual({});
    await backend.shutdown();
    backend = createDesktopBackend(root, native, { store });
    await backend.resumeDesktopWork();
    expect(clientStatus(root).bindings[0]?.phase).toBe('not-started');
    observer = observed(root, binding, (item) => item.upToDate);
    const replies = await Promise.all([
      backend.execute({ type: 'start', binding }),
      backend.execute({ type: 'start', binding }),
    ]);
    expect(replies.every((reply) => reply.ok && reply.started)).toBe(true);
    await observer.promise;
    const sequence = clientStatus(root).bindings[0]!.facts!.heads.applied.sequence;
    observer = observed(
      root,
      binding,
      (item) => item.upToDate && item.facts!.heads.applied.sequence > sequence,
    );
    writeFileSync(join(files, 'subsequent.txt'), 'continuous watch change');
    await observer.promise;
    expect(readPreferences(root).continuousRequested[binding]).toBe('desktop');
    await backend.shutdown();
    expect(clientStatus(root).bindings[0]?.ownerPresent).toBe(false);
    backend = createDesktopBackend(root, native, { store });
    observer = observed(root, binding, (item) => item.upToDate && item.owner?.origin === 'desktop');
    await backend.resumeDesktopWork();
    await observer.promise;
    await backend.shutdown();
    cli = await openBoundSync(root, files, { store, origin: 'cli', instanceId: randomUUID() });
    backend = createDesktopBackend(root, native, { store });
    expect(await backend.execute({ type: 'start', binding })).toMatchObject({
      ok: false,
      code: 'OWNER_TEMPORARY',
    });
    expect(clientStatus(root).bindings[0]?.owner?.origin).toBe('cli');
    const ready = Promise.withResolvers<void>();
    cliWatch = cli.watch(
      cliController.signal,
      () => {},
      () => {},
      ready.resolve,
    );
    await ready.promise;
    successful(await backend.execute({ type: 'start', binding }));
    expect(readPreferences(root).continuousRequested[binding]).toBe('cli');
    await backend.shutdown();
    expect(clientStatus(root).bindings[0]?.ownerPresent).toBe(true);
    cliController.abort();
    await cliWatch;
    backend = createDesktopBackend(root, native, { store });
    await backend.resumeDesktopWork();
    expect(clientStatus(root).bindings[0]?.ownerPresent).toBe(false);
  } finally {
    observer?.close();
    cliController.abort();
    await cliWatch;
    await cli?.close();
    await backend.shutdown();
    await http.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});
