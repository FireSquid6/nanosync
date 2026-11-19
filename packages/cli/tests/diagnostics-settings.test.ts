import { test, expect, spyOn } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { main } from '../src/main.ts';
import { readPreferences } from '@nanosync/client-service';

test('headless notification patches and explicit diagnostics keep envelopes, streams, exits and privacy defaults', async () => {
  const base = mkdtempSync('/tmp/ns-cli-diag-'),
    root = join(base, 'state'),
    output = join(base, 'Documents');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(output, { mode: 0o755 });
  const stdout: string[] = [],
    stderr: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const err = spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  const run = (args: string[]) =>
    main(['client', ...args, '--client-dir', root, '--json', '--non-interactive']);
  try {
    expect(
      await run(['settings', 'set', '--notify-conflicts', 'false', '--expected-revision', '0']),
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({
      ok: true,
      code: 'OK',
      data: {
        nativeEffects: 'not-applied',
        settings: { notifications: { conflicts: false, includeNamesAndPaths: false } },
      },
    });
    for (const flags of [
      [],
      ['--notify-conflicts', 'yes'],
      ['--tray-enabled', 'false'],
      ['--notify-conflicts', 'true', '--notify-conflicts', 'false'],
    ]) {
      expect(await run(['settings', 'set', ...flags])).toBe(2);
      expect(JSON.parse(stderr.pop()!)).toMatchObject({
        ok: false,
        code: 'INVALID_INPUT',
        exitCode: 2,
      });
      expect(readPreferences(root).notifications.conflicts).toBe(false);
    }
    const file = join(output, 'report.json');
    expect(await run(['diagnostics', 'export', '--output', file])).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toEqual({
      ok: true,
      code: 'OK',
      data: { version: 1, exported: true, includeIdentifiers: false },
    });
    const report = JSON.parse(readFileSync(file, 'utf8'));
    expect(report.version).toBe(1);
    expect(report.identifiers).toBeUndefined();
    expect(report.native.notifications).toBe('not-probed');
    expect(lstatSync(file).mode & 0o777).toBe(0o600);
    expect(await run(['diagnostics', 'export', '--output', file])).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({
      code: 'DIAGNOSTICS_DESTINATION_EXISTS',
      exitCode: 2,
    });
    expect(await run(['diagnostics', 'export'])).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({ code: 'INPUT_REQUIRED' });
    expect(await run(['removals', 'view', '--path', output, '--server', 'ambiguous'])).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({ code: 'INVALID_INPUT' });
    expect(readdirSync(output)).toEqual(['report.json']);
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(base, { recursive: true, force: true });
  }
});
