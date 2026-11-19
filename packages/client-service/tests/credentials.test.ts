import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { credentialStatus, initializeCredentials, desktopCredentials } from '../src/index.ts';

test('new roots require explicit mode; desktop refuses file mode without converting it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  try {
    expect(credentialStatus(root).mode).toBe('uninitialized');
    expect(() => initializeCredentials(root)).toThrow(/select/i);
    initializeCredentials(root, 'protected-file');
    expect(credentialStatus(root).mode).toBe('protected-file');
    expect(desktopCredentials(root).decisionRequired).toBe(true);
    expect(() => initializeCredentials(root, 'os-store')).toThrow(/migrat/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { randomUUID } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import {
  migrateCredentials,
  resumeCredentialMigration,
  rollbackCredentialMigration,
  servers,
  key,
  secureCreate,
  privateDirectory,
  type CredentialStore,
} from '../src/index.ts';

class MemoryStore implements CredentialStore {
  values = new Map<string, string>();
  locked = false;
  async get(ref: { name: string }) {
    return this.locked ? null : (this.values.get(ref.name) ?? null);
  }
  async set(ref: { name: string; value: string }) {
    if (this.locked) throw Error('native secret sentinel');
    this.values.set(ref.name, ref.value);
  }
  async delete(ref: { name: string }) {
    return this.locked ? false : this.values.delete(ref.name);
  }
}
function legacy(root: string) {
  const serverId = randomUUID(),
    deviceId = randomUUID(),
    vaultId = randomUUID();
  secureCreate(
    join(privateDirectory(join(root, 'servers')), `${serverId}.json`),
    JSON.stringify({
      version: 1,
      serverId,
      deviceId,
      baseUrl: 'https://example.test',
      name: 'home',
      token: 'A'.repeat(43),
    }),
  );
  secureCreate(
    join(privateDirectory(join(root, 'keys')), `${serverId}-${vaultId}.json`),
    JSON.stringify({ version: 1, serverId, vaultId, masterKey: 'ab'.repeat(32) }),
  );
  return { serverId, deviceId, vaultId };
}
test('migration preserves identities, hides secrets in listings, and recorded locked keys never appear absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const ids = legacy(root);
    await migrateCredentials(root, true, { store });
    expect(credentialStatus(root).mode).toBe('os-store');
    expect(servers(root)[0]).toMatchObject({ serverId: ids.serverId, deviceId: ids.deviceId });
    expect(JSON.stringify(servers(root))).not.toContain('A'.repeat(43));
    expect(await key(root, ids.serverId, ids.vaultId, { store })).toEqual(
      Buffer.from('ab'.repeat(32), 'hex'),
    );
    store.locked = true;
    expect(servers(root)).toHaveLength(1);
    await expect(key(root, ids.serverId, ids.vaultId, { store })).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
      exitCode: 2,
    });
    expect(await key(root, ids.serverId, randomUUID(), { store })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import {
  enrollServer,
  pendingEnrollments,
  authenticatedServer,
  acquireSyncLock,
  removeServerConnection,
} from '../src/index.ts';
test('interrupted initial OS write retains unsubmitted identity and permits explicit reauthentication only', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  let logins = 0,
    submissions = 0;
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/auth/password') {
        logins++;
        return Response.json({ sessionToken: 'A'.repeat(43) });
      }
      submissions++;
      return new Response(null, { status: 404 });
    },
  });
  try {
    initializeCredentials(root, 'os-store');
    await expect(
      enrollServer(root, http.url.href, 'password', 'device', 0, {
        store,
        checkpoint(name) {
          if (name === 'record-intent') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const before = pendingEnrollments(root)[0]!;
    expect(submissions).toBe(0);
    await expect(
      enrollServer(root, http.url.href, 'password', 'device', 0, { store }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(logins).toBe(1);
    await expect(
      enrollServer(root, http.url.href, 'password', 'device', 0, {
        store,
        retryCredentialWrite: true,
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(logins).toBe(2);
    expect(pendingEnrollments(root)[0]).toMatchObject({
      serverId: before.serverId,
      deviceId: before.deviceId,
      fingerprint: before.fingerprint,
    });
  } finally {
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

import { createHash } from 'node:crypto';
function pendingFixture(root: string, serverId = randomUUID()) {
  const url = 'https://pending.example.test';
  const path = join(
    privateDirectory(join(root, 'pending')),
    `${createHash('sha256').update(url).digest('hex')}.json`,
  );
  const value = {
    url,
    serverId,
    deviceId: randomUUID(),
    token: 'E'.repeat(43),
    name: 'pending device',
    alias: 'pending',
    fingerprint: Buffer.alloc(32, 1).toString('base64url'),
    expiresAtMs: 123456789,
    status: 'denied',
  };
  secureCreate(path, JSON.stringify(value));
  return value;
}
for (const checkpoint of [
  'migration-intent',
  'migration-item-stored',
  'migration-target-ready',
  'migration-cleanup-intent',
  'migration-source-cleaned',
  'migration-committed',
]) {
  test(`migration resumes after ${checkpoint} without changing pending identity or keys`, async () => {
    const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
      store = new MemoryStore();
    try {
      const ids = legacy(root),
        pending = pendingFixture(root);
      await expect(
        migrateCredentials(root, true, {
          store,
          checkpoint(name) {
            if (name === checkpoint) throw Error('crash');
          },
        }),
      ).rejects.toThrow('crash');
      const journal = readFileSync(join(root, 'credential-migration.json'), 'utf8');
      expect(journal).not.toContain('A'.repeat(43));
      expect(journal).not.toContain('E'.repeat(43));
      expect(journal).not.toContain('ab'.repeat(32));
      expect(() => servers(root)).toThrow(/migration pending/);
      await resumeCredentialMigration(root, true, { store });
      expect(await authenticatedServer(root, ids.serverId, { store })).toMatchObject({
        token: 'A'.repeat(43),
        deviceId: ids.deviceId,
      });
      expect(await key(root, ids.serverId, ids.vaultId, { store })).toEqual(
        Buffer.from('ab'.repeat(32), 'hex'),
      );
      const { token, ...summary } = pending;
      expect(pendingEnrollments(root)[0]).toMatchObject(summary);
      expect(existsSync(join(root, 'credential-migration.json'))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
test('rollback verifies deletion, retains source, and cannot run after cleanup intent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    legacy(root);
    await expect(migrateCredentials(root, false, { store })).rejects.toMatchObject({
      code: 'CONFIRMATION_REQUIRED',
    });
    const crash = (name: string) => {
      if (name === 'migration-target-ready') throw Error('crash');
    };
    await expect(migrateCredentials(root, true, { store, checkpoint: crash })).rejects.toThrow(
      'crash',
    );
    store.locked = true;
    await expect(rollbackCredentialMigration(root, true, { store })).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    expect(credentialStatus(root).migrationPending).toBe(true);
    store.locked = false;
    await rollbackCredentialMigration(root, true, { store });
    expect(store.values.size).toBe(0);
    expect(credentialStatus(root).mode).toBe('protected-file');
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-cleanup-intent') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await expect(rollbackCredentialMigration(root, true, { store })).rejects.toMatchObject({
      code: 'CREDENTIAL_ROLL_FORWARD_REQUIRED',
    });
    store.values.clear();
    await expect(resumeCredentialMigration(root, true, { store })).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    expect(credentialStatus(root).migrationPending).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('migration refuses live replicas before publishing a barrier', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  try {
    legacy(root);
    const replica = privateDirectory(join(privateDirectory(join(root, 'replicas')), randomUUID()));
    const release = acquireSyncLock(replica);
    try {
      await expect(migrateCredentials(root, true, { store: new MemoryStore() })).rejects.toThrow(
        /live process/,
      );
    } finally {
      release();
    }
    expect(credentialStatus(root).migrationPending).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('removal cleanup remains retryable and never reports another server removed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const first = legacy(root),
      second = legacy(root);
    await migrateCredentials(root, true, { store });
    await expect(
      removeServerConnection(root, first.serverId, false, {
        store,
        checkpoint(name) {
          if (name === 'cleanup-deleted') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    await expect(
      removeServerConnection(root, second.serverId, false, { store }),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_CLEANUP_PENDING',
    });
    store.locked = true;
    await expect(
      removeServerConnection(root, first.serverId, false, { store }),
    ).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    store.locked = false;
    await removeServerConnection(root, first.serverId, false, { store });
    expect(servers(root).map((info) => info.serverId)).toEqual([second.serverId]);
    expect(await key(root, second.serverId, second.vaultId, { store })).toHaveLength(32);
    expect(await key(root, first.serverId, first.vaultId, { store })).toBeNull();
    expect(store.values.size).toBe(2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown metadata and corrupt secret JSON never enter snapshots or migration journals', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  try {
    const ids = legacy(root),
      path = join(root, 'servers', `${ids.serverId}.json`);
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const { secureReplace } = await import('../src/index.ts');
    secureReplace(path, JSON.stringify({ ...value, password: 'password-sentinel' }));
    expect(() => servers(root)).toThrow(/Invalid credential metadata/);
    await expect(
      migrateCredentials(root, true, { store: new MemoryStore() }),
    ).rejects.toMatchObject({
      code: 'CREDENTIAL_STATE_INVALID',
    });
    expect(existsSync(join(root, 'credential-migration.json'))).toBe(false);
    secureReplace(path, '{"token":"token-sentinel" INVALID');
    try {
      servers(root);
      throw Error('expected invalid state');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CREDENTIAL_STATE_INVALID' });
      expect(String(error)).not.toContain('token-sentinel');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('mismatched migration generations fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    legacy(root);
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-intent') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const path = join(root, 'credential-migration.json'),
      intent = JSON.parse(readFileSync(path, 'utf8'));
    intent.items[0].reference.generation = randomUUID();
    const { secureReplace } = await import('../src/index.ts');
    secureReplace(path, JSON.stringify(intent));
    await expect(resumeCredentialMigration(root, true, { store })).rejects.toMatchObject({
      code: 'CREDENTIAL_STATE_INVALID',
    });
    expect(store.values.size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import {
  unlockVault,
  server,
  secureReplace,
  keyWritePending,
  resumeCredentialCleanup,
} from '../src/index.ts';
import { generateRecoverySecret, displayRecoverySecret, wrapMasterKey } from '@nanosync/sync-core';
test('interrupted key writes block normal use and allow explicit recovery retry for that unfinished write', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  const recovery = generateRecoverySecret(),
    master = Buffer.alloc(32, 7),
    vaultId = randomUUID();
  const wrap = await wrapMasterKey(master, recovery, vaultId);
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      return Response.json({ recoveryWrap: wrap });
    },
  });
  try {
    const ids = legacy(root),
      path = join(root, 'servers', `${ids.serverId}.json`);
    secureReplace(
      path,
      JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), baseUrl: http.url.origin }),
    );
    await migrateCredentials(root, true, { store });
    const info = server(root, ids.serverId),
      secret = await displayRecoverySecret(recovery);
    await expect(
      unlockVault(root, info, vaultId, secret, {
        store,
        checkpoint(name) {
          if (name === 'record-intent') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(keyWritePending(root, ids.serverId, vaultId)).toBe(true);
    await expect(key(root, ids.serverId, vaultId, { store })).rejects.toMatchObject({
      code: 'CREDENTIALS_UNAVAILABLE',
    });
    await unlockVault(root, info, vaultId, secret, { store, retryCredentialWrite: true });
    expect(await key(root, ids.serverId, vaultId, { store })).toEqual(master);
    expect(keyWritePending(root, ids.serverId, vaultId)).toBe(false);
    store.values.clear();
    await expect(
      unlockVault(root, info, vaultId, secret, { store, retryCredentialWrite: true }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
  } finally {
    recovery.fill(0);
    master.fill(0);
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
test('cleanup resumes after metadata deletion using only its durable inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const ids = legacy(root);
    await migrateCredentials(root, true, { store });
    await expect(
      removeServerConnection(root, ids.serverId, false, {
        store,
        checkpoint(name) {
          if (name === 'cleanup-files') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(servers(root)).toEqual([]);
    await resumeCredentialCleanup(root, true, { store });
    expect(credentialStatus(root).cleanupPending).toBe(false);
    expect(store.values.size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cleanup never replaces an intact source with a different valid target credential', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const ids = legacy(root);
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-cleanup-intent') {
            for (const [ref, value] of store.values)
              if (value === 'A'.repeat(43)) store.values.set(ref, 'E'.repeat(43));
          }
        },
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(
      JSON.parse(readFileSync(join(root, 'servers', `${ids.serverId}.json`), 'utf8')).token,
    ).toBe('A'.repeat(43));
    expect(credentialStatus(root).migrationPending).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('all staged entries must remain verified before rollback becomes forbidden', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    legacy(root);
    let count = 0;
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-item-stored' && ++count === 2)
            store.values.delete(store.values.keys().next().value!);
        },
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE' });
    expect(
      JSON.parse(readFileSync(join(root, 'credential-migration.json'), 'utf8')).phase,
    ).not.toBe('cleanup');
    await rollbackCredentialMigration(root, true, { store });
    expect(credentialStatus(root).mode).toBe('protected-file');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('migration refuses an uninventoried legacy credential before committing OS mode', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    legacy(root);
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-target-ready') legacy(root);
        },
      }),
    ).rejects.toMatchObject({ code: 'CREDENTIAL_STATE_INVALID' });
    expect(credentialStatus(root).mode).toBe('protected-file');
    expect(credentialStatus(root).migrationPending).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('repeated migrate preserves the original unfinished generation and its rollback inventory', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    legacy(root);
    const options = {
      store,
      checkpoint(name: string) {
        if (name === 'migration-target-ready') throw Error('crash');
      },
    };
    await expect(migrateCredentials(root, true, options)).rejects.toThrow('crash');
    const before = readFileSync(join(root, 'credential-migration.json'), 'utf8');
    await expect(migrateCredentials(root, true, options)).rejects.toMatchObject({
      code: 'CREDENTIAL_MIGRATION_PENDING',
    });
    expect(readFileSync(join(root, 'credential-migration.json'), 'utf8')).toBe(before);
    await rollbackCredentialMigration(root, true, { store });
    expect(store.values.size).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('native failures are sanitized while metadata listing never touches the provider', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const ids = legacy(root);
    await migrateCredentials(root, true, { store });
    let reads = 0;
    store.get = async () => {
      reads++;
      throw Error('native-secret-sentinel');
    };
    expect(servers(root)).toHaveLength(1);
    expect(reads).toBe(0);
    try {
      await authenticatedServer(root, ids.serverId, { store });
      throw Error('expected failure');
    } catch (error) {
      expect(error).toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', exitCode: 2 });
      expect(String(error)).not.toContain('native-secret-sentinel');
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

import { withCredentialRegistry } from '../src/index.ts';
test('deferred work from an expired async registry context must reacquire the lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  const trigger = Promise.withResolvers<void>();
  let deferred: Promise<void> | undefined,
    entered = false;
  try {
    await withCredentialRegistry(root, async () => {
      deferred = trigger.promise.then(() =>
        withCredentialRegistry(root, async () => {
          entered = true;
        }),
      );
    });
    const release = acquireSyncLock(join(root, 'registry-lock'));
    try {
      trigger.resolve();
      await expect(deferred!).rejects.toThrow(/live process/);
      expect(entered).toBe(false);
    } finally {
      release();
    }
    await withCredentialRegistry(root, async () => {
      entered = true;
    });
    expect(entered).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('enrollment waits release the registry gate but retain a migration-blocking operation lease', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  const received = Promise.withResolvers<void>(),
    respond = Promise.withResolvers<void>();
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/auth/password')
        return new Response(null, { status: 404 });
      await request.text();
      received.resolve();
      await respond.promise;
      // Bun 1.4.2 misparses the next keepalive request after this deferred handler.
      return Response.json({ sessionToken: 'A'.repeat(43) }, { headers: { connection: 'close' } });
    },
  });
  initializeCredentials(root, 'protected-file');
  const enrollment = enrollServer(root, http.url.href, 'password', 'device', 0);
  try {
    await received.promise;
    const release = acquireSyncLock(join(root, 'registry-lock'));
    release();
    await expect(migrateCredentials(root, true, { store: new MemoryStore() })).rejects.toThrow(
      /live process/,
    );
    expect(credentialStatus(root).migrationPending).toBe(false);
    respond.resolve();
    await expect(enrollment).rejects.toMatchObject({ status: 404 });
  } finally {
    respond.resolve();
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('rollback never deletes staged secrets if a required original source file is missing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  try {
    const ids = legacy(root);
    await expect(
      migrateCredentials(root, true, {
        store,
        checkpoint(name) {
          if (name === 'migration-target-ready') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    rmSync(join(root, 'servers', `${ids.serverId}.json`));
    await expect(rollbackCredentialMigration(root, true, { store })).rejects.toMatchObject({
      code: 'CREDENTIAL_STATE_INVALID',
    });
    expect(store.values.size).toBe(2);
    expect(credentialStatus(root).migrationPending).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('empty listing-created directories do not select a mode, while existing replica identity is retained', () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  try {
    for (const leaf of ['connections', 'replicas', 'servers', 'pending'])
      privateDirectory(join(root, leaf));
    expect(credentialStatus(root).mode).toBe('uninitialized');
    privateDirectory(join(root, 'replicas', randomUUID()));
    expect(credentialStatus(root)).toMatchObject({ mode: 'protected-file', legacy: true });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('approved OS registration resumes its crash window using the same pending token reference', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  let logins = 0,
    writes = 0;
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const path = new URL(request.url).pathname;
      if (path === '/v1/auth/password') {
        logins++;
        return Response.json({ sessionToken: 'A'.repeat(43) });
      }
      if (path === '/v1/capabilities')
        return Response.json({
          protocolVersions: [1],
          revisionFormatVersions: [1],
          objectFormatVersions: [1],
          objectTypes: ['manifest'],
          webAdministration: { enabled: false },
          limits: {
            maximumObjectCiphertextBytes: 8192,
            maximumReferencesPerRevision: 1,
            maximumParents: 1,
            maximumPageSize: 1,
            maximumPresenceQuery: 1,
            maximumJsonMetadataBytes: 1024,
            maximumIdempotencyKeyLength: 32,
            chunkSizeBytes: 4194304,
          },
        });
      return Response.json({ status: 'approved' });
    },
  });
  try {
    initializeCredentials(root, 'os-store');
    await expect(
      enrollServer(root, http.url.href, 'password', 'device', 0, {
        store,
        checkpoint(name) {
          if (name === 'record-intent' && ++writes === 2) throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    const pending = pendingEnrollments(root)[0]!;
    const result = await enrollServer(root, http.url.href, undefined, 'ignored', 0, { store });
    expect(result).toMatchObject({
      serverId: pending.serverId,
      deviceId: pending.deviceId,
      status: 'approved',
    });
    expect(pendingEnrollments(root)).toEqual([]);
    expect(store.values.size).toBe(1);
    expect(logins).toBe(1);
  } finally {
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

import { connectRegisteredVault } from '../src/index.ts';
test('removing the last legacy server adopts protected-file mode and permits re-enrollment without mode selection', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  const files = mkdtempSync(join(tmpdir(), 'nanosync-legacy-files-'));
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/auth/password')
        return Response.json({ sessionToken: 'A'.repeat(43) });
      return new Response(null, { status: 404 });
    },
  });
  try {
    const ids = legacy(root);
    connectRegisteredVault(root, files, ids.serverId, ids.vaultId, ids.deviceId);
    expect(existsSync(join(root, 'credentials.json'))).toBe(false);
    await removeServerConnection(root, ids.serverId, true);
    expect(existsSync(join(root, 'credentials.json'))).toBe(true);
    expect(credentialStatus(root).mode).toBe('protected-file');
    await expect(enrollServer(root, http.url.href, 'password', 'device', 0)).rejects.toMatchObject({
      status: 404,
    });
    expect(pendingEnrollments(root)).toHaveLength(1);
  } finally {
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
    rmSync(files, { recursive: true, force: true });
  }
});

test('registry release failure still wakes queued work to revalidate ownership', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  try {
    const first = withCredentialRegistry(root, async () => {
      entered.resolve();
      await finish.promise;
      const path = join(root, 'registry-lock', '.sync-owner');
      secureReplace(path, readFileSync(path, 'utf8'));
    });
    await entered.promise;
    const second = withCredentialRegistry(root, async () => {});
    const outcomes = Promise.allSettled([first, second]);
    finish.resolve();
    const [firstResult, secondResult] = await outcomes;
    expect(firstResult.status).toBe('rejected');
    expect(secondResult.status).toBe('rejected');
    if (firstResult.status === 'rejected') expect(firstResult.reason.message).toMatch(/changed/);
    if (secondResult.status === 'rejected')
      expect(secondResult.reason.message).toMatch(/live process/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('abort during a native credential read becomes interruption after it settles, not success', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  try {
    legacy(root);
    await migrateCredentials(root, true, { store });
    store.get = async (ref) => {
      entered.resolve();
      await finish.promise;
      return store.values.get(ref.name) ?? null;
    };
    const enrollment = enrollServer(root, 'https://example.test', undefined, 'ignored', 0, {
      store,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    finish.resolve();
    await expect(enrollment).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
  } finally {
    finish.resolve();
    rmSync(root, { recursive: true, force: true });
  }
});

test('abort during an uncancellable native write prevents subsequent HTTP after settlement', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-')),
    store = new MemoryStore();
  const entered = Promise.withResolvers<void>(),
    finish = Promise.withResolvers<void>();
  const controller = new AbortController();
  let requests = 0;
  const http = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch() {
      requests++;
      return Response.json({ sessionToken: 'A'.repeat(43) });
    },
  });
  try {
    initializeCredentials(root, 'os-store');
    store.set = async (ref) => {
      entered.resolve();
      await finish.promise;
      store.values.set(ref.name, ref.value);
    };
    const enrollment = enrollServer(root, http.url.href, 'password', 'device', 0, {
      store,
      signal: controller.signal,
    });
    await entered.promise;
    controller.abort();
    finish.resolve();
    await expect(enrollment).rejects.toMatchObject({ code: 'INTERRUPTED', exitCode: 130 });
    expect(requests).toBe(1);
    expect(pendingEnrollments(root)).toHaveLength(1);
  } finally {
    finish.resolve();
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});

test('bound start retains unlock guidance when recording credential failure encounters an unrecovered journal', async () => {
  const { createConnection, startBoundSync, clientStatus } = await import('../src/index.ts');
  const { ClientLocal } = await import('@nanosync/client-local');
  const root = mkdtempSync(join(tmpdir(), 'nanosync-credentials-'));
  const files = mkdtempSync(join(tmpdir(), 'nanosync-credential-files-'));
  const store = new MemoryStore();
  try {
    const ids = legacy(root);
    const binding = createConnection(root, files, ids.serverId, ids.vaultId, ids.deviceId);
    const replica = join(root, 'replicas', binding.connectionId);
    new ClientLocal(replica, ids.vaultId, ids.deviceId).close();
    await migrateCredentials(root, true, { store });
    secureCreate(join(replica, 'local.sqlite-wal'), 'interrupted WAL fixture');
    store.locked = true;
    await expect(startBoundSync(root, files, { store })).rejects.toMatchObject({ code: 'CREDENTIALS_UNAVAILABLE', exitCode: 2 });
    const status = clientStatus(root).bindings[0]!;
    expect(status).toMatchObject({ phase: 'credentials-locked', error: 'CREDENTIALS_UNAVAILABLE', facts: null, upToDate: false });
    expect(status.statusIssues.some(issue => issue.code === 'JOURNAL_RECOVERY_REQUIRED')).toBe(true);
    expect(JSON.stringify(status)).not.toContain('native secret sentinel');
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(files, { recursive: true, force: true }); }
});
