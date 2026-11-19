import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('native opening preserves argv, discards child errors and exposes only fixed failures', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanosync-native-opening-'));
  try {
    const executable = join(directory, 'xdg-open');
    const recorded = join(directory, 'argv');
    writeFileSync(executable, '#!/bin/sh\nprintf "%s" "$1" > "' + recorded + '"\necho SYNTHETIC_NATIVE_ERROR >&2\ncase "$1" in *fail*) exit 7;; esac\n', { mode: 0o700 });
    const output = join(directory, 'opening.js');
    const build = await Bun.build({
      entrypoints: [join(import.meta.dir, '../src/open-native.ts')], target: 'bun',
      define: { NANOSYNC_XDG_OPEN: JSON.stringify(executable) },
    });
    expect(build.success).toBe(true);
    await Bun.write(output, build.outputs[0]!);
    const { openAdministration, openCheckedFolder } = await import(output);
    const url = 'https://$(synthetic).example/admin';
    expect(await openAdministration(url)).toEqual({ ok: true, code: 'OPENED' });
    expect(readFileSync(recorded, 'utf8')).toBe(url);
    expect(await openCheckedFolder(directory)).toEqual({ ok: true, code: 'OPENED' });
    expect(readFileSync(recorded, 'utf8')).toBe(directory);
    expect(await openAdministration('https://fail.example/admin')).toEqual({ ok: false, code: 'OPEN_FAILED' });
    for (const invalid of ['file:///tmp/a', 'https://user:password@example.test/admin', 'javascript:alert(1)', 'https://example.test/admin?key=secret']) {
      expect(await openAdministration(invalid)).toEqual({ ok: false, code: 'OPEN_FAILED' });
    }
    expect(await openCheckedFolder('relative')).toEqual({ ok: false, code: 'OPEN_FAILED' });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
