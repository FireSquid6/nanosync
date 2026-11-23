import { randomUUID } from "node:crypto";
import { dlopen, FFIType } from "bun:ffi";
import { constants, closeSync, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Identity = { pid: number; starttime: string };
export type FileIdentity = { dev: number; ino: number };

function same(a: FileIdentity, b: FileIdentity) { return a.dev === b.dev && a.ino === b.ino; }

/** /proc/PID/stat field 2 (comm) may contain spaces and parentheses. Field 22
 * is the 20th field after its last `) ` delimiter (field 3 is index zero).
 */
function processStarttime(pid: number): string | null {
  let text: string;
  try {
    const proc = statSync(`/proc/${pid}`);
    if (proc.uid !== process.getuid!()) throw new Error("sync owner has a foreign UID");
    text = readFileSync(`/proc/${pid}/stat`, "utf8");
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return null;
    throw new Error("cannot determine sync owner identity", { cause: error });
  }
  const end = text.lastIndexOf(") ");
  const fields = end < 0 ? [] : text.slice(end + 2).trim().split(/\s+/);
  const starttime = fields[19];
  if (end < 1 || text.slice(0, end).split(" (")[0] !== String(pid) || !starttime || !/^\d+$/.test(starttime))
    throw new Error("invalid Linux process identity");
  return starttime;
}

function currentIdentity(): Identity {
  const starttime = processStarttime(process.pid);
  if (!starttime) throw new Error("cannot identify current process");
  return { pid: process.pid, starttime };
}

function gateIdentity(path: string): { owner: Identity; inode: FileIdentity; staged?: string } {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== process.getuid!() || st.nlink < 1 || st.nlink > 2 || (st.mode & 0o177) !== 0)
    throw new Error("unsafe sync ownership lock: expected private owner-only regular file");
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || !same(opened, st) || opened.nlink !== st.nlink || opened.uid !== st.uid || opened.mode !== st.mode || opened.size > 128)
      throw new Error("sync ownership lock changed during inspection");
    const text = readFileSync(fd, "utf8");
    const match = /^([1-9]\d{0,9}):([1-9]\d*)\n$/.exec(text);
    if (!match || Number(match[1]) > 2147483647) throw new Error("sync ownership lock has no trustworthy owner record");
    let staged: string | undefined;
    if (st.nlink === 2) {
      const matches = readdirSync(dirname(path)).filter(name => /^\.sync-owner-[0-9a-f-]{36}$/.test(name)).map(name => join(dirname(path), name))
        .filter(candidate => { const other = lstatSync(candidate); return other.isFile() && !other.isSymbolicLink() && same(other, st); });
      if (matches.length !== 1) throw new Error("unsafe sync ownership lock hardlink");
      staged = matches[0];
    }
    if (!same(lstatSync(path), st)) throw new Error("sync ownership lock changed during inspection");
    return { owner: { pid: Number(match[1]), starttime: match[2]! }, inode: st, staged };
  } finally { closeSync(fd); }
}

/** Inspect only: malformed or inaccessible ownership always fails closed. */
export function inspectSyncOwner(root: string): { pid: number; starttime: string } | null {
  let gate: ReturnType<typeof gateIdentity>;
  try { gate = gateIdentity(join(root, ".sync-owner")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return processStarttime(gate.owner.pid) === gate.owner.starttime ? gate.owner : null;
}

function unlinkMatching(path: string, inode: FileIdentity): void {
  try {
    const now = lstatSync(path);
    if (!same(now, inode)) throw new Error("sync ownership lock changed before removal");
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("sync ownership lock disappeared during recovery", { cause: error });
    throw error;
  }
}

let kernelLocks: ReturnType<typeof dlopen<{ flock: { args: [typeof FFIType.i32, typeof FFIType.i32]; returns: typeof FFIType.i32 } }>>;
function acquireKernelGate(root: string): () => void {
  if (process.platform !== "linux") throw new Error("Sync ownership is currently supported on Linux only");
  kernelLocks ??= dlopen("libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
  const path = join(root, ".sync-gate");
  const fd = openSync(path, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || st.mode & 0o177 || !same(st, lstatSync(path)))
      throw new Error("unsafe kernel sync gate");
    if (kernelLocks.symbols.flock(fd, 2 | 4) !== 0) throw new Error("another live process owns the sync ownership lock");
    if (!same(st, lstatSync(path))) throw new Error("kernel sync gate changed during acquisition");
    // This inode is never unlinked: the kernel releases ownership on close/crash.
    return () => closeSync(fd);
  } catch (error) { closeSync(fd); throw error; }
}

/** Serialize stale-record recovery as well as the entire writer lifetime. */
export function acquireSyncLock(root: string): () => void {
  const releaseGate = acquireKernelGate(root);
  try {
    const releaseRecord = acquireOwnerRecord(root);
    return () => { try { releaseRecord(); } finally { releaseGate(); } };
  } catch (error) { releaseGate(); throw error; }
}

/** Publish the complete fsynced process identity without an ownerless interval. */
function acquireOwnerRecord(root: string): () => void {
  const path = join(root, ".sync-owner"), staged = join(root, `.sync-owner-${randomUUID()}`);
  const identity = currentIdentity();
  const fd = openSync(staged, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
  let publishedInode: FileIdentity | undefined;
  try {
    fchmodSync(fd, 0o600);
    writeFileSync(fd, `${identity.pid}:${identity.starttime}\n`);
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(staged);
    throw error;
  }
  closeSync(fd);
  try {
    let published = false;
    for (let attempt = 0; attempt < 2; attempt++) {
      try { linkSync(staged, path); published = true; break; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const previous = gateIdentity(path);
        const liveStart = processStarttime(previous.owner.pid);
        if (liveStart === previous.owner.starttime) throw new Error("another live process owns the sync ownership lock");
        // A readable, different starttime or an absent PID is definitively
        // stale; permission/proc errors above never authorize removal.
        unlinkMatching(path, previous.inode);
        if (previous.staged) {
          const remaining = lstatSync(previous.staged);
          if (!same(remaining, previous.inode)) throw new Error("sync staging file changed during recovery");
          unlinkSync(previous.staged);
        }
        if (attempt === 1) throw new Error("sync ownership lock contention during recovery");
      }
    }
    if (!published) throw new Error("failed to acquire sync ownership lock");
    const own = lstatSync(path);
    publishedInode = own;
    if (!own.isFile() || own.uid !== process.getuid!() || own.mode & 0o177 || own.nlink !== 2 || !same(own, lstatSync(staged)))
      throw new Error("sync ownership lock publication failed");
    unlinkSync(staged);
    const lock = gateIdentity(path);
    if (lock.owner.pid !== identity.pid || lock.owner.starttime !== identity.starttime) throw new Error("sync ownership lock owner changed");
    const directory = openSync(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(directory); } finally { closeSync(directory); }
    return () => { unlinkMatching(path, lock.inode); };
  } catch (error) {
    // If this process published the gate, do not leave a live-owner lock after
    // an exception before returning its release callback.
    try {
      const gate = lstatSync(path);
      const ours = publishedInode ?? lstatSync(staged);
      if (same(ours, gate)) unlinkSync(path);
    } catch { /* preserve the original failure; never remove an unknown inode */ }
    try { unlinkSync(staged); } catch { /* already removed */ }
    throw error;
  }
}
