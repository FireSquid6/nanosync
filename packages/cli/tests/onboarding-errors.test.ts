import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/main';
import { pendingEnrollments } from '@nanosync/client-service';

test('successful malformed remote capabilities cannot reflect property names into CLI errors and preserve resumable identity', async () => {
  const root = mkdtempSync(join(tmpdir(), 'ns-cli-capabilities-'));
  const sentinel = 'TOKEN_SENTINEL_IN_UNTRUSTED_SUCCESS_PROPERTY';
  const http = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch(request) {
      if (new URL(request.url).pathname === '/v1/auth/password')
        return Response.json({ sessionToken: 'A'.repeat(43) });
      return Response.json({ [sentinel]: true });
    },
  });
  const stdout: string[] = [],
    stderr: string[] = [];
  const out = spyOn(console, 'log').mockImplementation((value) => stdout.push(String(value)));
  const err = spyOn(console, 'error').mockImplementation((value) => stderr.push(String(value)));
  const previous = process.env.NANOSYNC_PASSWORD;
  process.env.NANOSYNC_PASSWORD = 'temporary-owner-password';
  try {
    const args = [
      'client',
      'connections',
      'add',
      '--client-dir',
      root,
      '--credential-mode',
      'protected-file',
      '--url',
      http.url.href,
      '--alias',
      'test',
      '--device-name',
      'test',
      '--wait-ms',
      '0',
      '--non-interactive',
      '--json',
    ];
    expect(await main(args)).toBe(5);
    const pending = pendingEnrollments(root)[0]!;
    expect(await main(args)).toBe(5);
    expect(pendingEnrollments(root)[0]).toEqual(pending);
    expect(
      stderr.filter((line) => line.startsWith('{"ok":false')).map((line) => JSON.parse(line)),
    ).toEqual([
      { ok: false, code: 'INVALID_RESPONSE', message: 'Invalid server capabilities', exitCode: 5 },
      { ok: false, code: 'INVALID_RESPONSE', message: 'Invalid server capabilities', exitCode: 5 },
    ]);
    expect(JSON.stringify({ stdout, stderr })).not.toContain(sentinel);
    expect(JSON.stringify({ stdout, stderr })).not.toContain('temporary-owner-password');
  } finally {
    if (previous === undefined) delete process.env.NANOSYNC_PASSWORD;
    else process.env.NANOSYNC_PASSWORD = previous;
    out.mockRestore();
    err.mockRestore();
    http.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
