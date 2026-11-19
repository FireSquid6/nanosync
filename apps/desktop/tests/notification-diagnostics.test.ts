import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createDesktopBackend, validateCommand } from '../src/backend';
import { createNativeNotifications } from '../src/notify-native';
import { readPreferences } from '@nanosync/client-service';

test('unavailable helper never falls back to SDK shell delivery or claims acceptance', async () => {
  const native = createNativeNotifications(
    () => {
      throw Error('Unexpected reopen');
    },
    {
      python: '/not-trusted/python',
      typelibs: '/not-trusted',
      delivery() {
        throw Error('Unexpected acceptance');
      },
    },
  );
  expect(await native.probe()).toBe(false);
  expect(native.status).toEqual({
    available: false,
    actions: false,
    code: 'NOTIFICATIONS_UNAVAILABLE',
  });
  await native.close();
});

test('narrow notification/export RPC rejects renderer paths and nonboolean privacy options', () => {
  for (const value of [
    { type: 'diagnostics-export', includeIdentifiers: false, path: '/private' },
    { type: 'diagnostics-export', includeIdentifiers: 'yes' },
    { type: 'notifications-settings', notifications: { enabled: true }, expectedRevision: 0 },
  ])
    expect(() => validateCommand(value)).toThrow();
});
test('actual backend shares nonsecret settings and exports only to native picked ordinary directory; cancel and shutdown safe', async () => {
  const base = mkdtempSync('/tmp/ns-desktop-diag-'),
    root = join(base, 'state'),
    documents = join(base, 'Documents');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(documents, { mode: 0o755 });
  let paths: string[] = [],
    picked = 0;
  const backend = createDesktopBackend(root, {
    pickFolder: async () => {
      picked++;
      return paths;
    },
    openAdministration: async () => ({ ok: false }),
    quit() {},
    notificationStatus: () => ({
      available: false,
      actions: false,
      code: 'NOTIFICATIONS_UNAVAILABLE',
    }),
  });
  try {
    const notifications = {
      ...readPreferences(root).notifications,
      enabled: false,
      conflicts: false,
    };
    const saved = await backend.execute({
      type: 'notifications-settings',
      notifications,
      expectedRevision: 0,
    });
    expect(saved.ok).toBe(true);
    if (saved.ok) {
      expect(saved.snapshot.credentials.mode).toBe('uninitialized');
      expect(saved.snapshot.notifications?.available).toBe(false);
    }
    const cancelled = await backend.execute({
      type: 'diagnostics-export',
      includeIdentifiers: false,
    });
    expect(cancelled.ok && cancelled.cancelled).toBe(true);
    expect(readdirSync(documents)).toEqual([]);
    paths = [documents];
    const exported = await backend.execute({
      type: 'diagnostics-export',
      includeIdentifiers: false,
    });
    expect(exported.ok && exported.diagnostics).toEqual({
      version: 1,
      exported: true,
      includeIdentifiers: false,
    });
    const files = readdirSync(documents);
    expect(files).toHaveLength(1);
    const report = JSON.parse(readFileSync(join(documents, files[0]!), 'utf8'));
    expect(report.identifiers).toBeUndefined();
    expect(report.native.notifications).toBe('unavailable');
    paths = [root];
    const unsafe = await backend.execute({
      type: 'diagnostics-export',
      includeIdentifiers: true,
    });
    expect(unsafe.ok).toBe(false);
    if (!unsafe.ok) expect(unsafe.code).toBe('DIAGNOSTICS_DESTINATION_UNSAFE');
    expect(picked).toBe(3);
    await backend.shutdown();
    expect(
      (await backend.execute({ type: 'diagnostics-export', includeIdentifiers: false })).ok,
    ).toBe(false);
  } finally {
    await backend.shutdown();
    rmSync(base, { recursive: true, force: true });
  }
});
