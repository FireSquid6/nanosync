import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocal } from "@nanosync/client-local";
import type { HttpRemote, ManifestV1 } from "@nanosync/sync-core";
import { hydrateFile } from "../src/hydration.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("a racing destination is never overwritten; a two-link interruption replays safely", async () => {
  const root = mkdtempSync(join(tmpdir(), "nanosync-hydration-")); roots.push(root);
  const privateDir = join(root, "private"), sync = join(root, "sync");
  mkdirSync(privateDir, { mode: 0o700 }); mkdirSync(sync, { mode: 0o700 });
  const vault = "123e4567-e89b-12d3-a456-426614174000", device = "223e4567-e89b-12d3-a456-426614174000";
  const revision = "323e4567-e89b-12d3-a456-426614174000", rootId = "423e4567-e89b-12d3-a456-426614174000";
  const fileId = "523e4567-e89b-12d3-a456-426614174000", empty = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const manifest: ManifestV1 = { version: 1, vaultId: vault, revisionId: revision, parents: [], creatingDeviceId: device,
    entries: [{ id: rootId, parentId: null, name: "", kind: "directory" },
      { id: fileId, parentId: rootId, name: "empty.txt", kind: "file", size: 0, sha256: empty, executable: false, chunks: [] }] };
  let local = new ClientLocal(privateDir, vault, device);
  try {
    const head = { revisionId: revision, sequence: 1 };
    local.recordHead("observed", head); local.recordHead("accepted", head); local.recordHead("applied", head);
    const stat = lstatSync(sync);
    local.recordScan([{ id: rootId, path: "", kind: "directory", fingerprint: null, hydration: "downloaded", revision },
      { id: fileId, path: "empty.txt", kind: "file", fingerprint: empty, hydration: "evicted", revision }],
      [{ entryId: rootId, device: String(stat.dev), inode: String(stat.ino) }]);
    const remote = { async *downloadChunks() {}, async presence() { return new Set<string>(); } } as unknown as HttpRemote;
    const paused = new Error("paused");
    await expect(hydrateFile(sync, local, remote, manifest, { references: [] }, new Uint8Array(32), "download", "empty.txt", undefined, {
      beforeWork() { if (readdirSync(sync).some(name => name.startsWith(".nanosync-hydrate-"))) throw paused; },
    })).rejects.toBe(paused);
    expect(readdirSync(sync).some(name => name === "empty.txt")).toBe(false);
    const saved = local.pendingHydration()!;
    local.close(); local = new ClientLocal(privateDir, vault, device);
    expect(local.pendingHydration()).toEqual(saved);
    const args = [sync, local, remote, manifest, { references: [] }, new Uint8Array(32), "download", "empty.txt"] as const;
    await expect(hydrateFile(...args, saved, { beforeLink: () => writeFileSync(join(sync, "empty.txt"), "user data") }))
      .rejects.toThrow(/EEXIST/);
    expect(readFileSync(join(sync, "empty.txt"), "utf8")).toBe("user data");
    const intent = local.pendingHydration()!;
    expect(intent.direction).toBe("download");
    unlinkSync(join(sync, "empty.txt"));
    await expect(hydrateFile(...args, intent, { afterLink: () => { throw new Error("crash after link"); } })).rejects.toThrow(/crash after link/);
    const staged = join(sync, `.nanosync-hydrate-${intent.id}`);
    expect(lstatSync(staged).ino).toBe(lstatSync(join(sync, "empty.txt")).ino);
    expect(lstatSync(staged).nlink).toBe(2);
    await hydrateFile(...args, intent);
    expect(local.pendingHydration()).toBeNull();
    expect(local.entry(fileId)?.hydration).toBe("downloaded");
    expect(readdirSync(sync)).toEqual(["empty.txt"]);
    expect(local.head("applied")).toEqual(head);
    const evict = [sync, local, remote, manifest, { references: [] }, new Uint8Array(32), "evict", "empty.txt"] as const;
    await expect(hydrateFile(...evict, undefined, {
      beforeWork() { if (local.pendingHydration()) throw paused; },
    })).rejects.toBe(paused);
    expect(readFileSync(join(sync, "empty.txt")).length).toBe(0);
    await hydrateFile(...evict, local.pendingHydration()!);
    expect(local.pendingHydration()).toBeNull();
    expect(readdirSync(sync)).toEqual([]);
  } finally { local.close(); }
});
