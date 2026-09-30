import { createHash, randomUUID } from "node:crypto";
import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync,
  openSync, readSync, unlinkSync, writeSync, type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { CHUNK_SIZE, parseObjectId, type VisibleObjectReference } from "@nanosync/protocol";
import { manifestPaths, type HttpRemote, type ManifestV1 } from "@nanosync/sync-core";
import { ClientLocal, type HydrationIntent } from "@nanosync/client-local";

const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
function at(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function ownedFile(st: Stats, linked = false) {
  if (!st.isFile() || st.nlink !== (linked ? 2 : 1) || st.uid !== process.getuid!() || st.mode & 0o022) throw new Error("unsafe hydration file");
}
function fileDigest(fd: number, st: Stats, links = 1): string {
  const digest = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < st.size;) {
    const count = readSync(fd, buffer, 0, Math.min(buffer.length, st.size - offset), offset);
    if (!count) throw new Error("hydration file truncated");
    digest.update(buffer.subarray(0, count));
    offset += count;
  }
  const after = fstatSync(fd);
  if (after.dev !== st.dev || after.ino !== st.ino || after.nlink !== links || after.size !== st.size || after.mtimeMs !== st.mtimeMs || after.ctimeMs !== st.ctimeMs)
    throw new Error("hydration file changed during verification");
  return digest.digest("hex");
}
class Anchor {
  readonly fd: number;
  readonly stat: Stats;
  constructor(readonly path: string, expected?: HydrationIntent) {
    this.fd = openSync(path, dirFlags);
    this.stat = fstatSync(this.fd);
    if (!this.stat.isDirectory() || this.stat.uid !== process.getuid!() || this.stat.mode & 0o022 ||
      expected && (String(this.stat.dev) !== expected.rootDevice || String(this.stat.ino) !== expected.rootInode)) {
      closeSync(this.fd);
      throw new Error("unsafe hydration root");
    }
    this.check();
  }
  check() {
    const st = lstatSync(this.path);
    if (st.dev !== this.stat.dev || st.ino !== this.stat.ino || !st.isDirectory() || st.uid !== process.getuid!() || st.mode & 0o022)
      throw new Error("hydration root moved");
  }
  parent<T>(relative: string, fn: (path: string, fd: number, check: () => void) => T): T {
    const parts = relative.split("/");
    if (!relative || parts.some(part => !part || part === "." || part === "..")) throw new Error("unsafe hydration path");
    let parent = this.fd;
    const chain: { fd: number; name: string; dev: number; ino: number }[] = [];
    try {
      for (const part of parts.slice(0, -1)) {
        const fd = openSync(`/proc/self/fd/${parent}/${part}`, dirFlags), st = fstatSync(fd);
        if (!st.isDirectory() || st.uid !== process.getuid!() || st.mode & 0o022) { closeSync(fd); throw new Error("unsafe hydration parent"); }
        chain.push({ fd: parent, name: part, dev: st.dev, ino: st.ino });
        parent = fd;
      }
      const check = () => {
        this.check();
        for (const item of chain) {
          const st = at(`/proc/self/fd/${item.fd}/${item.name}`);
          if (!st || st.dev !== item.dev || st.ino !== item.ino)
            throw new Error("hydration parent moved");
        }
      };
      check();
      const result = fn(`/proc/self/fd/${parent}/${parts.at(-1)}`, parent, check);
      check();
      return result;
    } finally {
      if (parent !== this.fd) closeSync(parent);
      for (const item of chain.slice(0, -1))
        if (item.fd !== this.fd) closeSync(item.fd);
    }
  }
  close() { closeSync(this.fd); }
}
function verifyFile(anchor: Anchor, path: string, size: number, digest: string, executable: boolean, identity?: HydrationIntent, links = 1): Stats {
  return anchor.parent(path, (target, _fd, check) => {
    const before = lstatSync(target); ownedFile(before, links === 2);
    if (identity && (String(before.dev) !== identity.fileDevice || String(before.ino) !== identity.fileInode)) throw new Error("eviction file identity changed");
    if (before.size !== size || !!(before.mode & 0o100) !== executable) throw new Error("local file differs from accepted revision");
    const fd = openSync(target, fileFlags);
    try { const opened = fstatSync(fd); if (opened.ino !== before.ino || opened.dev !== before.dev || fileDigest(fd, opened, links) !== digest) throw new Error("local file differs from accepted revision"); check(); return opened; }
    finally { closeSync(fd); }
  });
}
function stageName(intent: HydrationIntent) { return `.nanosync-hydrate-${intent.id}`; }

/** Same-head hydration. The daemon must serialize this with sync and check the remote head. */
export async function hydrateFile(
  root: string,
  local: ClientLocal,
  remote: HttpRemote,
  manifest: ManifestV1,
  revision: { references: readonly VisibleObjectReference[] },
  master: Uint8Array,
  direction: "evict" | "download",
  path: string,
  existing?: HydrationIntent,
  hooks: { beforeLink?: () => void; afterLink?: () => void } = {},
): Promise<{ path: string; hydration: "evicted" | "downloaded"; revisionId: string }> {
  const paths = manifestPaths(manifest), file = paths.get(path), localEntry = local.entries().find(entry => entry.path === path);
  if (!file || file.kind !== "file" || !localEntry || localEntry.id !== file.id || localEntry.fingerprint !== file.sha256 ||
      localEntry.revision !== manifest.revisionId) throw new Error("hydration path differs from authenticated manifest");
  if (localEntry.hydration !== (direction === "evict" ? "downloaded" : "evicted")) throw new Error(direction === "evict" ? "file is already remote-only" : "file is already downloaded");
  const anchor = new Anchor(resolve(root), existing);
  try {
    const referenceById = new Map(revision.references.map(ref => [ref.objectId, ref]));
    const references = file.chunks!.map(chunk => {
      const ref = referenceById.get(parseObjectId(chunk.objectId));
      if (!ref || ref.objectType !== "chunk" || ref.ciphertextLength !== chunk.length + 96) throw new Error("missing authenticated chunk reference");
      return ref;
    });
    let intent = existing;
    if (!intent) {
      if (direction === "evict") {
        const missing = await remote.presence("chunk", [...new Set(references.map(ref => ref.objectId))]);
        if (missing.size) throw new Error("cannot evict: remote ciphertext is missing");
      }
      const stat = direction === "evict" ? verifyFile(anchor, path, file.size!, file.sha256!, file.executable!) : null;
      if (direction === "download" && anchor.parent(path, target => at(target))) throw new Error("download target already exists");
      intent = {
        id: randomUUID(),
        entryId: file.id,
        revision: manifest.revisionId,
        sequence: local.head("applied").sequence,
        direction,
        rootDevice: String(anchor.stat.dev),
        rootInode: String(anchor.stat.ino),
        fileDevice: stat ? String(stat.dev) : null,
        fileInode: stat ? String(stat.ino) : null,
      };
      local.beginHydration(intent);
    } else if (intent.entryId !== file.id || intent.direction !== direction || intent.revision !== manifest.revisionId || intent.sequence !== local.head("applied").sequence)
      throw new Error("hydration recovery context differs");
    if (direction === "evict") {
      if ((await remote.presence("chunk", [...new Set(references.map(ref => ref.objectId))])).size) throw new Error("cannot evict: remote ciphertext is missing");
      anchor.parent(path, (target, fd, check) => {
        if (!at(target)) return; // Unlink completed before the previous process exited.
        verifyFile(anchor, path, file.size!, file.sha256!, file.executable!, intent);
        check(); unlinkSync(target); fsyncSync(fd); check();
      });
      local.finishHydration(intent);
    } else {
      const stage = stageName(intent), stagedPath = `/proc/self/fd/${anchor.fd}/${stage}`;
      const target = anchor.parent(path, name => at(name));
      if (target) {
        const staged = at(stagedPath);
        if (staged) {
          ownedFile(staged, true);
          if (staged.dev !== target.dev || staged.ino !== target.ino || target.nlink !== 2)
            throw new Error("download target occupied by an unrelated file");
          verifyFile(anchor, path, file.size!, file.sha256!, file.executable!, undefined, 2);
          anchor.check(); unlinkSync(stagedPath); fsyncSync(anchor.fd); anchor.check();
        } else verifyFile(anchor, path, file.size!, file.sha256!, file.executable!);
      } else {
        const staged = at(stagedPath);
        if (staged) { ownedFile(staged); if ((staged.mode & 0o777) !== (file.executable ? 0o700 : 0o600) || staged.size !== file.size || (() => {
          const fd = openSync(stagedPath, fileFlags);
          try { return fileDigest(fd, fstatSync(fd)) !== file.sha256; } finally { closeSync(fd); }
        })()) { unlinkSync(stagedPath); fsyncSync(anchor.fd); } }
        if (!at(stagedPath)) {
          const fd = openSync(stagedPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
          try {
            const hash = createHash("sha256"); let size = 0, index = 0;
            for await (const bytes of remote.downloadChunks(references, master, manifest.vaultId)) {
              if (bytes.length !== file.chunks![index++]?.length || bytes.length > CHUNK_SIZE) throw new Error("authenticated chunk length mismatch");
              hash.update(bytes); size += bytes.length;
              for (let offset = 0; offset < bytes.length;) { const written = writeSync(fd, bytes, offset, bytes.length - offset); if (!written) throw new Error("short download write"); offset += written; }
            }
            if (index !== references.length || size !== file.size || hash.digest("hex") !== file.sha256) throw new Error("downloaded file digest mismatch");
            fchmodSync(fd, file.executable ? 0o700 : 0o600); fsyncSync(fd);
          } catch (error) { closeSync(fd); unlinkSync(stagedPath); fsyncSync(anchor.fd); throw error; }
          closeSync(fd); fsyncSync(anchor.fd);
        }
        anchor.parent(path, (name, fd, check) => {
          check(); if (at(name)) throw new Error("download target occupied");
          hooks.beforeLink?.();
          // link(2) is atomic no-replace. A racing user file makes this fail
          // with EEXIST; unlike rename it can never be silently overwritten.
          linkSync(stagedPath, name); fsyncSync(fd); fsyncSync(anchor.fd); check();
          hooks.afterLink?.();
          const linked = at(name), staged = at(stagedPath);
          if (!linked || !staged || linked.dev !== staged.dev || linked.ino !== staged.ino || linked.nlink !== 2 || staged.nlink !== 2)
            throw new Error("download link changed before cleanup");
          unlinkSync(stagedPath); fsyncSync(anchor.fd); check();
        });
      }
      const installed = verifyFile(anchor, path, file.size!, file.sha256!, file.executable!);
      local.finishHydration(intent, String(installed.dev), String(installed.ino));
    }
    return { path, hydration: direction === "evict" ? "evicted" : "downloaded", revisionId: manifest.revisionId };
  } finally { anchor.close(); }
}
