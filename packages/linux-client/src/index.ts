import { createHash, randomUUID } from "node:crypto";
import {
  constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync,
  realpathSync, watch, type FSWatcher, type BigIntStats,
} from "node:fs";
import { resolve } from "node:path";
import { CHUNK_SIZE, parseDeviceId, parseRevisionId, parseVaultId } from "@nanosync/protocol";
import {
  encryptChunk, manifestPaths, MAX_FILE_BYTES, parseManifest,
  type EncryptedObject, type ManifestEntry, type ManifestV1,
} from "@nanosync/sync-core";
import { ClientLocal, type Entry } from "@nanosync/client-local";
import { IgnoreRules } from "./ignore.ts";
export { IgnoreRules } from "./ignore.ts";
export { applyNewFiles, applyNewFiles as applyManifest } from "./apply.ts";
export { hydrateFile } from "./hydration.ts";

const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
type Stats = BigIntStats;
const lstat = (path: string) => lstatSync(path, { bigint: true });
const fstat = (fd: number) => fstatSync(fd, { bigint: true });
type Content = { size: number; sha256: string; chunks: { objectId: string; length: number }[] };
type CachedContent = { stamp: string; context: string; content: Content };
type Identity = { entryId: string; device: string; inode: string };
type Found = { path: string; kind: "file" | "directory"; stat: Stats; identity: string };
export interface ScanOptions { beforeWork?: () => void | Promise<void>; debounceMs?: number; stabilityMs?: number; maxBatch?: number; maxConcurrent?: number }
export interface ScanPlan {
  manifest: ManifestV1;
  /** A factory, not a one-shot iterator. Open and verify files again in manifest order for Step 9. */
  chunks(knownObjectIds?: ReadonlySet<string>): AsyncGenerator<EncryptedObject>;
  /** Commit after acceptance, or after durably journaling the uploaded local branch for reconciliation. */
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
  if (stat.uid !== BigInt(process.getuid!()) || stat.isSymbolicLink() || stat.nlink !== (kind === "file" ? 1n : stat.nlink) ||
      !(kind === "file" ? stat.isFile() : stat.isDirectory()) || (kind === "file" && stat.size > MAX_FILE_BYTES)) throw new Error("unsafe filesystem entry");
}
function identity(stat: Stats) { return `${stat.dev}:${stat.ino}`; }
function stamp(stat: Stats) { return `${identity(stat)}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}:${stat.mode}`; }
function same(a: Stats, b: Stats) { return stamp(a) === stamp(b); }
function checkedRoot(root: string): string {
  const path = resolve(root), stat = lstat(path);
  safeStat(stat, "directory");
  if (realpathSync(path) !== path) throw new Error("root must not traverse a symlink");
  return path;
}
function openChecked(path: string, kind: "file" | "directory", expected?: Stats): number {
  const before = lstat(path); safeStat(before, kind);
  if (expected && !same(before, expected)) throw new Error("file changed during scan");
  const fd = openSync(path, FLAGS | (kind === "directory" ? constants.O_DIRECTORY : 0));
  try { const current = fstat(fd); safeStat(current, kind); if (!same(before, current)) throw new Error("file changed during scan"); return fd; }
  catch (error) { closeSync(fd); throw error; }
}

/** Directory-relative /proc/self/fd paths anchor traversal to open, no-follow descriptors. Linux only. */
function* inventory(root: string, ignore: IgnoreRules): Generator<Found> {
  const active = new Set<string>();
  function* descend(fd: number, path: string, stat: Stats): Generator<Found> {
    const key = identity(stat); if (active.has(key)) throw new Error("directory cycle"); active.add(key);
    yield { path, kind: "directory", stat, identity: key };
    const names = readdirSync(`/proc/self/fd/${fd}`).sort();
    const folded = new Set<string>();
    for (const name of names) {
      const relative = path ? `${path}/${name}` : name;
      // Check exclusion before even lstat: ignored children may be links or special files.
      if (ignore.ignores(relative)) continue;
      validName(name);
      if (
        Buffer.byteLength(relative) > 4096 || folded.has(name.toLowerCase())
      ) throw new Error("ambiguous or overlong path");
      folded.add(name.toLowerCase());
      const target = `/proc/self/fd/${fd}/${name}`;
      const st = lstat(target);
      if (st.isDirectory() && ignore.ignores(relative, true)) continue;
      if (st.isDirectory()) {
        const child = openChecked(target, "directory", st);
        try {
          yield* descend(child, relative, fstat(child));
        } finally {
          closeSync(child);
        }
      } else {
        safeStat(st, "file");
        yield { path: relative, kind: "file", stat: st, identity: identity(st) };
      }
    }
    active.delete(key);
  }
  const fd = openChecked(root, "directory");
  try { yield* descend(fd, "", fstat(fd)); if (!same(fstat(fd), lstat(root))) throw new Error("root replaced during scan"); }
  finally { closeSync(fd); }
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
    if (!same(fstat(anchor), lstat(root))) { closeSync(file); throw new Error("root replaced during scan"); }
    return file;
  } finally { if (fd !== anchor) closeSync(fd); closeSync(anchor); }
}

async function* readChunks(root: string, file: Found, beforeWork?: () => void | Promise<void>): AsyncGenerator<Uint8Array> {
  const fd = openPath(root, file.path, file.stat), hashSize = Number(file.stat.size);
  try {
    let position = 0;
    while (position < hashSize) {
      await beforeWork?.();
      const chunk = Buffer.allocUnsafe(Math.min(CHUNK_SIZE, hashSize - position)); let used = 0;
      while (used < chunk.length) {
        const n = readSync(fd, chunk, used, chunk.length - used, position + used);
        if (!n) throw new Error("file shortened during scan"); used += n;
      }
      position += used; yield chunk;
    }
    if (!same(fstat(fd), file.stat)) throw new Error("file changed during scan");
    checkedRoot(root);
  } finally { closeSync(fd); }
}

export class LinuxScanner {
  readonly root: string;
  private readonly options: Required<Omit<ScanOptions, "beforeWork">>;
  private readonly beforeWork?: () => void | Promise<void>;
  private readonly rootIdentity: string;
  // shortcut: trust filesystem change stamps; use forced content verification for filesystems without reliable timestamps.
  private contentCache = new Map<string, CachedContent>();
  constructor(root: string, private readonly local: ClientLocal, options: ScanOptions = {}) {
    if (process.platform !== "linux") throw new Error("Linux scanner requires Linux");
    this.root = checkedRoot(root);
    this.rootIdentity = identity(lstat(this.root));
    const entry = local.entries().find(entry => entry.path === "" && entry.kind === "directory");
    const recorded = entry && local.identities().find(item => item.entryId === entry.id);
    if (recorded && `${recorded.device}:${recorded.inode}` !== this.rootIdentity) throw new Error("root identity changed");
    this.beforeWork = options.beforeWork;
    this.options = { debounceMs: options.debounceMs ?? 250, stabilityMs: options.stabilityMs ?? 500,
      maxBatch: options.maxBatch ?? 256, maxConcurrent: options.maxConcurrent ?? 2 };
    if (Object.values(this.options).some(v => !Number.isSafeInteger(v) || v < 0) || !this.options.maxBatch ||
        this.options.maxConcurrent < 1 || this.options.maxConcurrent > 8) throw new Error("invalid scanner options");
  }
  assertRoot() {
    checkedRoot(this.root);
    if (identity(lstat(this.root)) !== this.rootIdentity) throw new Error("root identity changed");
  }
  rules() { this.assertRoot(); return new IgnoreRules(this.root); }
  snapshot() { const rules = this.rules(); return [...inventory(this.root, rules)]; }
  /** Read-only full-content check against the last applied inventory, including unscanned edits. */
  hasUnsyncedChanges(): boolean {
    const rules = this.rules(), found = this.snapshot();
    const entries = this.local.entries().filter(e => e.kind !== 'tombstone' && !rules.ignores(e.path, e.kind === 'directory'));
    const prior = new Map(entries.map(e => [e.path, e]));
    for (const file of found) {
      if (!file.path) continue; // Root identity/metadata changes do not constitute user work.
      const old = prior.get(file.path);
      if (!old || old.kind !== file.kind || old.hydration === 'evicted') return true;
      if (file.kind === 'file') {
        if (old.executable === null || old.executable === undefined || !!(file.stat.mode & 0o100n) !== !!old.executable) return true;
        const fd = openPath(this.root, file.path, file.stat);
        try {
          const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(65536);
          let position = 0;
          while (position < Number(file.stat.size)) {
            const n = readSync(fd, buffer, 0, Math.min(buffer.length, Number(file.stat.size) - position), position);
            if (!n) throw new Error('file shortened during dirty check');
            hash.update(buffer.subarray(0, n)); position += n;
          }
          if (!same(fstat(fd), file.stat)) throw new Error('file changed during dirty check');
          if (hash.digest('hex') !== old.fingerprint) return true;
        } finally { closeSync(fd); }
      }
    }
    const paths = new Set(found.map(f => f.path));
    return entries.some(e => e.path && e.hydration !== 'evicted' && !paths.has(e.path));
  }
  async plan(priorInput: ManifestV1, revisionId: string, deviceId: string, master: Uint8Array, identityHints?: ManifestV1): Promise<ScanPlan> {
    await this.beforeWork?.(); this.assertRoot();
    const prior = parseManifest(priorInput), revision = parseRevisionId(revisionId), device = parseDeviceId(deviceId);
    parseVaultId(prior.vaultId);
    if (revision === prior.revisionId || !(master instanceof Uint8Array) || master.length !== 32) throw new Error("invalid scan context");
    const key = master.slice();
    const context = `${prior.vaultId}:${createHash("sha256").update(key).digest("hex")}`;
    const rules = this.rules();
    const localEntries = this.local.entries();
    this.local.markIgnored(localEntries.filter(e => e.path && rules.ignores(e.path, e.kind === "directory")).map(e => e.id));
    const files: Found[] = this.beforeWork ? [] : this.snapshot();
    if (this.beforeWork) for (const file of inventory(this.root, rules)) {
      await this.beforeWork?.(); this.assertRoot();
      files.push(file);
    }
    const old = new Map(prior.entries.map(e => [e.id, e]));
    const priorPath = new Map<string, ManifestEntry>();
    function index(e: ManifestEntry): string {
      if (e.parentId === null) return "";
      const parent = old.get(e.parentId); if (!parent) throw new Error("missing parent");
      return [index(parent), e.name].filter(Boolean).join("/");
    }
    for (const e of prior.entries) priorPath.set(index(e), e);
    const hints = identityHints ? manifestPaths(parseManifest(identityHints)) : new Map<string, ManifestEntry>();
    const localPath = new Map(localEntries.map(e => [e.path, e]));
    const visible = new Set(files.map(f => f.path));
    for (const recorded of localEntries) if (recorded.path && this.local.wasIgnored(recorded.id) &&
        !rules.ignores(recorded.path, recorded.kind === "directory") &&
        (!visible.has(recorded.path) || priorPath.get(recorded.path)?.id !== recorded.id ||
          priorPath.get(recorded.path)?.kind === "tombstone"))
      throw new Error(`previously ignored local path requires manual reconciliation: ${recorded.path}`);
    for (const file of files) {
      await this.beforeWork?.(); this.assertRoot();
      const previous = priorPath.get(file.path), recorded = localPath.get(file.path);
      if (recorded && this.local.wasIgnored(recorded.id) && (!previous || previous.kind === "tombstone" || previous.id !== recorded.id) ||
          recorded && !old.has(recorded.id) || file.path && previous && previous.kind !== "tombstone" && (!recorded || recorded.id !== previous.id ||
          previous.kind === "file" && recorded.fingerprint !== previous.sha256))
        throw new Error(`previously ignored or divergent local path requires manual reconciliation: ${file.path}`);
    }
    const idByIdentity = new Map<string, string[]>();
    for (const item of this.local.identities()) {
      const k = `${item.device}:${item.inode}`;
      const ids = idByIdentity.get(k) ?? [];
      ids.push(item.entryId);
      idByIdentity.set(k, ids);
    }
    const occurrence = new Map<string, number>();
    for (const file of files) occurrence.set(file.identity, (occurrence.get(file.identity) ?? 0) + 1);
    const used = new Set<string>(), assigned = new Map<string, string>();
    for (const file of files) {
      await this.beforeWork?.(); this.assertRoot();
      if (localPath.get(file.path)?.hydration === "evicted")
        throw new Error("evicted name collision; reconcile before scanning");
      const atPath = priorPath.get(file.path) ??
        (localPath.get(file.path) && old.get(localPath.get(file.path)!.id)) ??
        hints.get(file.path);
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
    const operationId = randomUUID();
    const fileResults = new Map<string, Content>();
    const nextCache = new Map<string, CachedContent>();
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(this.options.maxConcurrent, files.length) }, async () => {
      while (cursor < files.length) {
        const file = files[cursor++]!;
        if (file.kind !== "file") continue;
        const cached = this.contentCache.get(file.path);
        if (cached?.stamp === stamp(file.stat) && cached.context === context) {
          fileResults.set(file.path, cached.content);
          nextCache.set(file.path, cached);
          continue;
        }
        const hash = createHash("sha256");
        const chunks = [];
        for await (const bytes of readChunks(this.root, file, async () => { await this.beforeWork?.(); this.assertRoot(); })) {
          await this.beforeWork?.(); this.assertRoot();
          hash.update(bytes);
          const encrypted = await encryptChunk(bytes, key, prior.vaultId);
          chunks.push({ objectId: encrypted.reference.objectId, length: bytes.length });
        }
        const content = { size: Number(file.stat.size), sha256: hash.digest("hex"), chunks };
        fileResults.set(file.path, content);
        nextCache.set(file.path, { stamp: stamp(file.stat), context, content });
      }
    }));
    const after = this.snapshot();
    if (this.rules().signature !== rules.signature) throw new Error(".nanosyncignore changed during scan");
    if (after.length !== files.length || after.some((file, i) => file.path !== files[i]!.path || !same(file.stat, files[i]!.stat)))
      throw new Error("directory changed during scan");
    for (const file of files) if (file.path && this.local.wasIgnored(assigned.get(file.path)!) &&
      (file.kind === "file" && fileResults.get(file.path)?.sha256 !== priorPath.get(file.path)?.sha256 ||
        !priorPath.has(file.path)))
      throw new Error(`previously ignored local path requires manual reconciliation: ${file.path}`);
    for (const file of files) {
      await this.beforeWork?.(); this.assertRoot();
      const id = assigned.get(file.path)!;
      const parentPath = file.path.includes("/")
        ? file.path.slice(0, file.path.lastIndexOf("/"))
        : "";
      const entry: ManifestEntry = { id, parentId: file.path ? assigned.get(parentPath)! : null,
        name: file.path ? file.path.slice(parentPath ? parentPath.length + 1 : 0) : "", kind: file.kind };
      if (old.get(id)?.conflict) entry.conflict = old.get(id)!.conflict;
      if (file.kind === "file") {
        const content = fileResults.get(file.path)!;
        Object.assign(entry, { ...content, chunks: content.chunks.map(chunk => ({ ...chunk })), executable: !!(file.stat.mode & 0o100n) });
        planned.set(id, file);
        if (this.local.matchesSuppression(file.path, entry.sha256!)) suppressed.push(file.path);
      }
      entries.push(entry);
      updates.push({ id, path: file.path, kind: file.kind, fingerprint: entry.sha256 ?? null, executable: entry.kind === "file" ? (entry.executable ? 1 : 0) : null, hydration: "downloaded", revision });
      const [dev, ino] = file.identity.split(":"); identities.push({ entryId: id, device: dev!, inode: ino! });
    }
    // Evicted objects are present in the manifest but deliberately absent on disk.
    for (const entry of prior.entries) if (!used.has(entry.id) && entry.kind !== "tombstone") {
      const path = index(entry), local = localPath.get(path);
      if (rules.ignores(path, entry.kind === "directory")) {
        entries.push(entry);
        if (local?.id === entry.id) updates.push(local);
        continue;
      }
      if (path && (!local || local.id !== entry.id || local.revision !== prior.revisionId))
        throw new Error(`untracked or divergent remote path requires manual reconciliation: ${path}`);
      if (this.local.wasIgnored(entry.id)) throw new Error(`previously ignored absence requires manual reconciliation: ${path}`);
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
    const ignoredLocalIds = new Set(localEntries.filter(local => local.path &&
      rules.ignores(local.path, local.kind === "directory")).map(local => local.id));
    for (const entry of entries.filter(e => e.kind === "tombstone" && !ignoredLocalIds.has(e.id)))
      updates.push({ id: entry.id, path: nextPath(entry), kind: "tombstone", fingerprint: null, hydration: "downloaded", revision });
    const updatedIds = new Set(updates.map(update => update.id));
    for (const local of localEntries) if (ignoredLocalIds.has(local.id) && !updatedIds.has(local.id)) updates.push(local);
    const manifest = parseManifest({
      version: 1,
      vaultId: prior.vaultId,
      revisionId: revision,
      parents: [prior.revisionId],
      creatingDeviceId: device,
      entries,
    });
    this.contentCache = nextCache;
    const scanner = this;
    return { manifest, suppressed, commit: () => {
      const current = scanner.snapshot();
      if (scanner.rules().signature !== rules.signature) throw new Error(".nanosyncignore changed before scan commit");
      if (current.length !== files.length || current.some((file, i) => file.path !== files[i]!.path || !same(file.stat, files[i]!.stat)))
        throw new Error("local tree changed before scan commit");
      scanner.local.enqueueOperation(operationId, "scan");
      scanner.local.recordScan(updates, identities);
      scanner.local.clearIgnored(files.filter(f => f.path).map(f => assigned.get(f.path)!));
      for (const path of suppressed) scanner.local.consumeSuppression(path, updates.find(e => e.path === path)!.fingerprint!);
      scanner.local.transition("operations", operationId, "running"); scanner.local.transition("operations", operationId, "done"); },
      async *chunks(knownObjectIds: ReadonlySet<string> = new Set()) {
        const yielded = new Set<string>();
        for (const entry of manifest.entries) {
          await scanner.beforeWork?.(); scanner.assertRoot();
          if (entry.kind !== "file") continue;
          const file = planned.get(entry.id);
          if (!file) continue;
          if (entry.chunks!.every(chunk => knownObjectIds.has(chunk.objectId) || yielded.has(chunk.objectId))) {
            const fd = openPath(scanner.root, file.path, file.stat);
            try { if (!same(fstat(fd), file.stat)) throw new Error("file changed before publication"); }
            finally { closeSync(fd); }
            continue;
          }
          const digest = createHash("sha256"); let index = 0;
          for await (const bytes of readChunks(scanner.root, file, async () => { await scanner.beforeWork?.(); scanner.assertRoot(); })) {
            await scanner.beforeWork?.(); scanner.assertRoot();
            digest.update(bytes);
            const expected = entry.chunks![index++];
            if (expected && (knownObjectIds.has(expected.objectId) || yielded.has(expected.objectId))) continue;
            const encrypted = await encryptChunk(bytes, key, manifest.vaultId);
            if (encrypted.reference.objectId !== expected?.objectId) throw new Error("file changed before publication");
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
  private watched: string[] = [];
  private pending = 0;
  private last = 0;
  private baseline?: string;
  private stableSince = 0;
  private overflow = false;
  constructor(readonly scanner: LinuxScanner, readonly options: ScanOptions = {}, private readonly onChange?: () => void) { this.notify(0, false); }
  notify(now = Date.now(), changed = true) {
    if (changed) this.onChange?.();
    this.pending++;
    if (this.pending >= (this.options.maxBatch ?? 256)) this.overflow = true;
    this.last = now;
  }
  start() {
    this.close();
    this.watched = this.scanner.snapshot().filter(f => f.kind === "directory").map(f => f.path);
    for (const path of this.watched) {
      const watcher = watch(resolve(this.scanner.root, path), () => this.notify());
      watcher.on("error", () => this.notify()); this.watchers.push(watcher);
    }
    this.notify(Date.now(), false);
  }
  refresh() {
    const paths = this.scanner.snapshot().filter(f => f.kind === "directory").map(f => f.path);
    if (paths.length !== this.watched.length || paths.some((path, i) => path !== this.watched[i])) this.start();
  }
  close() { for (const watcher of this.watchers) watcher.close(); this.watchers = []; this.watched = []; }
  /** Returns false until debounce AND an identical full snapshot spans stabilityMs. */
  ready(now = Date.now()): boolean {
    if (!this.pending || now - this.last < (this.options.debounceMs ?? 250)) return false;
    const signature = this.scanner.rules().signature + "\n" + this.scanner.snapshot().map(f => `${f.path}:${stamp(f.stat)}`).join("\n");
    if (signature !== this.baseline) { this.baseline = signature; this.stableSince = now; return false; }
    if (now - this.stableSince < (this.options.stabilityMs ?? 500)) return false;
    this.pending = 0; this.overflow = false; return true;
  }
  get overflowed() { return this.overflow; }
}
