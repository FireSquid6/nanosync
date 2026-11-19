import { expect, spyOn, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConnection,
  disconnectConnections,
  initializeCredentials,
  removalStatus,
} from '@nanosync/client-service';
import { main } from '../src/main';
test('headless conflict, ignore and durable removal CLI commands retain envelopes, CAS and explicit abandonment', async () => {
  const base = mkdtempSync('/tmp/ns-cli-tools-'),
    root = join(base, 'state'),
    files = join(base, 'files'),
    input = join(base, 'rules');
  mkdirSync(root, { mode: 0o700 });
  mkdirSync(files);
  initializeCredentials(root, 'protected-file');
  const binding = createConnection(root, files, randomUUID(), randomUUID(), randomUUID());
  const stdout: string[] = [],
    stderr: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((value) => {
    stdout.push(String(value));
  });
  const err = spyOn(console, 'error').mockImplementation((value) => {
    stderr.push(String(value));
  });
  const run = (args: string[]) =>
    main(['client', ...args, '--client-dir', root, '--json', '--non-interactive']);
  try {
    expect(await run(['conflicts', 'view', '--path', files])).toBe(0);
    expect(JSON.parse(stdout.pop()!)).toMatchObject({
      ok: true,
      code: 'OK',
      data: {
        version: 1,
        bindings: [{ connectionId: binding.connectionId, conflicts: [] }],
      },
    });
    writeFileSync(input, '', { mode: 0o600 });
    expect(await run(['ignores', 'validate', '--file', input])).toBe(0);
    expect(
      await run([
        'ignores',
        'set',
        '--path',
        files,
        '--file',
        input,
        '--expected-signature',
        'absent',
      ]),
    ).toBe(0);
    expect(readFileSync(join(files, '.nanosyncignore'), 'utf8')).toBe('');
    expect(
      await run([
        'ignores',
        'set',
        '--path',
        files,
        '--file',
        input,
        '--expected-signature',
        'absent',
      ]),
    ).toBe(2);
    expect(JSON.parse(stderr.pop()!)).toMatchObject({
      ok: false,
      code: 'CONFLICT',
      exitCode: 2,
    });
    writeFileSync(input, '!PRIVATE_PATTERN_SENTINEL');
    expect(await run(['ignores', 'validate', '--file', input])).toBe(2);
    const invalid = stderr.pop()!;
    expect(invalid).not.toContain('PRIVATE_PATTERN_SENTINEL');
    expect(JSON.parse(invalid)).toMatchObject({
      ok: false,
      code: 'IGNORE_INVALID',
      exitCode: 2,
    });
    writeFileSync(join(files, 'keep'), 'preserve');
    expect(await run(['vaults', 'disconnect', '--path', files, '--yes'])).toBe(2);
    expect(removalStatus(root)).toBeNull();
    await expect(
      disconnectConnections(root, [binding], true, {
        checkpoint(phase) {
          if (phase === 'removal-record') throw Error('crash');
        },
      }),
    ).rejects.toThrow('crash');
    expect(await run(['removals', 'view'])).toBe(0);
    const pending = JSON.parse(stdout.pop()!).data.pending;
    expect(pending.bindings[0].connection.connectionId).toBe(binding.connectionId);
    expect(await run(['removals', 'resume', '--request-id', pending.requestId, '--yes'])).toBe(2);
    expect(
      await run(['removals', 'resume', '--request-id', pending.requestId, '--confirm-removal']),
    ).toBe(0);
    expect(JSON.parse(stdout.pop()!).data).toMatchObject({
      completed: true,
      filesPreserved: true,
      remotelyRevoked: false,
    });
    expect(readFileSync(join(files, 'keep'), 'utf8')).toBe('preserve');
  } finally {
    out.mockRestore();
    err.mockRestore();
    rmSync(base, { recursive: true, force: true });
  }
});
