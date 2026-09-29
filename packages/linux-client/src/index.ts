import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, realpathSync, watch, type FSWatcher, type Stats } from "node:fs";
import { resolve } from "node:path";
import { CHUNK_SIZE, parseDeviceId, parseRevisionId, parseVaultId } from "@nanosync/protocol";
import { encryptChunk, MAX_FILE_BYTES, parseManifest, type EncryptedObject, type ManifestEntry, type ManifestV1 } from "@nanosync/sync-core";
import { ClientLocal, type Entry } from "@nanosync/client-local";
export { applyNewFiles, applyNewFiles as applyManifest } from "./apply.ts";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Identity = { entryId: string; device: string; inode: string };
type Found = { path: string; kind: "file" | "directory"; stat: Stats; identity: string };
export interface ScanOptions { debounceMs?: number; stabilityMs?: number; maxBatch?: number; maxConcurrent?: number }
export interface ScanPlan {
  manifest: ManifestV1;
  /** A factory, not a one-shot iterator. Open and verify files again in manifest order for Step 9. */
  chunks(knownObjectIds?: ReadonlySet<string>): AsyncGenerator<EncryptedObject>;
  /** Commit only after the daemon has accepted/applied the revision, never on a failed upload. */
  commit(): void;
  suppressed: string[];
}
function validName(name: string): void {
  if (!name || name === "." || name === ".." || name.normalize("NFC") !== name || Buffer.byteLength(name) > 255 ||
      /[\u0000-\u001f\u007f-\u009f\/\\:*?"<>|]/u.test(name) || /[. ]$/u.test(name) ||
      /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name) ||
      !Array.from(name).every(c => c.codePointAt(0)! <= 0xffff ? !/[\ud800-\udfff]/u.test(c) : true)) throw new Error(`unsafe filename: ${name}`);
}
function safeStat(stat: Stats, kind: "file" | "directory") {
  if (stat.uid !== process.getuid!() || stat.isSymbolicLink() || stat.nlink !== (kind === "file" ? 1 : stat.nlink) ||
      !(kind === "file" ? stat.isFile() : stat.isDirectory()) || (kind === "file" && stat.size > MAX_FILE_BYTES)) throw new Error("unsafe filesystem entry");
}
function identity(stat: Stats) { return `${stat.dev}:${stat.ino}`; }
function stamp(stat: Stats) { return `${identity(stat)}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}:${stat.mode}`; }
function same(a: Stats, b: Stats) { return stamp(a) === stamp(b); }
function checkedRoot(root: string): string {
  const path = resolve(root), stat = lstatSync(path);
  safeStat(stat, "directory");
  if (realpathSync(path) !== path) throw new Error("root must not traverse a symlink");
  return path;
}
function openChecked(path: string, kind: "file" | "directory", expected?: Stats): number {
  const before = lstatSync(path); safeStat(before, kind);
  if (expected && !same(before, expected)) throw new Error("file changed during scan");
  const fd = openSync(path, FLAGS | (kind === "directory" ? constants.O_DIRECTORY : 0));
  try { const current = fstatSync(fd); safeStat(current, kind); if (!same(before, current)) throw new Error("file changed during scan"); return fd; }
  catch (error) { closeSync(fd); throw error; }
}

/** Directory-relative /proc/self/fd paths anchor traversal to open, no-follow descriptors. Linux only. */
function inventory(root: string): Found[] {
  const result: Found[] = [], active = new Set<string>();
  function descend(fd: number, path: string, stat: Stats) {
    const key = identity(stat); if (active.has(key)) throw new Error("directory cycle"); active.add(key);
    result.push({ path, kind: "directory", stat, identity: key });
    const names = readdirSync(`/proc/self/fd/${fd}`).sort();
    const folded = new Set<string>();
    for (const name of names) {
      validName(name);
      const relative = path ? `${path}/${name}` : name;
      if (Buffer.byteLength(relative) > 4096 || folded.has(name.toLowerCase())) throw new Error("ambiguous or overlong path");
      folded.add(name.toLowerCase());
      const target = `/proc/self/fd/${fd}/${name}`;
      const st = lstatSync(target);
      if (st.isDirectory()) {
        const child = openChecked(target, "directory", st);
        try { descend(child, relative, fstatSync(child)); } finally { closeSync(child); }
      } else {
        safeStat(st, "file");
        result.push({ path: relative, kind: "file", stat: st, identity: identity(st) });
      }
    }
    active.delete(key);
  }
  const fd = openChecked(root, "directory");
  try { descend(fd, "", fstatSync(fd)); if (!same(fstatSync(fd), lstatSync(root))) throw new Error("root replaced during scan"); }
  finally { closeSync(fd); }
  return result;
}

/** Walk each parent through open descriptors again; a rename outside the root fails the final root check. */
function openPath(root: string, path: string, expected: Stats): number {
  const anchor = openChecked(root, "directory"); let fd = anchor;
  try {
    const parts = path.split("/");
    for (let i = 0; i < parts.length - 1; i++) {
      const next = openChecked(`/proc/self/fd/${fd}/${parts[i]}`, "directory");
      if (fd !== anchor) closeSync(fd); fd = next;
    }
    const file = openChecked(`/proc/self/fd/${fd}/${parts.at(-1)}`, "file", expected);
    if (!same(fstatSync(anchor), lstatSync(root))) { closeSync(file); throw new Error("root replaced during scan"); }
    return file;
  } finally { if (fd !== anchor) closeSync(fd); closeSync(anchor); }
}

async function* readChunks(root: string, file: Found): AsyncGenerator<Uint8Array> {
  const fd = openPath(root, file.path, file.stat), hashSize = file.stat.size;
  try {
    let position = 0;
    while (position < hashSize) {
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, hashSize - position)); let used = 0;
      while (used < chunk.length) {
        const n = readSync(fd, chunk, used, chunk.length - used, position + used);
        if (!n) throw new Error("file shortened during scan"); used += n;
      }
      position += used; yield chunk;
    }
    if (!same(fstatSync(fd), file.stat)) throw new Error("file changed during scan");
    checkedRoot(root);
  } finally { closeSync(fd); }
}

export class LinuxScanner {
  readonly root: string;
  private readonly options: Required<ScanOptions>;
  constructor(root: string, private readonly local: ClientLocal, options: ScanOptions = {}) {
    if (process.platform !== "linux") throw new Error("Linux scanner requires Linux");
    this.root = checkedRoot(root);
    this.options = { debounceMs: options.debounceMs ?? 250, stabilityMs: options.stabilityMs ?? 500,
      maxBatch: options.maxBatch ?? 256, maxConcurrent: options.maxConcurrent ?? 2 };
    if (Object.values(this.options).some(v => !Number.isSafeInteger(v) || v < 0) || !this.options.maxBatch ||
        this.options.maxConcurrent < 1 || this.options.maxConcurrent > 8) throw new Error("invalid scanner options");
  }
  snapshot() { checkedRoot(this.root); return inventory(this.root); }
  async plan(priorInput: ManifestV1, revisionId: string, deviceId: string, master: Uint8Array): Promise<ScanPlan> {
    const prior = parseManifest(priorInput), revision = parseRevisionId(revisionId), device = parseDeviceId(deviceId);
    parseVaultId(prior.vaultId);
    if (revision === prior.revisionId || !(master instanceof Uint8Array) || master.length !== 32) throw new Error("invalid scan context");
    const key = master.slice(), files = this.snapshot(), old = new Map(prior.entries.map(e => [e.id, e]));
    const priorPath = new Map<string, ManifestEntry>();
    function index(e: ManifestEntry): string {
      if (e.parentId === null) return "";
      const parent = old.get(e.parentId); if (!parent) throw new Error("missing parent");
      return [index(parent), e.name].filter(Boolean).join("/");
    }
    for (const e of prior.entries) priorPath.set(index(e), e);
    const localEntries = this.local.entries(), localPath = new Map(localEntries.map(e => [e.path, e]));
    const idByIdentity = new Map<string, string[]>();
    for (const item of this.local.identities()) {
      const k = `${item.device}:${item.inode}`, ids = idByIdentity.get(k) ?? []; ids.push(item.entryId); idByIdentity.set(k, ids);
    }
    const occurrence = new Map<string, number>();
    for (const file of files) occurrence.set(file.identity, (occurrence.get(file.identity) ?? 0) + 1);
    const used = new Set<string>(), assigned = new Map<string, string>();
    for (const file of files) {
      if (localPath.get(file.path)?.hydration === "evicted")
        throw new Error("evicted name collision; reconcile before scanning");
      const atPath = priorPath.get(file.path) ?? (localPath.get(file.path) && old.get(localPath.get(file.path)!.id));
      const candidates = idByIdentity.get(file.identity) ?? [];
      // Identity wins over path for atomic replacement / rename only if one-to-one.
      const byInode = candidates.length === 1 && occurrence.get(file.identity) === 1 ? old.get(candidates[0]!) : undefined;
      const matches = (e?: ManifestEntry) => e && e.kind === file.kind;
      if (byInode && atPath && byInode.id !== atPath.id && matches(byInode) && matches(atPath))
        throw new Error("ambiguous replacement versus rename; manual resolution required");
      if (matches(byInode) && !used.has(byInode!.id)) assigned.set(file.path, byInode!.id);
      else if (matches(atPath) && !used.has(atPath!.id)) assigned.set(file.path, atPath!.id);
      else if (candidates.length > 1 || occurrence.get(file.identity)! > 1) throw new Error("ambiguous filesystem identity");
      else assigned.set(file.path, randomUUID());
      used.add(assigned.get(file.path)!);
    }
    if (used.size !== files.length) throw new Error("ambiguous rename; manual resolution required");
    const entries: ManifestEntry[] = [], updates: Entry[] = [], identities: Identity[] = [], suppressed: string[] = [];
    const planned = new Map<string, Found>();
    const operationId = randomUUID(); this.local.enqueueOperation(operationId, "scan");
    const fileResults = new Map<string, { size: number; sha256: string; chunks: { objectId: string; length: number }[] }>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.options.maxConcurrent, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++]!; if (file.kind !== "file") continue;
        const hash = createHash("sha256"), chunks = [];
        for await (const bytes of readChunks(this.root, file)) {
          hash.update(bytes);
          const encrypted = await encryptChunk(bytes, key, prior.vaultId);
          chunks.push({ objectId: encrypted.reference.objectId, length: bytes.length });
        }
        fileResults.set(file.path, { size: file.stat.size, sha256: hash.digest("hex"), chunks });
      }
    }));
    const after = this.snapshot();
    if (after.length !== files.length || after.some((file, i) => file.path !== files[i]!.path || !same(file.stat, files[i]!.stat)))
      throw new Error("directory changed during scan");
    for (const file of files) {
      const id = assigned.get(file.path)!, parentPath = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : "";
      const entry: ManifestEntry = { id, parentId: file.path ? assigned.get(parentPath)! : null,
        name: file.path ? file.path.slice(parentPath ? parentPath.length + 1 : 0) : "", kind: file.kind };
      if (file.kind === "file") {
        Object.assign(entry, { ...fileResults.get(file.path)!, executable: !!(file.stat.mode & 0o100) });
        planned.set(file.path, file);
        if (this.local.matchesSuppression(file.path, entry.sha256!)) suppressed.push(file.path);
      }
      entries.push(entry);
      updates.push({ id, path: file.path, kind: file.kind, fingerprint: entry.sha256 ?? null, hydration: "downloaded", revision });
      const [dev, ino] = file.identity.split(":"); identities.push({ entryId: id, device: dev!, inode: ino! });
    }
    // Evicted objects are present in the manifest but deliberately absent on disk.
    for (const entry of prior.entries) if (!used.has(entry.id) && entry.kind !== "tombstone") {
      const path = index(entry), local = localPath.get(path);
      if (entry.parentId && !used.has(entry.parentId) && localPath.get(index(old.get(entry.parentId)!))?.hydration !== "evicted") continue;
      if (local?.id === entry.id && local.hydration === "evicted") {
        entries.push(entry); updates.push(local); continue;
      }
      if (entry.parentId !== null) {
        entries.push({ id: entry.id, parentId: entry.parentId, name: entry.name, kind: "tombstone", deletedKind: entry.kind });
      }
    }
    for (const entry of prior.entries) if (entry.kind === "tombstone" && !used.has(entry.id)) entries.push({ ...entry });

    // Tombstones must have a live directory parent and must not reserve a name
    // reused by a new file forever. Keep the ID, archive only the location.
    const liveDirectories = new Map(entries.filter(e => e.kind === "directory").map(e => [e.id, e]));
    const rootId = assigned.get("")!;
    const occupied = new Set(entries.filter(e => e.kind !== "tombstone" && e.parentId !== null)
      .map(e => `${e.parentId}/${e.name.toLowerCase()}`));
    // A remote-only evicted file still owns its namespace: never silently replace it.
    if (occupied.size !== entries.filter(e => e.kind !== "tombstone" && e.parentId !== null).length)
      throw new Error("evicted or live name collision; reconcile before scanning");
    for (const tombstone of entries.filter(e => e.kind === "tombstone").sort((a, b) => a.id.localeCompare(b.id))) {
      let parentId = tombstone.parentId!;
      while (!liveDirectories.has(parentId)) {
        const ancestor = old.get(parentId);
        if (!ancestor?.parentId) { parentId = rootId; break; }
        parentId = ancestor.parentId;
      }
      const relocated = parentId !== tombstone.parentId;
      tombstone.parentId = parentId;
      const original = tombstone.name;
      const candidate = `${parentId}/${original.toLowerCase()}`;
      if (relocated || occupied.has(candidate)) {
        let chosen: string | undefined;
        for (let attempt = 0; attempt < 32; attempt++) {
          const suffix = ` (deleted ${tombstone.id}${attempt ? `-${attempt}` : ""})`;
          let stem = "";
          for (const char of original) if (Buffer.byteLength(stem + char + suffix) <= 255) stem += char;
          const name = `${stem.replace(/[. ]+$/u, "") || "entry"}${suffix}`;
          if (!occupied.has(`${parentId}/${name.toLowerCase()}`)) { chosen = name; break; }
        }
        if (!chosen) throw new Error("tombstone archival name collision limit exceeded");
        tombstone.name = chosen;
      }
      occupied.add(`${parentId}/${tombstone.name.toLowerCase()}`);
    }
    const nextById = new Map(entries.map(e => [e.id, e]));
    function nextPath(entry: ManifestEntry): string {
      if (entry.parentId === null) return "";
      const parent = nextById.get(entry.parentId)!;
      return [nextPath(parent), entry.name].filter(Boolean).join("/");
    }
    for (const entry of entries.filter(e => e.kind === "tombstone"))
      updates.push({ id: entry.id, path: nextPath(entry), kind: "tombstone", fingerprint: null, hydration: "downloaded", revision });
    const manifest = parseManifest({ version: 1, vaultId: prior.vaultId, revisionId: revision, parents: [prior.revisionId], creatingDeviceId: device, entries });
    const scanner = this;
    return { manifest, suppressed, commit: () => { scanner.local.recordScan(updates, identities); for (const path of suppressed) scanner.local.consumeSuppression(path, updates.find(e => e.path === path)!.fingerprint!); scanner.local.transition("operations", operationId, "running"); scanner.local.transition("operations", operationId, "done"); },
      async *chunks(knownObjectIds: ReadonlySet<string> = new Set()) {
        const yielded = new Set<string>();
        for (const entry of manifest.entries) {
          if (entry.kind !== "file") continue;
          const path = [...planned].find(([p]) => assigned.get(p) === entry.id)?.[0];
          if (path === undefined) continue;
          const file = planned.get(path)!, digest = createHash("sha256"); let index = 0;
          for await (const bytes of readChunks(scanner.root, file)) {
            digest.update(bytes);
            const encrypted = await encryptChunk(bytes, key, manifest.vaultId);
            if (encrypted.reference.objectId !== entry.chunks![index++]?.objectId) throw new Error("file changed before publication");
            if (!knownObjectIds.has(encrypted.reference.objectId) && !yielded.has(encrypted.reference.objectId)) {
              yielded.add(encrypted.reference.objectId); yield encrypted;
            }
          }
          if (index !== entry.chunks!.length || digest.digest("hex") !== entry.sha256) throw new Error("file changed before publication");
        }
      } };
  }
}

/** Watch notifications are hints only: overflow, restart and every settled batch use a full scan. */
export class LinuxWatcher {
  private watchers: FSWatcher[] = [];
  private pending = 0;
  private last = 0;
  private baseline?: string;
  private stableSince = 0;
  private overflow = false;
  constructor(readonly scanner: LinuxScanner, readonly options: ScanOptions = {}) { this.notify(0); }
  notify(now = Date.now()) {
    this.pending++;
    if (this.pending >= (this.options.maxBatch ?? 256)) this.overflow = true;
    this.last = now;
  }
  start() {
    this.close();
    for (const dir of this.scanner.snapshot().filter(f => f.kind === "directory")) {
      const watcher = watch(resolve(this.scanner.root, dir.path), () => this.notify());
      watcher.on("error", () => this.notify()); this.watchers.push(watcher);
    }
    this.notify();
  }
  close() { for (const watcher of this.watchers) watcher.close(); this.watchers = []; }
  /** Returns false until debounce AND an identical full snapshot spans stabilityMs. */
  ready(now = Date.now()): boolean {
    if (!this.pending || now - this.last < (this.options.debounceMs ?? 250)) return false;
    const signature = this.scanner.snapshot().map(f => `${f.path}:${stamp(f.stat)}`).join("\n");
    if (signature !== this.baseline) { this.baseline = signature; this.stableSince = now; return false; }
    if (now - this.stableSince < (this.options.stabilityMs ?? 500)) return false;
    this.pending = 0; this.overflow = false; return true;
  }
  get overflowed() { return this.overflow; }
}
