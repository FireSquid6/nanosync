import { createHash, randomUUID } from "node:crypto";
import {
  constants, closeSync, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync,
  mkdirSync, openSync, readSync, readdirSync, renameSync, rmdirSync, unlinkSync,
  writeSync, type Stats,
} from "node:fs";
import { resolve } from "node:path";
import { CHUNK_SIZE } from "@nanosync/protocol";
import {
  encodeManifest, manifestPaths, parseManifest,
  type HttpRemote, type ManifestEntry, type ManifestV1,
} from "@nanosync/sync-core";
import { ClientLocal, type Entry } from "@nanosync/client-local";
import { IgnoreRules } from "./ignore.ts";

const dirFlags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const fileFlags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Old = { entry: Entry; device: string; inode: string };
type Plan = {
  version: 1;
  rootDevice: string;
  rootInode: string;
  manifest: ManifestV1;
  old: Old[];
  desired: Entry[];
  stages: Record<string, string>;
  created: Record<string, { device: string; inode: string }>;
  operationId: string;
  ignoreSignature?: string;
  ignoredIdentities?: { entryId: string; device: string; inode: string }[];
};

function statOrNull(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}
function safe(stat: Stats, kind: "file" | "directory") {
  if (
    stat.uid !== process.getuid!() || !!(stat.mode & 0o022) ||
    (kind === "file" ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())
  )
    throw new Error("unsafe filesystem entry (symlink, hardlink, special file or foreign owner)");
}
function digest(fd: number, expected: Stats, allowLinked = false): string {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  for (let offset = 0; offset < expected.size;) {
    const n = readSync(fd, buffer, 0, Math.min(buffer.length, expected.size - offset), offset);
    if (!n) throw new Error("file truncated during verification");
    hash.update(buffer.subarray(0, n));
    offset += n;
  }
  const after = fstatSync(fd);
  if (after.dev !== expected.dev || after.ino !== expected.ino || after.size !== expected.size ||
      after.mtimeMs !== expected.mtimeMs || after.ctimeMs !== expected.ctimeMs || after.nlink !== (allowLinked ? expected.nlink : 1))
    throw new Error("file changed during verification");
  return hash.digest("hex");
}

/** Every parent is opened independently with O_NOFOLLOW; descendants are relative to its fd. */
class Root {
  readonly fd: number;
  readonly stat: Stats;
  constructor(
    readonly path: string,
    expected?: { rootDevice: string; rootInode: string },
  ) {
    this.fd = openSync(path, dirFlags);
    this.stat = fstatSync(this.fd);
    safe(this.stat, "directory");
    if (expected && (String(this.stat.dev) !== expected.rootDevice || String(this.stat.ino) !== expected.rootInode)) {
      closeSync(this.fd);
      throw new Error("root identity changed");
    }
    this.check();
  }
  check() {
    const current = lstatSync(this.path); safe(current, "directory");
    if (current.dev !== this.stat.dev || current.ino !== this.stat.ino)
      throw new Error("root moved");
  }
  parent(path: string): { fd: number; leaf: string; close(): void; check(): void } {
    this.check();
    const parts = path.split("/");
    if (!path || parts.some(p => !p || p === "." || p === "..")) throw new Error("invalid relative path");
    let fd = this.fd;
    const chain: { fd: number; name: string; dev: number; ino: number }[] = [];
    try {
      for (const name of parts.slice(0, -1)) {
        const next = openSync(`/proc/self/fd/${fd}/${name}`, dirFlags);
        const st = fstatSync(next); safe(st, "directory");
        chain.push({ fd, name, dev: st.dev, ino: st.ino });
        fd = next;
      }
      const close = () => {
        if (fd !== this.fd) closeSync(fd);
        for (const item of chain.slice(0, -1))
          if (item.fd !== this.fd) closeSync(item.fd);
      };
      const check = () => {
        this.check();
        for (const item of chain) {
          const st = statOrNull(`/proc/self/fd/${item.fd}/${item.name}`);
          if (!st || !st.isDirectory() || st.dev !== item.dev || st.ino !== item.ino)
            throw new Error("parent moved during apply");
        }
      };
      check();
      return { fd, leaf: parts.at(-1)!, close, check };
    } catch (error) {
      if (fd !== this.fd) closeSync(fd);
      for (const item of chain.slice(0, -1))
        if (item.fd !== this.fd) closeSync(item.fd);
      throw error;
    }
  }
  withParent<T>(path: string, fn: (target: string, check: () => void, dir: number) => T): T {
    const parent = this.parent(path);
    try {
      parent.check();
      const result = fn(`/proc/self/fd/${parent.fd}/${parent.leaf}`, parent.check, parent.fd);
      parent.check();
      return result;
    } finally { parent.close(); }
  }
  at(path: string): Stats | null {
    try { return this.withParent(path, target => statOrNull(target)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  }
  verify(path: string, old: Old, fingerprint = true): Stats {
    return this.withParent(path, (target, check) => {
      const before = lstatSync(target); safe(before, old.entry.kind as "file" | "directory");
      if (String(before.dev) !== old.device || String(before.ino) !== old.inode) throw new Error(`local identity conflict: ${path}`);
      const fd = openSync(target, old.entry.kind === "directory" ? dirFlags : fileFlags);
      try {
        const st = fstatSync(fd); safe(st, old.entry.kind as "file" | "directory");
        if (st.dev !== before.dev || st.ino !== before.ino) throw new Error("target raced");
        if (fingerprint && old.entry.kind === "file" && digest(fd, st) !== old.entry.fingerprint) throw new Error(`local content conflict: ${path}`);
        check(); return st;
      } finally { closeSync(fd); }
    });
  }
  move(source: string, target: string, old: Old) {
    this.verify(source, old);
    this.withParent(source, (src, checkSource, srcFd) => this.withParent(target, (dst, checkTarget, dstFd) => {
      if (statOrNull(dst)) throw new Error(`occupied destination: ${target}`);
      checkSource(); checkTarget(); renameSync(src, dst);
      fsyncSync(srcFd); if (dstFd !== srcFd) fsyncSync(dstFd);
      checkSource(); checkTarget(); this.verify(target, old, false);
    }));
  }
  remove(path: string, old: Old) {
    this.verify(path, old);
    this.withParent(path, (target, check, fd) => {
      check(); if (old.entry.kind === "directory") rmdirSync(target); else unlinkSync(target);
      fsyncSync(fd); check();
    });
  }
  close() { closeSync(this.fd); }
}

function temp(plan: Plan, id: string, suffix: "old" | "new") { return `.nanosync-${plan.operationId}-${id}-${suffix}`; }
function scan(root: Root, ignore: IgnoreRules): Map<string, Stats> {
  const found = new Map<string, Stats>();
  const walk = (prefix: string, fd: number) => {
    const names = readdirSync(`/proc/self/fd/${fd}`).sort();
    for (const name of names) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!name.startsWith(".nanosync-") && ignore.ignores(path)) continue;
      const st = root.at(path); if (!st) throw new Error("directory changed during inventory");
      if (!name.startsWith(".nanosync-") && st.isDirectory() && ignore.ignores(path, true)) continue;
      safe(st, st.isDirectory() ? "directory" : "file"); found.set(path, st);
      if (st.isDirectory()) {
        const child = root.parent(path);
        try { const next = openSync(`/proc/self/fd/${child.fd}/${child.leaf}`, dirFlags);
          try { walk(path, next); child.check(); } finally { closeSync(next); }
        } finally { child.close(); }
      }
    }
  };
  walk("", root.fd); root.check(); return found;
}

async function stage(root: Root, plan: Plan, remote: HttpRemote, master: Uint8Array,
  refs: Map<string, Awaited<ReturnType<HttpRemote["revision"]>>["revision"]["references"][number]>) {
  for (const entry of plan.manifest.entries.filter(e => e.kind === "file")) {
    const name = plan.stages[entry.id]; if (!name) continue;
    const existing = root.at(name);
    if (existing) {
      if (!existing.isFile() || existing.uid !== process.getuid!() || existing.nlink !== 1 && existing.nlink !== 2) throw new Error("unsafe staged file");
      const fd = openSync(`/proc/self/fd/${root.fd}/${name}`, fileFlags);
      let valid = false;
      try { valid = existing.size === entry.size && digest(fd, fstatSync(fd), true) === entry.sha256 &&
        (existing.mode & 0o777) === (entry.executable ? 0o700 : 0o600); }
      finally { closeSync(fd); }
      if (valid) continue;
      if (existing.nlink !== 1 || (existing.mode & 0o777) !== 0o600 && (existing.mode & 0o777) !== 0o700)
        throw new Error("staged file conflict");
      root.withParent(name, (path, check, parent) => {
        check(); const current = lstatSync(path);
        if (current.ino !== existing.ino || current.dev !== existing.dev || current.nlink !== 1) throw new Error("staged file raced");
        unlinkSync(path); fsyncSync(parent); check();
      });
    }
    const fd = openSync(`/proc/self/fd/${root.fd}/${name}`, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try {
      const hash = createHash("sha256"); let size = 0, index = 0;
      const references = entry.chunks!.map(c => {
        const ref = refs.get(c.objectId);
        if (!ref || ref.objectType !== "chunk" || ref.ciphertextLength !== c.length + 96) throw new Error("missing authenticated chunk reference");
        return ref;
      });
      for await (const bytes of remote.downloadChunks(references, master, plan.manifest.vaultId)) {
        if (bytes.length !== entry.chunks![index++]?.length || bytes.length > CHUNK_SIZE) throw new Error("chunk length mismatch");
        hash.update(bytes); size += bytes.length;
        for (let offset = 0; offset < bytes.length;) {
          const n = writeSync(fd, bytes, offset, bytes.length - offset); if (!n) throw new Error("short write"); offset += n;
        }
      }
      if (index !== references.length || size !== entry.size || hash.digest("hex") !== entry.sha256) throw new Error("whole-file digest mismatch");
      fchmodSync(fd, entry.executable ? 0o700 : 0o600); fsyncSync(fd);
    } catch (error) { closeSync(fd); unlinkSync(`/proc/self/fd/${root.fd}/${name}`); throw error; }
    closeSync(fd); fsyncSync(root.fd);
  }
}

function planApply(root: Root, local: ClientLocal, manifest: ManifestV1, sequence: number, evict: ReadonlySet<string>, ignore: IgnoreRules): Plan {
  const paths = manifestPaths(manifest), oldEntries = local.entries(), identities = new Map(local.identities().map(i => [i.entryId, i]));
  const ignored = oldEntries.filter(e => e.path && ignore.ignores(e.path, e.kind === "directory"));
  const ignoredIds = new Set(ignored.map(e => e.id));
  const remoteById = new Map([...paths].map(([path, entry]) => [entry.id, { path, entry }]));
  local.markIgnored(ignored.map(e => e.id));
  for (const entry of ignored) {
    const destination = remoteById.get(entry.id);
    if (destination && destination.entry.kind !== "tombstone" &&
        !ignore.ignores(destination.path, destination.entry.kind === "directory"))
      throw new Error(`ignored entry moved to included path; manual reconciliation required: ${entry.path}`);
  }
  const old: Old[] = oldEntries.filter(e => e.kind !== "tombstone" && e.hydration === "downloaded" &&
    (e.path === "" || !ignore.ignores(e.path, e.kind === "directory"))).map(entry => {
    const ident = identities.get(entry.id); if (!ident) throw new Error(`missing local identity: ${entry.path}`);
    return { entry, device: ident.device, inode: ident.inode };
  });
  const rootEntry = paths.get("");
  if (oldEntries.some(e => e.path === "" && e.id !== rootEntry?.id)) throw new Error("root identity changed");
  const byId = new Map(oldEntries.map(e => [e.id, e]));
  const desired: Entry[] = [], stages: Record<string, string> = {};
  const operationId = randomUUID();
  const plan: Plan = { version: 1, rootDevice: String(root.stat.dev), rootInode: String(root.stat.ino),
    manifest, old, desired, stages, created: {}, operationId, ignoreSignature: ignore.signature,
    ignoredIdentities: local.identities().filter(i => oldEntries.some(e => e.id === i.entryId && e.path &&
      ignore.ignores(e.path, e.kind === "directory"))) };
  for (const [path, e] of paths) {
    if (ignoredIds.has(e.id)) continue;
    if (path && ignore.ignores(path, e.kind === "directory")) continue;
    const prior = byId.get(e.id);
    if (prior && prior.kind !== e.kind && !(e.kind === "tombstone" && prior.kind === e.deletedKind))
      throw new Error("manifest identity kind changed");
    const hydration = e.kind === "file" && (evict.has(e.id) || prior?.hydration === "evicted") ? "evicted" : "downloaded";
    if (evict.has(e.id) && (e.kind !== "file" || !prior || prior.hydration !== "downloaded")) throw new Error("eviction requires a downloaded, durable file");
    if (e.kind === "file" && hydration === "downloaded" && (!prior || prior.hydration === "evicted" || prior.fingerprint !== e.sha256 ||
        root.at(prior.path) && !!(root.at(prior.path)!.mode & 0o100) !== e.executable))
      stages[e.id] = temp(plan, e.id, "new");
    desired.push({ id: e.id, path, kind: e.kind, fingerprint: e.sha256 ?? null, hydration, revision: manifest.revisionId });
  }
  for (const entry of oldEntries) if (entry.path && ignore.ignores(entry.path, entry.kind === "directory")) desired.push(entry);
  const snapshot = scan(root, ignore);
  for (const [path, st] of snapshot) {
    const prior = old.find(o => o.entry.path === path);
    if (!prior || String(st.dev) !== prior.device || String(st.ino) !== prior.inode) throw new Error(`unexpected local entry: ${path}`);
    root.verify(path, prior);
  }
  for (const item of old) if (item.entry.path && !snapshot.has(item.entry.path)) throw new Error(`unexpected local deletion: ${item.entry.path}`);
  for (const item of old.filter(o => !o.entry.path))
    if (String(root.stat.dev) !== item.device || String(root.stat.ino) !== item.inode) throw new Error("root identity conflict");
  if (sequence <= local.head("applied").sequence) throw new Error("revision already applied");
  return plan;
}

function verifyBeforeMutation(root: Root, plan: Plan, ignore: IgnoreRules) {
  const allowedStages = new Set([
    ...Object.values(plan.stages),
    ...Object.keys(plan.created).map(id => temp(plan, id, "new")),
  ]);
  const inventory = scan(root, ignore);
  for (const [path, stat] of inventory) {
    if (allowedStages.has(path)) continue;
    const prior = plan.old.find(item => item.entry.path === path);
    if (!prior || String(stat.dev) !== prior.device || String(stat.ino) !== prior.inode)
      throw new Error(`local change during staging: ${path}`);
    root.verify(path, prior);
  }
  for (const item of plan.old) if (item.entry.path && !inventory.has(item.entry.path))
    throw new Error(`local deletion during staging: ${item.entry.path}`);
}

/** A crash can leave descendants beneath a moved ancestor rather than at their old paths. */
function oldLocations(root: Root, plan: Plan, item: Old): string[] {
  const locations = [item.entry.path, temp(plan, item.entry.id, "old")];
  for (const ancestor of plan.old) {
    if (ancestor.entry.kind !== "directory" || !ancestor.entry.path ||
        !item.entry.path.startsWith(`${ancestor.entry.path}/`)) continue;
    const staged = temp(plan, ancestor.entry.id, "old"), stat = root.at(staged);
    if (!stat) continue;
    root.verify(staged, ancestor, false);
    locations.push(`${staged}/${item.entry.path.slice(ancestor.entry.path.length + 1)}`);
  }
  return locations;
}

function oldAt(root: Root, plan: Plan, item: Old): string | null {
  for (const location of oldLocations(root, plan, item)) {
    const stat = root.at(location);
    if (stat && String(stat.dev) === item.device && String(stat.ino) === item.inode) {
      root.verify(location, item); return location;
    }
  }
  return null;
}

function verifyRecovery(root: Root, plan: Plan, ignore: IgnoreRules) {
  const paths = manifestPaths(plan.manifest), desired = new Map([...paths].filter(([path]) => path));
  const oldByLocation = new Map<string, Old>();
  for (const old of plan.old.filter(o => o.entry.path)) for (const location of oldLocations(root, plan, old)) {
    const prior = oldByLocation.get(location);
    if (prior && prior.entry.id !== old.entry.id) throw new Error("ambiguous staged descendant");
    oldByLocation.set(location, old);
  }
  const staged = new Map(Object.entries(plan.stages).map(([id, path]) => [path, plan.manifest.entries.find(e => e.id === id)!]));
  for (const [path, st] of scan(root, ignore)) {
    const prior = oldByLocation.get(path);
    if (prior && String(st.dev) === prior.device && String(st.ino) === prior.inode) {
      root.verify(path, prior); continue;
    }
    const entry = desired.get(path) ?? staged.get(path);
    if (entry?.kind === "directory") {
      const previous = plan.old.find(o => o.entry.id === entry.id);
      if (previous && st.isDirectory() && String(st.dev) === previous.device && String(st.ino) === previous.inode) continue;
    }
    if (entry?.kind === "file" && st.isFile() && st.uid === process.getuid!() && st.nlink <= 2 && st.size === entry.size) {
      const fd = root.withParent(path, name => openSync(name, fileFlags));
      try { if (digest(fd, fstatSync(fd), true) === entry.sha256) continue; } finally { closeSync(fd); }
    }
    const createdId = entry?.kind === "directory" ? entry.id :
      [...Object.keys(plan.created)].find(id => temp(plan, id, "new") === path);
    const created = createdId && plan.created[createdId];
    if (created && st.isDirectory() && String(st.dev) === created.device && String(st.ino) === created.inode) continue;
    throw new Error(`unexpected entry during apply recovery: ${path}`);
  }
}

/** Authenticated reconciliation. A persisted intent is replayed by calling this again after reopening. */
export async function applyNewFiles(rootInput: string, local: ClientLocal, remote: HttpRemote,
  input: ManifestV1, sequence: number, master: Uint8Array, options: { evictIds?: ReadonlySet<string> } = {}) {
  if (process.platform !== "linux") throw new Error("Linux only");
  const manifest = parseManifest(input), accepted = local.head("accepted");
  const pending = local.pendingApplies();
  if (pending.length > 1 || pending[0] && (pending[0].revision !== manifest.revisionId || pending[0].sequence !== sequence))
    throw new Error("different apply intent requires recovery");
  const saved = pending[0] ? local.applyPlan(pending[0].id) : null;
  if (pending.length && !saved) throw new Error("legacy apply intent requires manual recovery");
  if (accepted.sequence < sequence || accepted.sequence === sequence && accepted.revisionId !== manifest.revisionId ||
      !pending.length && (accepted.revisionId !== manifest.revisionId || accepted.sequence !== sequence))
    throw new Error("unaccepted revision");
  const plan = saved ? JSON.parse(saved) as Plan : null;
  if (plan && (plan.version !== 1 || plan.operationId !== pending[0]!.id ||
      !Buffer.from(encodeManifest(plan.manifest)).equals(Buffer.from(encodeManifest(manifest))))) throw new Error("corrupt apply intent");
  const root = new Root(resolve(rootInput), plan ?? undefined);
  const ignore = new IgnoreRules(root.path);
  if (plan && plan.ignoreSignature !== ignore.signature) { root.close(); throw new Error(".nanosyncignore changed during pending apply; restore prior rules to recover"); }
  let prepared = false;
  let active: Plan | null = null;
  try {
    const authenticated = await remote.manifest(manifest.revisionId, master);
    if (!Buffer.from(encodeManifest(authenticated.manifest)).equals(Buffer.from(encodeManifest(manifest)))) throw new Error("manifest differs from authenticated revision");
    const refs = new Map<string, typeof authenticated.revision.references[number]>(authenticated.revision.references.map(r => [r.objectId, r]));
    const evictions = plan ? plan.desired.filter(e => e.kind === "file" && e.hydration === "evicted" && plan.old.some(o => o.entry.id === e.id))
      .map(e => e.id) : [...options.evictIds ?? []];
    if (evictions.length) {
      const ids = [...new Set(manifest.entries.filter(e => evictions.includes(e.id)).flatMap(e => (e.chunks ?? []).map(c => c.objectId)))];
      if (ids.length && (await remote.presence("chunk", ids)).size) throw new Error("eviction requires remotely durable chunks");
    }
    const work = plan ?? planApply(root, local, manifest, sequence, options.evictIds ?? new Set(), ignore);
    active = work;
    if (plan) verifyRecovery(root, plan, ignore);
    if (plan && options.evictIds && [...options.evictIds].some(id => work.desired.find(e => e.id === id)?.hydration !== "evicted"))
      throw new Error("eviction policy differs from persisted intent");
    // All files are downloaded and fsynced before the first destructive mutation.
    await stage(root, work, remote, master, refs);
    for (const entry of work.manifest.entries.filter(e => e.kind === "directory" && e.parentId !== null &&
      work.desired.some(d => d.id === e.id && d.revision === manifest.revisionId) && !work.old.some(o => o.entry.id === e.id))) {
      const name = temp(work, entry.id, "new"), target = manifestPaths(manifest);
      const path = [...target].find(([, e]) => e.id === entry.id)![0];
      let st = root.at(name) ?? root.at(path);
      if (!st && !plan) {
        root.withParent(name, (location, check, fd) => {
          check(); if (statOrNull(location)) throw new Error("occupied staged directory");
          mkdirSync(location, { mode: 0o700 }); fsyncSync(fd); check();
        });
        st = root.at(name);
      }
      if (!st || !st.isDirectory() || st.uid !== process.getuid!()) throw new Error("staged directory missing");
      const identity = { device: String(st.dev), inode: String(st.ino) };
      if (plan && (work.created[entry.id]?.device !== identity.device || work.created[entry.id]?.inode !== identity.inode))
        throw new Error("staged directory identity conflict");
      work.created[entry.id] = identity;
    }
    if (!plan) {
      verifyBeforeMutation(root, work, ignore);
      if (new IgnoreRules(root.path).signature !== ignore.signature) throw new Error(".nanosyncignore changed during apply preparation");
      fsyncSync(root.fd); local.prepareApply(work.operationId, manifest.revisionId, sequence, JSON.stringify(work));
    }
    prepared = true;
    local.transition("operations", work.operationId, "running");
    const old = work.old.filter(o => o.entry.path);
    const oldById = new Map(old.map(o => [o.entry.id, o]));
    // Extract files before directories, deepest first; each source is checked by inode and digest.
    for (const item of old.filter(o => o.entry.kind === "file")) {
      const tmp = temp(work, item.entry.id, "old");
      const source = oldAt(root, work, item);
      if (source === tmp) continue;
      if (source) { root.move(source, tmp, item); continue; }
      const current = root.at(item.entry.path);
      if (current) {
        const desired = work.desired.find(e => e.path === item.entry.path && e.kind === "file");
        const replacement = desired && work.stages[desired.id];
        if (!replacement || !current.isFile() || current.uid !== process.getuid!() || current.nlink > 2)
          throw new Error("unexpected file during apply recovery");
        const fd = root.withParent(item.entry.path, name => openSync(name, fileFlags));
        try { if (digest(fd, fstatSync(fd), true) !== desired!.fingerprint) throw new Error("installed file conflict"); }
        finally { closeSync(fd); }
      }
    }
    for (const item of old.filter(o => o.entry.kind === "directory").sort((a, b) => b.entry.path.length - a.entry.path.length)) {
      const tmp = temp(work, item.entry.id, "old");
      const source = oldAt(root, work, item);
      if (source && source !== tmp) root.move(source, tmp, item);
      else if (!source && root.at(item.entry.path)) throw new Error(`unexpected directory during apply recovery: ${item.entry.path}`);
    }
    const paths = manifestPaths(manifest);
    for (const [path, entry] of [...paths].filter(([p, e]) => p && e.kind === "directory" && !ignore.ignores(p, true)).sort((a, b) => a[0].length - b[0].length)) {
      const existing = root.at(path), prior = oldById.get(entry.id), created = work.created[entry.id];
      if (existing) {
        const identity = prior ?? (created && { entry: { kind: "directory" } as Entry, device: created.device, inode: created.inode });
        if (!identity || String(existing.dev) !== identity.device || String(existing.ino) !== identity.inode) throw new Error(`occupied directory: ${path}`);
        root.verify(path, identity, false); continue;
      }
      const tmp = temp(work, entry.id, "old");
      if (prior && root.at(tmp)) root.move(tmp, path, prior);
      else if (created && root.at(temp(work, entry.id, "new"))) root.move(temp(work, entry.id, "new"), path,
        { entry: { kind: "directory" } as Entry, device: created.device, inode: created.inode });
      else throw new Error("directory source missing");
    }
    for (const [path, entry] of paths) {
      if (entry.kind !== "file") continue;
      if (ignore.ignores(path)) continue;
      const desired = work.desired.find(e => e.id === entry.id)!;
      if (desired.hydration === "evicted") continue;
      const replacement = work.stages[entry.id], prior = oldById.get(entry.id);
      const src = replacement ?? temp(work, entry.id, "old");
      const target = root.at(path);
      if (target) {
        if (replacement && target.isFile() && target.uid === process.getuid!() && target.size === entry.size &&
            (target.mode & 0o777) === (entry.executable ? 0o700 : 0o600) && target.nlink <= 2) {
          root.withParent(path, (name) => { const fd = openSync(name, fileFlags); try {
            if (digest(fd, fstatSync(fd), true) !== entry.sha256) throw new Error("installed file conflict");
          } finally { closeSync(fd); } });
          continue;
        }
        if (!replacement && !root.at(src) && prior && String(target.ino) === prior.inode) {
          root.verify(path, prior, false);
          continue;
        }
        throw new Error(`occupied file destination: ${path}`);
      }
      if (replacement) {
        const st = root.at(src); if (!st || !st.isFile() || st.nlink !== 1 || st.size !== entry.size) throw new Error("staged file missing");
        root.withParent(path, (dst, check, fd) => {
          check(); if (statOrNull(dst)) throw new Error("occupied file");
          linkSync(`/proc/self/fd/${root.fd}/${src}`, dst); fsyncSync(fd); check();
        });
      } else if (prior && root.at(src)) root.move(src, path, prior);
      else throw new Error(`source missing for ${path}`);
    }
    // Deletion/eviction happens only after the durable accepted manifest and intent.
    for (const item of old.filter(o => o.entry.kind === "file")) {
      const tmp = temp(work, item.entry.id, "old");
      if (root.at(tmp)) root.remove(tmp, item);
    }
    for (const item of old.filter(o => o.entry.kind === "directory")) {
      const tmp = temp(work, item.entry.id, "old");
      if (root.at(tmp)) root.remove(tmp, item);
    }
    for (const name of Object.values(work.stages)) if (root.at(name)) root.withParent(name, (target, check, fd) => {
      check(); unlinkSync(target); fsyncSync(fd); check();
    });
    if (new IgnoreRules(root.path).signature !== ignore.signature) throw new Error(".nanosyncignore changed during apply");
    root.check(); fsyncSync(root.fd);
    const identities = work.desired.filter(e => e.kind !== "tombstone" && e.hydration === "downloaded" &&
      !(e.path && ignore.ignores(e.path, e.kind === "directory"))).map(e => {
      const st = e.path ? root.at(e.path) : root.stat;
      if (!st || !st.isDirectory() && (!st.isFile() || st.nlink !== 1)) throw new Error("applied entry missing");
      return { entryId: e.id, device: String(st.dev), inode: String(st.ino) };
    });
    local.finishApply(work.operationId, { revisionId: manifest.revisionId, sequence }, work.desired,
      [...identities, ...work.ignoredIdentities ?? []]);
  } finally {
    // Before an intent exists, orphan stages are private and can be removed safely.
    if (!prepared && !plan && active) for (const name of readdirSync(`/proc/self/fd/${root.fd}`)) if (name.startsWith(`.nanosync-${active.operationId}-`)) {
      const st = root.at(name);
      if (st?.isFile() && st.nlink === 1) unlinkSync(`/proc/self/fd/${root.fd}/${name}`);
      else if (st?.isDirectory()) rmdirSync(`/proc/self/fd/${root.fd}/${name}`);
    }
    root.close();
  }
}
