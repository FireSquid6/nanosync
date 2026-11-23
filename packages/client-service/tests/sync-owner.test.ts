import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSyncLock, inspectSyncOwner } from "../src/sync-lock.ts";
test('owner inspection is read-only and distinguishes live, absent, stale and invalid locks', () => {
  const root = mkdtempSync(join(tmpdir(), 'sync-owner-'));
  try {
    expect(inspectSyncOwner(root)).toBeNull();
    const release = acquireSyncLock(root);
    expect(inspectSyncOwner(root)?.pid).toBe(process.pid);
    release();
    const path = join(root, '.sync-owner');
    const stale = '2147483647:1\n';
    writeFileSync(path, stale, { mode: 0o600 });
    expect(inspectSyncOwner(root)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(stale);
    writeFileSync(path, 'invalid');
    expect(() => inspectSyncOwner(root)).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
