import { ClientLocal } from '@nanosync/client-local';
import type { ManifestV1 } from '@nanosync/sync-core';
import { test, expect } from 'bun:test';
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  readFileSync,
  symlinkSync,
  linkSync,
  renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection, disconnectConnections } from '../src/connections.ts';
import { setPreferences, setPaused, readPreferences, startBoundSync } from '../src/index.ts';
import { credentialStatus } from '../src/credentials.ts';
import {
  confirmFailure,
  recordStartFailure,
  readObservation,
  writeObservation,
  type SyncObservation,
} from '../src/status.ts';
import {
  createNotificationSelection,
  claimNotifications,
  deliverNotifications,
  recordNotificationDelivery,
  notificationText,
} from '../src/notifications.ts';
import { acquireSyncLock } from '../src/sync-lock.ts';
import { privateDirectory, secureCreate } from '../src/security.ts';
import { ClientError } from '../src/errors.ts';
import { SyncRunner } from '../src/sync-runner.ts';

function fixture() {
  const base = mkdtempSync('/tmp/ns-notifications-'),
    root = join(base, 'state'),
    files = join(base, 'files');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(files);
  const binding = createConnection(root, files, randomUUID(), randomUUID(), randomUUID());
  const replica = join(root, 'replicas', binding.connectionId);
  const observation: SyncObservation = {
    version: 2,
    failureEpisode: null,
    observedAt: 0,
    phase: 'offline',
    owner: null,
    lock: null,
    progress: { upload: { count: 0, bytes: 0 }, download: { count: 0, bytes: 0 } },
    facts: null,
    enginePhase: null,
    verified: false,
    lastRemoteCheck: null,
    lastSuccess: null,
    error: 'UNAVAILABLE',
    attentionError: null,
    statusIssues: [],
  };
  return {
    base,
    root,
    files,
    binding,
    replica,
    observation,
    close: () => rmSync(base, { recursive: true, force: true }),
  };
}
test('settings v3 patches preserve intent and CAS; notifications alone never choose credentials', () => {
  const root = mkdtempSync('/tmp/ns-notify-settings-');
  try {
    expect(readPreferences(root).notifications).toEqual({
      enabled: true,
      conflicts: true,
      revokedAccess: true,
      persistentFailures: true,
      includeNamesAndPaths: false,
    });
    setPaused(root, { all: true }, true);
    setPreferences(root, { notifications: { conflicts: false } }, 1);
    setPreferences(
      root,
      { lifecycle: { startAtLogin: false, trayEnabled: false, keepSyncingAfterClose: true } },
      2,
    );
    setPreferences(root, { notifications: { enabled: false } }, 3);
    expect(readPreferences(root)).toMatchObject({
      version: 3,
      globalPaused: true,
      notifications: { enabled: false, conflicts: false, revokedAccess: true },
    });
    expect(credentialStatus(root).mode).toBe('uninitialized');
    expect(() => setPreferences(root, { notifications: { conflicts: true } }, 3)).toThrow(
      'changed',
    );
    for (const patch of [
      {},
      { notifications: {} },
      { notifications: { success: true } },
      { notifications: { enabled: 'yes' } },
    ])
      expect(() => setPreferences(root, patch as never, 4)).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('discovery v2 is not notification-schema compatibility proof, before settings or incident writes', async () => {
  const state = fixture();
  const other = randomUUID(),
    replica = privateDirectory(join(state.root, 'replicas', other));
  const release = acquireSyncLock(replica);
  try {
    secureCreate(join(replica, '.sync-control'), JSON.stringify({ version: 2 }));
    expect(() => setPreferences(state.root, { notifications: { enabled: false } }, 0)).toThrow(
      'Stop every older',
    );
    await expect(startBoundSync(state.root, state.files)).rejects.toThrow('Stop every older');
    expect(() => readFileSync(join(state.replica, 'status.json'))).toThrow();
  } finally {
    release();
    state.close();
  }
});

test('five-minute policy needs fresh confirmed failures, survives retry/code/pause/restart, and clears only on success', () => {
  const state = fixture();
  try {
    const select = createNotificationSelection(state.root);
    state.observation.failureEpisode = confirmFailure(null, 'UNAVAILABLE', 0);
    writeObservation(state.replica, state.observation);
    expect(select()).toEqual([]);
    const id = state.observation.failureEpisode.id;
    state.observation.failureEpisode = confirmFailure(
      state.observation.failureEpisode,
      'OPERATION_FAILED',
      299999,
    );
    writeObservation(state.replica, state.observation);
    expect(select()).toEqual([]);
    state.observation.failureEpisode = confirmFailure(
      state.observation.failureEpisode,
      'OPERATION_FAILED',
      300000,
    );
    writeObservation(state.replica, state.observation);
    const eligible = select();
    expect(eligible).toHaveLength(1);
    expect(eligible[0]!.incidents).toEqual([
      `${state.binding.connectionId}/persistentFailures/${id}`,
    ]);
    const claimed = claimNotifications(state.root, eligible);
    expect(claimed).toHaveLength(1);
    expect(claimNotifications(state.root, eligible)).toEqual([]);
    recordNotificationDelivery(state.root, claimed[0]!, 42);
    recordNotificationDelivery(state.root, claimed[0]!, 42, true);
    const ledger = JSON.parse(
      readFileSync(join(state.root, 'notification-delivery.json'), 'utf8'),
    );
    expect(Object.values(ledger.entries)).toEqual([
      { disposition: 'dismissed', nativeId: 42, attemptId: claimed[0]!.attemptId },
    ]);
    const restart = createNotificationSelection(state.root);
    expect(restart()).toEqual([]);
    setPaused(state.root, { all: true }, true);
    state.observation.phase = 'paused';
    state.observation.failureEpisode = confirmFailure(
      state.observation.failureEpisode,
      'UNAVAILABLE',
      400000,
    );
    writeObservation(state.replica, state.observation);
    expect(claimNotifications(state.root, restart())).toEqual([]);
    expect(state.observation.failureEpisode.id).toBe(id);
    state.observation.failureEpisode = null;
    writeObservation(state.replica, state.observation);
    expect(restart()).toEqual([]);
    state.observation.failureEpisode = confirmFailure(null, 'UNAVAILABLE', 500000);
    expect(state.observation.failureEpisode.id).not.toBe(id);
  } finally {
    state.close();
  }
});
test('access category uses real authorization codes, no duplicate persistent failure and no default identifying text', () => {
  const state = fixture();
  try {
    state.observation.failureEpisode = confirmFailure(null, 'UNAUTHORIZED', 1);
    writeObservation(state.replica, state.observation);
    const result = createNotificationSelection(state.root)();
    expect(result.map((item) => item.category)).toEqual(['revokedAccess']);
    expect(result[0]!.body).not.toContain(state.files);
    expect(result[0]!.body).not.toContain('revoked');
    setPreferences(state.root, { notifications: { enabled: false } }, 0);
    expect(createNotificationSelection(state.root)()).toEqual([]);
    expect(readObservation(state.replica)?.failureEpisode).toEqual(
      state.observation.failureEpisode,
    );
    setPreferences(
      state.root,
      { notifications: { enabled: true, includeNamesAndPaths: true } },
      1,
    );
    expect(createNotificationSelection(state.root)()[0]!.body).toContain(state.files);
  } finally {
    state.close();
  }
});
test('1000 eligible conflict members make one durable batch; subsets/resolution cannot renotify', () => {
  const state = fixture();
  try {
    const incidents = Array.from(
      { length: 1000 },
      () => `${state.binding.connectionId}/conflicts/${randomUUID()}/${randomUUID()}`,
    );
    const batch = { category: 'conflicts' as const, incidents, body: 'Generic' };
    expect(claimNotifications(state.root, [batch])).toHaveLength(1);
    expect(
      claimNotifications(state.root, [{ ...batch, incidents: incidents.slice(10) }]),
    ).toEqual([]);
    expect(credentialStatus(state.root).mode).toBe('protected-file');
    const tooMany = Array.from(
      { length: 10000 },
      () => `${state.binding.connectionId}/conflicts/${randomUUID()}/${randomUUID()}`,
    );
    expect(() => claimNotifications(state.root, [{ ...batch, incidents: tooMany }])).toThrow(
      'full',
    );
    expect(claimNotifications(state.root, [batch])).toEqual([]);
  } finally {
    state.close();
  }
});
test('ledger substitutions fail closed, and markup/control/private filenames cannot become native markup', () => {
  for (const hardlink of [false, true]) {
    const state = fixture();
    try {
      const target = join(state.root, 'source');
      secureCreate(target, '{"version":1,"entries":{}}');
      const ledger = join(state.root, 'notification-delivery.json');
      if (hardlink) linkSync(target, ledger);
      else symlinkSync(target, ledger);
      expect(() => claimNotifications(state.root, [])).toThrow('unsafe');
    } finally {
      state.close();
    }
  }
  expect(notificationText('a'.repeat(511) + '😀')).toBe('a'.repeat(511) + '😀');
  expect(notificationText('--option <a href="file:///private">$(touch x)</a>\n\u202e')).toBe(
    '--option &lt;a href=&quot;file:///private&quot;&gt;$(touch x)&lt;/a&gt;  ',
  );
});
test('authoritative conflict resolution/removal prunes claims, unknown/disabled observations preserve them, same lineage reopening alerts again', async () => {
  const state = fixture();
  const conflict = randomUUID(),
    revision = randomUUID();
  const manifest: ManifestV1 = {
    version: 1,
    vaultId: state.binding.vaultId,
    revisionId: revision,
    parents: [],
    creatingDeviceId: state.binding.deviceId,
    entries: [
      {
        id: conflict,
        parentId: null,
        name: 'private-copy',
        kind: 'file',
        size: 0,
        sha256: '0'.repeat(64),
        chunks: [],
        conflict: { sourceEntryId: randomUUID(), sourceRevisionId: revision },
      },
    ],
  };
  function reconcile(open: boolean) {
    const local = new ClientLocal(state.replica, state.binding.vaultId, state.binding.deviceId);
    try {
      local.upsertEntry({
        id: conflict,
        path: 'private-copy',
        kind: 'file',
        fingerprint: null,
        hydration: 'downloaded',
        revision,
      });
      for (const kind of ['observed', 'accepted', 'applied'] as const)
        local.recordHead(kind, { revisionId: revision, sequence: 1 });
      local.reconcileConflicts({ ...manifest, entries: open ? manifest.entries : [] });
    } finally {
      local.close();
    }
  }
  const entries = () =>
    Object.keys(
      JSON.parse(readFileSync(join(state.root, 'notification-delivery.json'), 'utf8')).entries,
    );
  try {
    reconcile(true);
    const select = createNotificationSelection(state.root);
    const first = claimNotifications(state.root, select());
    expect(first).toHaveLength(1);
    expect(claimNotifications(state.root, select())).toEqual([]);
    renameSync(state.replica, join(state.base, 'held'));
    mkdirSync(state.replica, { mode: 0o700 });
    select();
    expect(entries()).toHaveLength(1);
    rmSync(state.replica, { recursive: true });
    renameSync(join(state.base, 'held'), state.replica);
    setPreferences(state.root, { notifications: { conflicts: false } }, 0);
    reconcile(false);
    select();
    expect(entries()).toHaveLength(1);
    setPreferences(state.root, { notifications: { conflicts: true } }, 1);
    select();
    expect(entries()).toEqual([]);
    recordNotificationDelivery(state.root, first[0]!, 41, true);
    expect(entries()).toEqual([]);
    reconcile(true);
    const reopened = claimNotifications(state.root, select())[0]!;
    expect(reopened.incidents).toEqual(first[0]!.incidents);
    recordNotificationDelivery(state.root, first[0]!, 41, true);
    const row = Object.values(
      JSON.parse(readFileSync(join(state.root, 'notification-delivery.json'), 'utf8')).entries,
    )[0];
    expect(row).toMatchObject({
      disposition: 'attempted',
      nativeId: null,
      attemptId: reopened.attemptId,
    });
    await disconnectConnections(state.root, [state.binding], true);
    select();
    expect(entries()).toEqual([]);
  } finally {
    state.close();
  }
});

test('queued delivery rechecks global/category/privacy after every awaited submission and claims only admitted batches', async () => {
  for (const change of ['enabled', 'revokedAccess', 'includeNamesAndPaths'] as const) {
    const state = fixture(),
      entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    try {
      setPreferences(state.root, { notifications: { includeNamesAndPaths: true } }, 0);
      const first = `${state.binding.connectionId}/conflicts/${randomUUID()}/${randomUUID()}`;
      const second = `${state.binding.connectionId}/revokedAccess/${randomUUID()}`;
      const select = () => {
        const preferences = readPreferences(state.root).notifications;
        if (!preferences.enabled) return [];
        return [
          { category: 'conflicts' as const, incidents: [first], body: 'Generic' },
          ...(preferences.revokedAccess
            ? [
                {
                  category: 'revokedAccess' as const,
                  incidents: [second],
                  body: preferences.includeNamesAndPaths ? state.files : 'Generic',
                },
              ]
            : []),
        ];
      };
      const submitted: string[] = [];
      const work = deliverNotifications(state.root, select, {
        admit: () => true,
        async submit(batch) {
          submitted.push(batch.body);
          if (submitted.length === 1) {
            entered.resolve();
            await release.promise;
          }
        },
      });
      await entered.promise;
      setPreferences(state.root, { notifications: { [change]: false } }, 1);
      release.resolve();
      await work;
      expect(submitted).toEqual(
        change === 'includeNamesAndPaths' ? ['Generic', 'Generic'] : ['Generic'],
      );
      if (change !== 'includeNamesAndPaths') {
        setPreferences(
          state.root,
          { notifications: { enabled: true, revokedAccess: true } },
          2,
        );
        expect(claimNotifications(state.root, [select()[1]!])).toHaveLength(1);
      }
    } finally {
      release.resolve();
      state.close();
    }
  }
});

test('confirmed unavailable-folder starts persist a failure episode without recreating the root or journal', () => {
  const state = fixture();
  try {
    renameSync(state.files, join(state.base, 'missing-original'));
    const select = createNotificationSelection(state.root);
    recordStartFailure(
      state.root,
      state.binding,
      new ClientError('FOLDER_UNAVAILABLE', 'Restore original folder'),
      () => 0,
    );
    expect(select()).toEqual([]);
    recordStartFailure(
      state.root,
      state.binding,
      new ClientError('FOLDER_UNAVAILABLE', 'Restore original folder'),
      () => 300000,
    );
    expect(select().map((batch) => batch.category)).toEqual(['persistentFailures']);
    expect(() => readFileSync(join(state.files, '.nanosync'))).toThrow();
    expect(readObservation(state.replica)?.phase).toBe('folder-unavailable');
  } finally {
    state.close();
  }
});

test('real runner persists one episode across failed passes and restart using injected clock', async () => {
  const state = fixture();
  let now = 0;
  const options = {
    clientDirectory: state.replica,
    syncDirectory: state.files,
    vaultId: state.binding.vaultId,
    deviceId: state.binding.deviceId,
    masterKey: new Uint8Array(32),
    token: 'A'.repeat(43),
    baseUrl: 'http://127.0.0.1',
    now: () => now,
    fetch: Object.assign(() => Promise.reject(new TypeError('private-network-body')), {
      preconnect: fetch.preconnect,
    }),
  };
  let runner = SyncRunner.start(options);
  try {
    await expect(runner.syncOnce()).rejects.toThrow();
    const first = readObservation(state.replica)!.failureEpisode!;
    now = 300000;
    await expect(runner.syncOnce()).rejects.toThrow();
    expect(readObservation(state.replica)!.failureEpisode).toMatchObject({
      id: first.id,
      firstFailureAt: 0,
      lastFailureAt: 300000,
    });
    await runner.stop();
    runner = SyncRunner.start(options);
    expect(readObservation(state.replica)!.failureEpisode!.id).toBe(first.id);
    now = 400000;
    await expect(runner.syncOnce()).rejects.toThrow();
    expect(readObservation(state.replica)!.failureEpisode!.id).toBe(first.id);
  } finally {
    await runner.stop();
    state.close();
  }
});
