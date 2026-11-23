import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { acquireSyncLock, inspectSyncOwner } from "../src/sync-lock.ts";

test("kernel gate prevents a second writer during stale owner record removal", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "nanosync-sync-gate-"));
  const path = join(root, ".sync-owner");
  const proc = fs.readFileSync(`/proc/${process.pid}/stat`, "utf8");
  const start = proc.slice(proc.lastIndexOf(") ") + 2).trim().split(/\s+/)[19]!;
  fs.writeFileSync(path, `${process.pid}:${BigInt(start) + 1n}\n`, { mode: 0o600 });
  const unlink = fs.unlinkSync;
  let attempted = false;
  let competing: (() => void) | undefined;
  let release: (() => void) | undefined;
  const interception = spyOn(fs, "unlinkSync").mockImplementation(file => {
    if (String(file) === path && !attempted) {
      attempted = true;
      // Reenter precisely between the stale inode check and unlink. The old
      // hardlink-only algorithm allowed both acquisitions to succeed here.
      expect(() => { competing = acquireSyncLock(root); }).toThrow("another live process");
    }
    unlink(file);
  });
  try {
    release = acquireSyncLock(root);
    expect(attempted).toBe(true);
    expect(competing).toBeUndefined();
    expect(inspectSyncOwner(root)?.pid).toBe(process.pid);
    release(); release = undefined;
    expect(inspectSyncOwner(root)).toBeNull();
    expect(fs.existsSync(join(root, ".sync-gate"))).toBe(true);
    release = acquireSyncLock(root);
    expect(inspectSyncOwner(root)?.pid).toBe(process.pid);
  } finally {
    interception.mockRestore();
    competing?.(); release?.();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
