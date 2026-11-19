import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyVerifiedPatch, digest } from '../../../build/desktop/security';

test('patches apply inside a nested checkout rather than being silently skipped by parent Git', () => {
  const directory = mkdtempSync(join(tmpdir(), 'nanosync-nested-patch-'));
  try {
    const parent = Bun.spawnSync(['git', 'init', '--quiet', directory]);
    expect(parent.exitCode).toBe(0);
    const nested = join(directory, '.cache/source');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'probe.txt'), 'BEFORE\n');
    const patch = join(directory, 'probe.patch');
    writeFileSync(patch, '--- a/probe.txt\n+++ b/probe.txt\n@@ -1 +1 @@\n-BEFORE\n+AFTER\n');
    applyVerifiedPatch(nested, patch, { 'probe.txt': digest('AFTER\n') });
    expect(readFileSync(join(nested, 'probe.txt'), 'utf8')).toBe('AFTER\n');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
