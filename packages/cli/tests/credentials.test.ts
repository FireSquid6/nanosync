import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { main } from '../src/main.ts';
import { privateDirectory, secureCreate } from '@nanosync/client-service';

test('new CLI roots require explicit mode, old roots stay headless, and migration requires its own confirmation', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-cli-credentials-'));
  const out = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  const invoke = (args: string[]) =>
    main([...args, '--client-dir', root, '--json', '--non-interactive']);
  try {
    expect(
      await invoke([
        'client',
        'connections',
        'add',
        '--url',
        'https://example.test',
        '--alias',
        'home',
      ]),
    ).toBe(2);
    expect(JSON.parse(String(err.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      code: 'INPUT_REQUIRED',
      exitCode: 2,
    });
    const serverId = randomUUID();
    secureCreate(
      join(privateDirectory(join(root, 'servers')), `${serverId}.json`),
      JSON.stringify({
        version: 1,
        serverId,
        deviceId: randomUUID(),
        token: 'A'.repeat(43),
        name: 'home',
        baseUrl: 'https://example.test',
      }),
    );
    expect(await invoke(['client', 'connections', 'add', '--url', 'https://example.test'])).toBe(0);
    expect(await invoke(['client', 'credentials', 'view'])).toBe(0);
    expect(JSON.parse(String(out.mock.lastCall?.[0])).data.mode).toBe('protected-file');
    expect(await invoke(['client', 'credentials', 'migrate', '--yes'])).toBe(2);
    expect(JSON.parse(String(err.mock.lastCall?.[0])).code).toBe('CONFIRMATION_REQUIRED');
    expect(await invoke(['client', 'credentials', 'resume', '--yes'])).toBe(2);
    expect(await invoke(['client', 'credentials', 'rollback', '--yes'])).toBe(2);
    expect(out.mock.calls.flat().join('\n')).not.toContain('A'.repeat(43));
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});

test('invalid secret JSON is reported safely through the existing error envelope', async () => {
  const root = mkdtempSync(join(tmpdir(), 'nanosync-cli-credentials-'));
  const out = spyOn(console, 'log').mockImplementation(() => {});
  const err = spyOn(console, 'error').mockImplementation(() => {});
  try {
    secureCreate(
      join(privateDirectory(join(root, 'servers')), `${randomUUID()}.json`),
      '{"token":"secret-json-sentinel" INVALID',
    );
    expect(
      await main([
        'client',
        'connections',
        'view',
        '--client-dir',
        root,
        '--json',
        '--non-interactive',
      ]),
    ).toBe(2);
    expect(JSON.parse(String(err.mock.lastCall?.[0]))).toMatchObject({
      ok: false,
      code: 'CREDENTIAL_STATE_INVALID',
      exitCode: 2,
    });
    expect(err.mock.calls.flat().join('\n')).not.toContain('secret-json-sentinel');
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(root, { recursive: true, force: true });
  }
});
