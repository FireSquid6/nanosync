import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPreferences, setPaused, credentialStatus } from '@nanosync/client-service';
import { main } from '../src/main';

test('headless CLI lifecycle settings share revision-checked intent without claiming installed effects or changing pause flags', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-cli-settings-'));
  const stdout: string[] = [],
    stderr: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const err = spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  try {
    expect(
      await main([
        'client',
        'settings',
        'view',
        '--client-dir',
        root,
        '--json',
        '--non-interactive',
      ]),
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!).data).toMatchObject({
      settings: { revision: 0, lifecycle: { trayEnabled: null } },
      nativeEffects: 'not-applied',
    });
    setPaused(root, { all: true }, true);
    const args = [
      'client',
      'settings',
      'set',
      '--client-dir',
      root,
      '--json',
      '--non-interactive',
      '--start-at-login',
      'true',
      '--tray-enabled',
      'false',
      '--keep-syncing-after-close',
      'true',
      '--expected-revision',
      '1',
    ];
    expect(await main(args)).toBe(0);
    expect(JSON.parse(stdout.pop()!).data).toMatchObject({
      settings: {
        version: 2,
        revision: 2,
        globalPaused: true,
        lifecycle: { startAtLogin: true, trayEnabled: false, keepSyncingAfterClose: true },
      },
      nativeEffects: 'not-applied',
    });
    expect(readPreferences(root).globalPaused).toBe(true);
    expect(credentialStatus(root).mode).toBe('uninitialized');
    expect(await main(args)).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({ ok: false, code: 'CONFLICT', exitCode: 2 });
    expect(
      await main([
        'client',
        'settings',
        'set',
        '--client-dir',
        root,
        '--json',
        '--start-at-login',
        'yes',
      ]),
    ).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({ code: 'INVALID_INPUT', exitCode: 2 });
    expect(await main(['client', 'resume', '--all', '--client-dir', root, '--json'])).toBe(0);
    expect(JSON.parse(stdout.pop()!).data).toEqual({
      version: 1,
      revision: 3,
      globalPaused: false,
      bindingPaused: {},
    });
    expect(readPreferences(root).lifecycle.startAtLogin).toBe(true);
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
