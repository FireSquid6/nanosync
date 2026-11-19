import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtempSync, mkdirSync, renameSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  initializeCredentials,
  privateDirectory,
  secureCreate,
  connectRegisteredVault,
  migrateCredentials,
  readPreferences,
  openBoundSync,
  clientStatus,
  pendingEnrollments,
  type CredentialStore,
} from '@nanosync/client-service';
import { createDesktopBackend } from '../src/backend';
import type { DesktopReply } from '../src/rpc';
import {
  initializeServerOwner,
  runServer,
  approveLocalDevice,
} from '../../../packages/cli/src/server';
import { provisionLocalVault } from '../../../packages/cli/src/local-provision';
class Store implements CredentialStore {
  values = new Map<string, string>();
  locked = false;
  reads = 0;
  async get(ref: { name: string }) {
    this.reads++;
    return this.locked ? null : (this.values.get(ref.name) ?? null);
  }
  async set(ref: { name: string; value: string }) {
    this.values.set(ref.name, ref.value);
  }
  async delete(ref: { name: string }) {
    return this.values.delete(ref.name);
  }
}
function ok(reply: DesktopReply) {
  if (!reply.ok) throw Error(`${reply.code}: ${reply.message}`);
  return reply;
}
test('folder RPC payloads reject paths, unknown bindings, invalid booleans and revisions before native dispatch', async () => {
  const parent = mkdtempSync('/tmp/ns-folder-rpc-'),
    root = join(parent, 'missing');
  const backend = createDesktopBackend(
    root,
    {
      async pickFolder() {
        throw Error('not called');
      },
      async openAdministration() {
        throw Error('not called');
      },
      quit() {
        throw Error('not called');
      },
    },
    { store: new Store() },
  );
  try {
    for (const command of [
      { type: 'sync-now', binding: randomUUID(), path: '/etc' },
      { type: 'open-folder', binding: 'invalid' },
      { type: 'pause-all', paused: 'false', expectedRevision: 0 },
      { type: 'pause-folder', binding: randomUUID(), paused: false, expectedRevision: -1 },
      { type: 'pause-folder', binding: randomUUID(), paused: false },
    ])
      expect(await backend.execute(command)).toMatchObject({ ok: false, code: 'INVALID_INPUT' });
    expect(await backend.execute({ type: 'open-folder', binding: randomUUID() })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(
      await backend.execute({
        type: 'pause-folder',
        binding: randomUUID(),
        paused: true,
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, code: 'NOT_FOUND' });
    expect(existsSync(root)).toBe(false);
  } finally {
    await backend.shutdown();
    rmSync(parent, { recursive: true, force: true });
  }
});
async function copies(url = 'http://127.0.0.1:1') {
  const parent = mkdtempSync('/tmp/ns-folders-'),
    root = join(parent, 'client');
  const first = join(parent, 'first'),
    second = join(parent, 'second');
  for (const path of [root, first, second]) mkdirSync(path, { mode: 0o700 });
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
      name: 'home',
      baseUrl: url.replace(/\/$/, ''),
      token: 'A'.repeat(43),
    }),
  );
  secureCreate(
    join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`),
    JSON.stringify({ version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32) }),
  );
  const bindings = [first, second].map((path) =>
    connectRegisteredVault(root, path, serverId, vaultId, deviceId),
  );
  const store = new Store();
  return { parent, root, first, second, bindings, store, vaultId, serverId };
}
test('protected/locked metadata, multiple copies, independent CAS pauses and checked open never probe credentials', async () => {
  const f = await copies(),
    opened: string[] = [];
  const backend = createDesktopBackend(
    f.root,
    {
      async pickFolder() {
        return [];
      },
      async openAdministration() {
        return { ok: true };
      },
      async openFolder(path) {
        opened.push(path);
        return { ok: true };
      },
      quit() {},
    },
    { store: f.store },
  );
  try {
    let snapshot = ok(await backend.execute({ type: 'snapshot' })).snapshot;
    expect(snapshot.credentials.decisionRequired).toBe(true);
    expect(snapshot.status?.bindings.map((item) => item.connectionId).sort()).toEqual(
      f.bindings.map((item) => item.connectionId).sort(),
    );
    expect(snapshot.connections[0]?.alias).toBe('home');
    expect(
      await backend.execute({ type: 'sync-now', binding: f.bindings[0]!.connectionId }),
    ).toMatchObject({ ok: false, code: 'CREDENTIAL_DECISION_REQUIRED' });
    await migrateCredentials(f.root, true, { store: f.store });
    f.store.locked = true;
    f.store.reads = 0;
    snapshot = ok(await backend.execute({ type: 'snapshot' })).snapshot;
    expect(
      snapshot.status?.bindings.every(
        (item) => item.phase === 'not-started' && item.facts === null,
      ),
    ).toBe(true);
    const id = f.bindings[0]!.connectionId;
    snapshot = ok(
      await backend.execute({
        type: 'pause-folder',
        binding: id,
        paused: true,
        expectedRevision: snapshot.settings.revision,
      }),
    ).snapshot;
    snapshot = ok(
      await backend.execute({
        type: 'pause-all',
        paused: true,
        expectedRevision: snapshot.settings.revision,
      }),
    ).snapshot;
    snapshot = ok(
      await backend.execute({
        type: 'pause-all',
        paused: false,
        expectedRevision: snapshot.settings.revision,
      }),
    ).snapshot;
    expect(
      snapshot.status?.bindings
        .toSorted((first, second) => first.root.localeCompare(second.root))
        .map((item) => item.pause),
    ).toEqual([
      { global: false, binding: true, effective: true },
      { global: false, binding: false, effective: false },
    ]);
    expect(
      await backend.execute({
        type: 'pause-folder',
        binding: id,
        paused: false,
        expectedRevision: 0,
      }),
    ).toMatchObject({ ok: false, code: 'CONFLICT' });
    ok(await backend.execute({ type: 'open-folder', binding: id }));
    expect(opened).toEqual([f.first]);
    expect(await backend.execute({ type: 'open-folder', binding: id, path: '/etc' })).toMatchObject(
      { ok: false, code: 'INVALID_INPUT' },
    );
    expect(await backend.execute({ type: 'open-folder', binding: randomUUID() })).toMatchObject({
      ok: false,
      code: 'NOT_FOUND',
    });
    expect(f.store.reads).toBe(0);
    expect(await backend.execute({ type: 'sync-now', binding: id })).toMatchObject({
      ok: false,
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    f.store.reads = 0;
    expect(
      ok(await backend.execute({ type: 'snapshot' })).snapshot.status?.bindings.find(
        (item) => item.connectionId === id,
      )?.error,
    ).toBe('CREDENTIALS_UNAVAILABLE');
    expect(f.store.reads).toBe(0);
    expect(readPreferences(f.root).continuousRequested).toEqual({});
    renameSync(f.first, f.first + '-original');
    mkdirSync(f.first, { mode: 0o700 });
    expect(await backend.execute({ type: 'open-folder', binding: id })).toMatchObject({
      ok: false,
      code: 'FOLDER_UNAVAILABLE',
    });
    expect(opened).toEqual([f.first]);
    rmSync(f.first, { recursive: true });
    expect(
      ok(await backend.execute({ type: 'snapshot' })).snapshot.status?.bindings.find(
        (item) => item.connectionId === id,
      )?.phase,
    ).toBe('folder-unavailable');
    expect(existsSync(f.first)).toBe(false);
  } finally {
    await backend.shutdown();
    rmSync(f.parent, { recursive: true, force: true });
  }
});
test.each(['desktop', 'cli'] as const)(
  'Quit during a held %s one-shot closes only desktop work or detaches the CLI',
  async (origin) => {
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
    const f = await copies(http.url.href);
    await migrateCredentials(f.root, true, { store: f.store });
    const backend = createDesktopBackend(
      f.root,
      {
        async pickFolder() {
          return [];
        },
        async openAdministration() {
          return { ok: true };
        },
        quit() {},
      },
      { store: f.store },
    );
    let cli: Awaited<ReturnType<typeof openBoundSync>> | undefined;
    try {
      if (origin === 'cli')
        cli = await openBoundSync(f.root, f.first, {
          store: f.store,
          origin: 'cli',
          instanceId: randomUUID(),
        });
      const work = backend.execute({ type: 'sync-now', binding: f.bindings[0]!.connectionId });
      await entered.promise;
      await backend.shutdown();
      expect((await work).ok).toBe(false);
      const binding = clientStatus(f.root).bindings.find(
        (item) => item.connectionId === f.bindings[0]!.connectionId,
      )!;
      expect(binding.ownerPresent).toBe(origin === 'cli');
      if (origin === 'cli') expect(binding.owner?.origin).toBe('cli');
      expect(readPreferences(f.root).continuousRequested).toEqual({});
    } finally {
      release.resolve();
      await backend.shutdown();
      await cli?.close();
      http.stop(true);
      rmSync(f.parent, { recursive: true, force: true });
    }
  },
);
async function freePort() {
  const listener = createServer();
  await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw Error('port unavailable');
  await new Promise<void>((resolve) => listener.close(() => resolve()));
  return address.port;
}
test('real Sync now coalesces, never sets continuous intent, routes to CLI and leaves its owner alive on Quit', async () => {
  const parent = mkdtempSync('/tmp/ns-folders-sync-'),
    root = join(parent, 'client'),
    files = join(parent, 'files'),
    serverRoot = join(parent, 'server');
  for (const path of [root, files, serverRoot]) mkdirSync(path, { mode: 0o700 });
  await initializeServerOwner(serverRoot, 'temporary-password');
  let recovery = '';
  await provisionLocalVault(serverRoot, 'documents', async (value) => {
    recovery = value;
  });
  const http = await runServer({
    directory: serverRoot,
    port: await freePort(),
    scanIntervalMs: 3600000,
  });
  let hold = false;
  let headCalls = 0;
  const received = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const proxy = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const address = new URL(request.url);
      if (address.pathname === '/v1/head') {
        headCalls++;
        if (hold) {
          hold = false;
          received.resolve();
          await release.promise;
        }
      }
      return fetch(new URL(address.pathname + address.search, http.url), {
        method: request.method,
        headers: request.headers,
        body:
          request.method === 'GET' || request.method === 'HEAD'
            ? undefined
            : await request.arrayBuffer(),
      });
    },
  });
  const store = new Store();
  let backend = createDesktopBackend(
    root,
    {
      async pickFolder() {
        return [files];
      },
      async openAdministration() {
        return { ok: true };
      },
      quit() {},
    },
    { store },
  );
  let cli: Awaited<ReturnType<typeof openBoundSync>> | undefined;
  try {
    ok(await backend.execute({ type: 'initialize' }));
    const enroll = {
      type: 'enroll' as const,
      url: proxy.url.href,
      alias: 'home',
      deviceName: 'desktop',
      password: 'temporary-password',
      fresh: false,
      retryCredentialWrite: false,
    };
    ok(await backend.execute({ ...enroll }));
    approveLocalDevice(serverRoot, pendingEnrollments(root)[0]!.deviceId);
    const serverId = ok(await backend.execute({ ...enroll, password: '' })).snapshot.connections[0]!
      .serverId;
    const vaultId = ok(await backend.execute({ type: 'vaults', serverId })).vaults![0]!.vaultId;
    ok(
      await backend.execute({
        type: 'unlock',
        serverId,
        vaultId,
        recovery,
        retryCredentialWrite: false,
      }),
    );
    const selection = ok(await backend.execute({ type: 'pick-folder' })).folder!.selection;
    const binding = ok(
      await backend.execute({
        type: 'connect',
        serverId,
        vaultId,
        selection,
        confirmNonempty: false,
      }),
    ).binding!;
    writeFileSync(join(files, 'local.txt'), 'actual one-shot data');
    expect(existsSync(join(root, 'replicas', binding, 'local.sqlite'))).toBe(false);
    ok(await backend.execute({ type: 'sync-now', binding }));
    expect(readPreferences(root).continuousRequested).toEqual({});
    expect(clientStatus(root).bindings[0]?.ownerPresent).toBe(false);
    expect(clientStatus(root).bindings[0]?.lastSuccessfulSync).not.toBeNull();
    cli = await openBoundSync(root, files, { store, origin: 'cli', instanceId: randomUUID() });
    headCalls = 0;
    hold = true;
    const first = backend.execute({ type: 'sync-now', binding });
    const duplicate = backend.execute({ type: 'sync-now', binding });
    await received.promise;
    expect(headCalls).toBe(1);
    release.resolve();
    ok(await first);
    ok(await duplicate);
    expect(readPreferences(root).continuousRequested).toEqual({});
    expect(clientStatus(root).bindings[0]?.owner?.origin).toBe('cli');
    await backend.shutdown();
    expect(clientStatus(root).bindings[0]?.ownerPresent).toBe(true);
    await cli.close();
    cli = undefined;
  } finally {
    release.resolve();
    await backend.shutdown();
    await cli?.close();
    proxy.stop(true);
    await http.stop();
    rmSync(parent, { recursive: true, force: true });
  }
});
