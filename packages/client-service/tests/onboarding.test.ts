import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  readPreferences,
  readSettings,
  setLifecycle,
  setPaused,
  credentialStatus,
  initializeCredentials,
  onboardingSnapshot,
  credentialDecision,
  migrateCredentials,
  resumeCredentialMigration,
  rollbackCredentialMigration,
  privateDirectory,
  secureCreate,
  listRemoteVaults,
  acquireSyncLock,
  unlockVault,
} from '../src/index.ts';
import type { CredentialStore } from '../src/index.ts';

const choices = { startAtLogin: true, trayEnabled: false, keepSyncingAfterClose: true };
test('lifecycle settings migrate only on explicit save and preserve independent pauses and revisions', () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-preferences-'));
  try {
    expect(readPreferences(root)).toMatchObject({
      version: 2,
      revision: 0,
      lifecycle: { startAtLogin: false, trayEnabled: null, keepSyncingAfterClose: true },
      continuousRequested: {},
    });
    expect(existsSync(join(root, 'settings.json'))).toBe(false);
    const binding = randomUUID();
    setPaused(root, { binding }, true);
    const original = readFileSync(join(root, 'settings.json'), 'utf8');
    readPreferences(root);
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(original);
    const saved = setLifecycle(root, choices, 1);
    expect(saved).toMatchObject({
      version: 2,
      revision: 2,
      lifecycle: choices,
      bindingPaused: { [binding]: true },
    });
    setPaused(root, { all: true }, true);
    expect(readPreferences(root)).toMatchObject({
      revision: 3,
      globalPaused: true,
      lifecycle: choices,
      bindingPaused: { [binding]: true },
    });
    expect(() => setLifecycle(root, { ...choices, startAtLogin: false }, 2)).toThrow('refresh');
    expect(readPreferences(root).lifecycle.startAtLogin).toBe(true);
    expect(credentialStatus(root).mode).toBe('uninitialized');
    expect(() => setLifecycle(root, { ...choices, trayEnabled: null }, 3)).toThrow('Choose');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('v2 upgrade refuses an older or unadvertised live owner before modifying shared settings', () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-settings-owner-'));
  let release: (() => void) | undefined;
  try {
    setPaused(root, { all: true }, false);
    const before = readFileSync(join(root, 'settings.json'), 'utf8');
    release = acquireSyncLock(
      privateDirectory(join(privateDirectory(join(root, 'replicas')), randomUUID())),
    );
    expect(() => setLifecycle(root, choices, 1)).toThrow('Stop every older');
    expect(readFileSync(join(root, 'settings.json'), 'utf8')).toBe(before);
    release();
    release = undefined;
    expect(setLifecycle(root, choices, 1).version).toBe(2);
  } finally {
    release?.();
    rmSync(root, { recursive: true, force: true });
  }
});
test('credential decision and initial snapshot are non-mutating and omit native effects', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ns-uninitialized-')),
    root = join(parent, 'absent');
  try {
    expect(onboardingSnapshot(root)).toMatchObject({
      credentials: { mode: 'uninitialized' },
      connections: [],
      pending: [],
      status: null,
      nativeEffects: { tray: 'not-installed' },
    });
    expect(existsSync(root)).toBe(false);
    initializeCredentials(root, 'protected-file');
    expect(onboardingSnapshot(root).credentials.decisionRequired).toBe(true);
    expect(existsSync(join(root, 'servers'))).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
test.each(['copying', 'cleanup'] as const)(
  'safe migration summary supports resumable %s decision without inventory',
  async (phase) => {
    const root = mkdtempSync(join(tmpdir(), 'ns-migration-summary-'));
    const values = new Map<string, string>();
    const store: CredentialStore = {
      async get(ref) {
        return values.get(ref.name) ?? null;
      },
      async set(ref) {
        values.set(ref.name, ref.value);
      },
      async delete(ref) {
        return values.delete(ref.name);
      },
    };
    try {
      initializeCredentials(root, 'protected-file');
      await expect(
        migrateCredentials(root, true, {
          store,
          checkpoint(name) {
            if (name === (phase === 'copying' ? 'migration-intent' : 'migration-cleanup-intent'))
              throw Error('simulated crash');
          },
        }),
      ).rejects.toThrow('simulated crash');
      expect(credentialDecision(root)).toEqual({
        mode: 'protected-file',
        decisionRequired: true,
        migrationPending: true,
        cleanupPending: false,
        phase,
        canRollback: phase !== 'cleanup',
      });
      expect(onboardingSnapshot(root).connections).toEqual([]);
      if (phase === 'copying') await rollbackCredentialMigration(root, true, { store });
      else await resumeCredentialMigration(root, true, { store });
      expect(credentialDecision(root).migrationPending).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
test('malformed successful vault and recovery responses are rejected without echoing server values', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-vault-dto-'));
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      return Response.json(
        new URL(request.url).pathname === '/v1/recovery-wrap'
          ? { recoveryWrap: { 'secret-sentinel': true } }
          : { vaults: [{ vaultId: 'secret-sentinel', name: 'secret-sentinel' }] },
      );
    },
  });
  try {
    initializeCredentials(root, 'protected-file');
    const serverId = randomUUID(),
      deviceId = randomUUID();
    secureCreate(
      join(privateDirectory(join(root, 'servers')), `${serverId}.json`),
      JSON.stringify({
        version: 1,
        serverId,
        deviceId,
        name: 'test',
        baseUrl: http.url.href.replace(/\/$/, ''),
        token: 'A'.repeat(43),
      }),
    );
    const info = { version: 1 as const, serverId, deviceId, name: 'test', baseUrl: http.url.href };
    await expect(listRemoteVaults(root, info)).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Invalid vault list',
    });
    await expect(unlockVault(root, info, randomUUID(), 'unused-key')).rejects.toMatchObject({
      code: 'INVALID_RESPONSE',
      message: 'Invalid server recovery wrap',
      exitCode: 5,
    });
  } finally {
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
