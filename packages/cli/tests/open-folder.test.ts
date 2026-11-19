import { expect, spyOn, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initializeCredentials, createConnection } from '@nanosync/client-service';
import { main } from '../src/main';

test('CLI open validates the saved binding, uses argv only and reports headless integration without affecting sync state', async () => {
  const parent = mkdtempSync('/tmp/ns-cli-open-'),
    root = join(parent, 'client'),
    files = join(parent, 'folder; $(not-a-command)');
  mkdirSync(files, { mode: 0o700 });
  initializeCredentials(root, 'protected-file');
  const binding = createConnection(root, files, randomUUID(), randomUUID(), randomUUID());
  const bin = join(parent, 'bin'),
    recorded = join(parent, 'opened');
  mkdirSync(bin, { mode: 0o700 });
  writeFileSync(join(bin, 'xdg-open'), `#!/bin/sh\nprintf '%s' "$1" > '${recorded}'\n`, {
    mode: 0o700,
  });
  const previous = {
    PATH: process.env.PATH,
    DISPLAY: process.env.DISPLAY,
    WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY,
  };
  const output: string[] = [],
    errors: string[] = [];
  const stdout = spyOn(console, 'log').mockImplementation((value) => output.push(String(value)));
  const stderr = spyOn(console, 'error').mockImplementation((value) => errors.push(String(value)));
  try {
    process.env.PATH = bin;
    process.env.DISPLAY = ':synthetic-no-display-opened';
    delete process.env.WAYLAND_DISPLAY;
    expect(Bun.which('xdg-open', { PATH: bin })).toBe(join(bin, 'xdg-open'));
    const args = [
      'client',
      'open',
      '--client-dir',
      root,
      '--path',
      files,
      '--json',
      '--non-interactive',
    ];
    expect(await main(args), errors.join('\n')).toBe(0);
    expect(readFileSync(recorded, 'utf8')).toBe(files);
    expect(JSON.parse(output.pop()!).data).toEqual({
      connectionId: binding.connectionId,
      opened: true,
    });
    delete process.env.DISPLAY;
    expect(await main(args)).toBe(2);
    expect(JSON.parse(errors.pop()!)).toMatchObject({
      code: 'NATIVE_INTEGRATION_UNAVAILABLE',
      exitCode: 2,
    });
    expect(readFileSync(recorded, 'utf8')).toBe(files);
  } finally {
    for (const key of ['PATH', 'DISPLAY', 'WAYLAND_DISPLAY'] as const) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
    stdout.mockRestore();
    stderr.mockRestore();
    rmSync(parent, { recursive: true, force: true });
  }
});
