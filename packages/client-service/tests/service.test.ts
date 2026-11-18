import { afterEach, expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ClientError, connectRegisteredVault, enrollServer, pendingEnrollments, privateDirectory,
  secureCreate, secureReplace, startBoundSync, initializeCredentials, type EnrollmentEvent,
} from '../src/index.ts';

const directories: string[] = [];
function temp() {
  const directory = mkdtempSync(join(tmpdir(), 'client-service-'));
  directories.push(directory);
  initializeCredentials(directory, 'protected-file');
  return directory;
}
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

test('enrollment is silent, secret-free and resumable', async () => {
  const root = temp();
  const events: EnrollmentEvent[] = [];
  const token = 'A'.repeat(43);
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/auth/password') return Response.json({ sessionToken: token });
    if (path === '/v1/capabilities') return new Response(null, { status: 404 });
    return Response.json({ status: 'pending' });
  } });
  const stdout = spyOn(console, 'log').mockImplementation(() => {});
  const stderr = spyOn(console, 'error').mockImplementation(() => {});
  try {
    // A nonretryable discovery failure occurs after durable identity publication.
    await expect(enrollServer(root, http.url.href, 'password-sentinel', 'device', 0, {
      alias: 'test', onEvent: event => events.push(event),
    })).rejects.toMatchObject({ status: 404 });
    const before = pendingEnrollments(root)[0]!;
    expect(events.map(event => event.type)).toEqual(['connecting', 'verification']);
    let passwordRequests = 0;
    await expect(enrollServer(root, http.url.href, undefined, 'device', 0, {
      password: async () => { passwordRequests++; return 'unused'; },
    })).rejects.toMatchObject({ status: 404 });

    expect(passwordRequests).toBe(0);
    expect(pendingEnrollments(root)[0]).toEqual(before);

    expect(JSON.stringify(events)).not.toContain(token);
    expect(JSON.stringify(events)).not.toContain('password-sentinel');
    expect(stdout).not.toHaveBeenCalled();
    expect(stderr).not.toHaveBeenCalled();

    const controller = new AbortController();
    controller.abort();
    await expect(enrollServer(root, http.url.href, undefined, 'device', 0, { signal: controller.signal }))
      .rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
    expect(pendingEnrollments(root)[0]).toEqual(before);
  } finally {
    http.stop(true);
    stdout.mockRestore();
    stderr.mockRestore();
  }
});

test('bound sync validates identity, owns exclusively and releases ownership after stop', async () => {
  const root = temp(), files = mkdtempSync(join(tmpdir(), 'client-files-'));
  directories.push(files);
  const serverId = randomUUID(), vaultId = randomUUID(), deviceId = randomUUID();
  const registrationPath = join(privateDirectory(join(root, 'servers')), `${serverId}.json`);
  const registration = {
    version: 1, serverId, deviceId, baseUrl: 'http://localhost:1', name: 'test', token: 'A'.repeat(43),
  };
  secureCreate(registrationPath, JSON.stringify(registration));
  const binding = connectRegisteredVault(root, files, serverId, vaultId, deviceId);
  await expect(startBoundSync(root, files)).rejects.toThrow('vault key is missing; reconnect to unlock');
  secureCreate(join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`), JSON.stringify({
    version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32),
  }));
  const runner = await startBoundSync(root, files);
  try {
    await expect(startBoundSync(root, binding.root))
      .rejects.toThrow('another live process owns the sync ownership lock');
  }
  finally { await runner.stop(); }
  const next = await startBoundSync(root, files);
  await next.stop();
  secureReplace(registrationPath, JSON.stringify({ ...registration, deviceId: randomUUID() }));
  await expect(startBoundSync(root, files)).rejects.toThrow('binding device differs from connection');
  expect(new ClientError('CONFLICT', 'test').exitCode).toBe(2);
});

test('approval resumes the same identity without another password', async () => {
  const root = temp();
  let status = 'pending', passwordRequests = 0;
  const submitted: unknown[] = [];
  const events: EnrollmentEvent[] = [];
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/v1/auth/password') return Response.json({ sessionToken: 'A'.repeat(43) });
    if (path === '/v1/capabilities') return Response.json({
      protocolVersions: [1], revisionFormatVersions: [1],
      objectFormatVersions: [1], objectTypes: ['manifest'],
      webAdministration: { enabled: true, url: 'https://example.test/admin' },
      limits: { maximumObjectCiphertextBytes: 8192, maximumReferencesPerRevision: 1, maximumParents: 1,
        maximumPresenceQuery: 1, maximumPageSize: 1, maximumJsonMetadataBytes: 1024,
        maximumIdempotencyKeyLength: 32, chunkSizeBytes: 4194304 },
    });
    submitted.push(await request.json());
    return Response.json({ status });
  } });
  const options = {
    alias: 'test', password: async () => { passwordRequests++; return 'password'; },
    onEvent: (event: EnrollmentEvent) => events.push(event),
  };
  try {
    const pending = await enrollServer(root, http.url.href, undefined, 'device', 0, options);
    expect(pending.status).toBe('pending');
    const saved = pendingEnrollments(root)[0]!;
    expect(events.map(event => event.type)).toEqual([
      'connecting', 'verification', 'administration', 'waiting',
    ]);
    events.length = 0;
    status = 'approved';
    const approved = await enrollServer(root, http.url.href, undefined, 'device', 0, options);
    expect(approved).toEqual({
      serverId: saved.serverId, alias: 'test', url: saved.url, deviceId: saved.deviceId, status: 'approved',
    });
    expect(passwordRequests).toBe(1);
    expect(submitted[1]).toEqual(submitted[0]);
    expect(pendingEnrollments(root)).toEqual([]);
    expect(events.map(event => event.type)).toEqual(['verification', 'administration', 'approved']);
  } finally { http.stop(true); }
});

test('cancelling an in-flight enrollment preserves the interruption exit', async () => {
  const received = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const http = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch() {
    received.resolve();
    await release.promise;
    return Response.json({ sessionToken: 'A'.repeat(43) });
  } });
  const controller = new AbortController();
  const enrollment = enrollServer(temp(), http.url.href, 'password', 'device', 0, { signal: controller.signal });
  try {
    await received.promise;
    controller.abort();
    await expect(enrollment).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
  } finally {
    release.resolve();
    http.stop(true);
  }
});
