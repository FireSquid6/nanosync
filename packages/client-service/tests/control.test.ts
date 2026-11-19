import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connectRegisteredVault, initializeCredentials, openBoundSync, privateDirectory, secureCreate, stopOwnedSync, stopBoundSyncForRemoval } from '../src/index.ts';
import { acquireSyncLock, observeSyncLock } from '../src/sync-lock.ts';

const roots: string[] = [];
const sessions: Awaited<ReturnType<typeof openBoundSync>>[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function temp() { const root = mkdtempSync(join(tmpdir(), 'ns-control-')); roots.push(root); return root; }
function fixture(url = 'http://localhost:1') {
  const root = temp(), files = temp();
  initializeCredentials(root, 'protected-file');
  const serverId = randomUUID(), vaultId = randomUUID(), deviceId = randomUUID();
  secureCreate(join(privateDirectory(join(root, 'servers')), `${serverId}.json`), JSON.stringify({
    version: 1, serverId, deviceId, baseUrl: url.replace(/\/$/, ''), name: 'test', token: 'A'.repeat(43),
  }));
  secureCreate(join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`), JSON.stringify({
    version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32),
  }));
  const binding = connectRegisteredVault(root, files, serverId, vaultId, deviceId);
  return { root, files, replica: join(root, 'replicas', binding.connectionId) };
}
async function open(root: string, files: string, origin: 'cli' | 'desktop', instanceId = randomUUID()) {
  const session = await openBoundSync(root, files, { origin, instanceId });
  sessions.push(session);
  return session;
}
test('lock observation is checked, read-only and uses the acquiring process identity', () => {
  const root = temp();
  expect(observeSyncLock(root)).toBeNull();
  const release = acquireSyncLock(root);
  expect(observeSyncLock(root)).toMatchObject({ live: true, owner: { pid: process.pid } });
  expect(() => acquireSyncLock(root)).toThrow('another live process');
  release();
  expect(observeSyncLock(root)).toBeNull();
});
test('attached close detaches; instance stop affects only matching desktop hosts', async () => {
  const first = fixture(), second = fixture(), instanceId = randomUUID();
  await open(first.root, first.files, 'desktop', instanceId);
  await open(second.root, second.files, 'cli', instanceId);
  const attached = await open(first.root, first.files, 'cli');
  expect(attached.owner).toMatchObject({ origin: 'desktop', instanceId });
  await attached.close();
  expect(observeSyncLock(first.replica)?.live).toBe(true);
  await stopOwnedSync(instanceId);
  expect(observeSyncLock(first.replica)).toBeNull();
  expect(observeSyncLock(second.replica)?.live).toBe(true);
});
test.each(['cli', 'desktop'] as const)('%s temporary owners refuse incoming watches explicitly; attached close never releases lock', async origin => {
  const { root, files, replica } = fixture();
  await open(root, files, origin);
  const attached = await open(root, files, 'desktop');
  await expect(attached.watch(new AbortController().signal, () => {}, () => {}))
    .rejects.toMatchObject({ code: 'OWNER_TEMPORARY' });
  await attached.close();
  expect(observeSyncLock(replica)?.live).toBe(true);
});
function discovery(replica: string) {
  const metadata = JSON.parse(readFileSync(join(replica, '.sync-control'), 'utf8'));
  const runtime = metadata.runtime === 'session' ? `/run/user/${process.getuid!()}/nanosync` : `/tmp/nanosync-${process.getuid!()}`;
  const directory = join(runtime, metadata.nonce);
  const capability = readFileSync(join(directory, 'capability'), 'utf8');
  const payload = { version: 1, id: randomUUID(), root: metadata.root, binding: metadata.binding,
    instance: metadata.instanceId, operation: 'watch' };
  return { metadata, directory, socket: join(directory, 's'), capability, payload };
}
async function raw(info: ReturnType<typeof discovery>, changes: Record<string, unknown> = {}, capability = info.capability, body?: string) {
  return fetch('http://localhost/control', { unix: info.socket, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nanosync-capability': capability },
    body: body ?? JSON.stringify({ ...info.payload, ...changes }), redirect: 'error' });
}
test('private transport authenticates and rejects incompatible, malformed, misdirected and oversized input', async () => {
  const { root, files, replica } = fixture();
  await open(root, files, 'cli');
  const info = discovery(replica);
  expect(lstatSync(info.directory).mode & 0o777).toBe(0o700);
  expect(lstatSync(info.socket).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(info.directory, 'capability')).mode & 0o777).toBe(0o600);
  expect((await raw(info, {}, '0'.repeat(64))).status).toBe(403);
  for (const changes of [
    { version: 2 }, { extra: true }, { id: 'bad' }, { id: 1 }, { root: '/wrong' },
    { binding: randomUUID() }, { instance: randomUUID() }, { operation: 'export-secrets' },
  ]) expect((await raw(info, changes)).status).toBe(400);
  const large = await raw(info, {}, info.capability, ' '.repeat(16385));
  expect([400, 413]).toContain(large.status);
  const streamed = await fetch('http://localhost/control', { unix: info.socket, method: 'POST',
    headers: { 'content-type': 'application/json', 'x-nanosync-capability': info.capability },
    body: new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode(JSON.stringify(info.payload)));
      stream.enqueue(new Uint8Array(16385).fill(32));
      stream.close();
    } }),
  });
  expect([400, 413]).toContain(streamed.status);
  const wrongType = await fetch('http://localhost/control', { unix: info.socket, method: 'POST',
    headers: { 'x-nanosync-capability': info.capability, 'content-type': 'text/plain' }, body: '{}' });
  expect(wrongType.status).toBe(400);
  const valid = await raw(info);
  expect(await valid.json()).toEqual({ head: null, events: [], error: { code: 'OWNER_TEMPORARY', exitCode: 2 } });
  expect(await (await raw(info)).json()).toEqual({ head: null, events: [], error: { code: 'OWNER_TEMPORARY', exitCode: 2 } });
  expect((await raw(info, { operation: 'sync' })).status).toBe(400);
  expect(observeSyncLock(replica)?.live).toBe(true);
});
test('attachment refuses unsafe directories, capabilities, discovery and substituted sockets', async () => {
  const { root, files, replica } = fixture();
  await open(root, files, 'cli');
  const info = discovery(replica), capability = join(info.directory, 'capability');
  for (const path of [info.directory, info.socket, capability, join(replica, '.sync-control')]) {
    const original = lstatSync(path).mode & 0o777;
    chmodSync(path, original | 0o044);
    await expect(openBoundSync(root, files, { origin: 'cli', instanceId: randomUUID() })).rejects.toThrow();
    chmodSync(path, original);
  }
  linkSync(capability, `${capability}.link`);
  await expect(openBoundSync(root, files, { origin: 'cli', instanceId: randomUUID() })).rejects.toThrow();
  unlinkSync(`${capability}.link`);
  renameSync(capability, `${capability}.saved`);
  symlinkSync(`${capability}.saved`, capability);
  await expect(openBoundSync(root, files, { origin: 'cli', instanceId: randomUUID() })).rejects.toThrow();
  unlinkSync(capability); renameSync(`${capability}.saved`, capability);
  renameSync(info.socket, `${info.socket}.saved`);
  const substitute = Bun.serve({ unix: info.socket, fetch: () => Response.json({ secret: 'not a trusted host' }) });
  try {
    chmodSync(info.socket, 0o600);
    await expect(openBoundSync(root, files, { origin: 'cli', instanceId: randomUUID() })).rejects.toThrow();
  } finally { await substitute.stop(true); renameSync(`${info.socket}.saved`, info.socket); }
});
test('live owner without advertisement fails closed; explicit removal stops then requires lock revalidation', async () => {
  const { root, files, replica } = fixture();
  privateDirectory(join(root, 'replicas')); privateDirectory(replica);
  const release = acquireSyncLock(replica);
  try {
    await expect(openBoundSync(root, files, { origin: 'desktop', instanceId: randomUUID() }))
      .rejects.toMatchObject({ code: 'OWNER_UNAVAILABLE' });
    expect(observeSyncLock(replica)?.live).toBe(true);
  } finally { release(); }
  const host = await open(root, files, 'cli');
  const attached = await open(root, files, 'desktop');
  await stopBoundSyncForRemoval(root, files);
  expect(observeSyncLock(replica)).toBeNull();
  await expect(host.syncOnce()).rejects.toMatchObject({ code: 'OWNER_STOPPED' });
  await expect(attached.syncOnce()).rejects.toMatchObject({ code: 'OWNER_UNAVAILABLE' });
  expect(existsSync(join(files, '.nanosync'))).toBe(true);
});

import { controlProcess } from './control-process.ts';
test.each(['pre-advertise', 'host'])('definitively dead subprocess recovers safely after %s crash', async mode => {
  const { root, files, replica } = fixture();
  const child = controlProcess(root, files, { origin: 'cli', instanceId: randomUUID() }, mode);
  let orphanDirectory: string | undefined;
  try {
    expect(await child.next()).toMatchObject({ ready: true });
    expect(observeSyncLock(replica)).toMatchObject({ live: true, owner: { pid: child.child.pid } });
    if (mode === 'pre-advertise') {
      await expect(openBoundSync(root, files, { origin: 'cli', instanceId: randomUUID() }))
        .rejects.toMatchObject({ code: 'OWNER_UNAVAILABLE' });
    } else {
      orphanDirectory = discovery(replica).directory;
      const attached = await open(root, files, 'desktop');
      await attached.close();
      expect(observeSyncLock(replica)?.live).toBe(true);
    }
    child.command('crash');
    expect(await child.child.exited).toBe(17);
    expect(observeSyncLock(replica)?.live).toBe(false);
    await open(root, files, 'desktop');
    expect(observeSyncLock(replica)).toMatchObject({ live: true, owner: { pid: process.pid } });
  } finally {
    await child.close();
    if (orphanDirectory) rmSync(orphanDirectory, { recursive: true, force: true });
  }
});
test('forwarding requires no credential read and sanitizes remote errors across processes', async () => {
  const received = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    received.resolve(); await release.promise;
    return Response.json({ protocolVersion: 1, code: 'UNAUTHORIZED', message: 'credential-sentinel' }, { status: 401 });
  } });
  const { root, files, replica } = fixture(remote.url.href);
  const owner = controlProcess(root, files, { origin: 'cli', instanceId: randomUUID() });
  try {
    await owner.next();
    // Attachment must never open keys, including when their backing store is unavailable.
    renameSync(join(root, 'keys'), join(root, 'keys-saved'));
    const attached = await open(root, files, 'desktop');
    const syncing = attached.syncOnce().catch(error => error);
    await received.promise;
    expect(observeSyncLock(replica)?.owner.pid).toBe(owner.child.pid);
    release.resolve();
    expect(await syncing).toMatchObject({ code: 'UNAUTHORIZED', exitCode: 5 });
    try { await attached.syncOnce(); } catch (error) { expect(String(error)).not.toContain('credential-sentinel'); }
    await stopOwnedSync(attached.owner.instanceId);
    expect(observeSyncLock(replica)?.live).toBe(true);
  } finally { release.resolve(); await owner.close(); await remote.stop(true); }
});
test('attached progress arrives before the controlled remote pass completes', async () => {
  const progress = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    await release.promise;
    return Response.json({ protocolVersion: 1, code: 'UNAUTHORIZED', message: 'redact-me' }, { status: 401 });
  } });
  const { root, files } = fixture(remote.url.href);
  const owner = controlProcess(root, files, { origin: 'cli', instanceId: randomUUID() });
  try {
    await owner.next();
    const attached = await openBoundSync(root, files, { origin: 'desktop', instanceId: randomUUID(),
      onEvent(event) { if (event.type === 'checking') progress.resolve(); } });
    sessions.push(attached);
    const syncing = attached.syncOnce();
    const checked = syncing.catch(error => error);
    await progress.promise;
    release.resolve();
    expect(await checked).toMatchObject({ code: 'UNAUTHORIZED', exitCode: 5 });
  } finally { release.resolve(); await owner.close(); await remote.stop(true); }
});
test.each(['headless-owner', 'headless-reader'])('reader uses constrained owner runtime discovery, not its own XDG (%s)', async mode => {
  const ownerRuntime = mode === 'headless-owner' ? null : temp();
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () =>
    Response.json({ protocolVersion: 1, code: 'UNAUTHORIZED', message: 'safe' }, { status: 401 }) });
  const { root, files } = fixture(remote.url.href);
  const owner = controlProcess(root, files, { origin: 'cli', instanceId: randomUUID() }, 'host', ownerRuntime);
  const previous = process.env.XDG_RUNTIME_DIR;
  try {
    await owner.next();
    process.env.XDG_RUNTIME_DIR = ownerRuntime ? '' : temp();
    const attached = await open(root, files, 'desktop');
    const error = await attached.syncOnce().catch(error => error);
    expect(error).toMatchObject({ code: 'UNAUTHORIZED', exitCode: 5 });
  } finally {
    if (previous === undefined) delete process.env.XDG_RUNTIME_DIR;
    else process.env.XDG_RUNTIME_DIR = previous;
    await owner.close(); await remote.stop(true);
  }
});
test.each(['missing', 'replaced'])('host close completes its own cleanup when discovery is %s', async change => {
  const { root, files, replica } = fixture();
  const host = await open(root, files, 'desktop'), info = discovery(replica);
  unlinkSync(join(replica, '.sync-control'));
  if (change === 'replaced') secureCreate(join(replica, '.sync-control'), '{"newOwner":true}');
  await host.close();
  expect(observeSyncLock(replica)).toBeNull();
  expect(existsSync(info.socket)).toBe(false);
  expect(existsSync(info.directory)).toBe(false);
  expect(existsSync(join(replica, '.sync-control'))).toBe(change === 'replaced');
});
test('replay storage stays bounded without permanently refusing fresh work after saturation', async () => {
  const { root, files, replica } = fixture();
  await open(root, files, 'cli');
  const info = discovery(replica);
  for (let index = 0; index < 140; index++) {
    const response = await raw(info, { id: randomUUID() });
    expect(response.status).toBe(200);
    await response.arrayBuffer();
  }
});
test('simultaneous forwarded passes coalesce into one writer and retain bounded live subscribers', async () => {
  let requests = 0;
  const release = Promise.withResolvers<void>();
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    requests++; await release.promise;
    return Response.json({ protocolVersion: 1, code: 'UNAUTHORIZED', message: 'never echo me' }, { status: 401 });
  } });
  const { root, files, replica } = fixture(remote.url.href);
  const owner = controlProcess(root, files, { origin: 'cli', instanceId: randomUUID() });
  try {
    await owner.next();
    const info = discovery(replica), replies: Response[] = [];
    for (let index = 0; index < 16; index++) replies.push(await raw(info, { id: randomUUID(), operation: 'sync' }));
    expect((await raw(info, { id: randomUUID(), operation: 'sync' })).status).toBe(429);
    expect(requests).toBe(1);
    expect(observeSyncLock(replica)?.owner.pid).toBe(owner.child.pid);
    release.resolve();
    for (const reply of replies) {
      const text = await reply.text();
      expect(text).toContain('UNAUTHORIZED');
      expect(text).not.toContain('never echo me');
    }
    expect(requests).toBe(1);
  } finally { release.resolve(); await owner.close(); await remote.stop(true); }
});
test('a live lock with missing or unreachable endpoint never authorizes a new writer', async () => {
  const { root, files, replica } = fixture();
  await open(root, files, 'cli');
  const attached = await open(root, files, 'desktop'), info = discovery(replica);
  unlinkSync(info.socket);
  const error = await attached.syncOnce().catch(error => error);
  expect(error).toMatchObject({ code: 'OWNER_UNAVAILABLE' });
  expect(observeSyncLock(replica)?.live).toBe(true);
  await expect(openBoundSync(root, files, { origin: 'desktop', instanceId: randomUUID() })).rejects.toThrow();
});
test('socket substitution after connection is rejected without requiring post-result owner liveness', async () => {
  const release = Promise.withResolvers<void>(), progress = Promise.withResolvers<void>();
  const remote = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    await release.promise;
    return Response.json({ protocolVersion: 1, code: 'UNAUTHORIZED', message: 'safe' }, { status: 401 });
  } });
  const { root, files, replica } = fixture(remote.url.href);
  const host = await open(root, files, 'cli');
  const attached = await openBoundSync(root, files, { origin: 'desktop', instanceId: randomUUID(),
    onEvent() { progress.resolve(); } });
  sessions.push(attached);
  const info = discovery(replica);
  let substitute: ReturnType<typeof Bun.serve> | undefined;
  try {
    const syncing = attached.syncOnce().catch(error => error);
    await progress.promise;
    renameSync(info.socket, `${info.socket}.original`);
    substitute = Bun.serve({ unix: info.socket, fetch: () => Response.json({}) });
    chmodSync(info.socket, 0o600);
    release.resolve();
    expect(await syncing).toMatchObject({ code: 'OWNER_UNAVAILABLE' });
  } finally {
    release.resolve(); await substitute?.stop(true);
    if (existsSync(`${info.socket}.original`)) renameSync(`${info.socket}.original`, info.socket);
    await host.close(); await remote.stop(true);
  }
});
test('host close drains accepted results and cancels incomplete authenticated request bodies', async () => {
  const { root, files, replica } = fixture();
  const host = await open(root, files, 'cli'), info = discovery(replica);
  const started = Promise.withResolvers<void>(), controller = new AbortController();
  const pending = fetch('http://localhost/control', { unix: info.socket, method: 'POST', signal: controller.signal,
    headers: { 'content-type': 'application/json', 'x-nanosync-capability': info.capability },
    body: new ReadableStream<Uint8Array>({ start(stream) {
      stream.enqueue(new TextEncoder().encode('{')); started.resolve();
    } }),
  }).catch(error => error);
  try {
    await started.promise;
    await (await raw(info)).arrayBuffer();
    await host.close();
    expect(observeSyncLock(replica)).toBeNull();
    expect(existsSync(info.directory)).toBe(false);
  } finally { controller.abort(); await pending; }
});
