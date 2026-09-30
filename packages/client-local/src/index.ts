import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, fchmodSync, fsyncSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CHUNK_SIZE, parseAdvanceHeadRequest, parseCiphertextChecksum, parseDeviceId, parseIdempotencyKey, parseObjectFrameHeader, parseObjectId, parseRevisionId, parseVaultId, type AdvanceHeadRequest, type VisibleObjectReference } from "@nanosync/protocol";
import type { ChunkJournal, ManifestV1 } from "@nanosync/sync-core";

const hash = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hex = (value: string) => { if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid digest"); return value; };
const uuid = (value: string) => parseRevisionId(value);
const integer = (value: number) => { if (!Number.isSafeInteger(value) || value < 0) throw new Error("invalid sequence or length"); return value; };
const noSymlink = constants.O_NOFOLLOW ?? 0;
const schema1 = `
CREATE TABLE migrations(version INTEGER PRIMARY KEY, checksum TEXT NOT NULL) STRICT;
CREATE TABLE identity(singleton INTEGER PRIMARY KEY CHECK(singleton=1), vault TEXT NOT NULL, device TEXT NOT NULL) STRICT;
CREATE TABLE heads(kind TEXT PRIMARY KEY CHECK(kind IN ('observed','accepted','applied')), revision TEXT, sequence INTEGER NOT NULL CHECK(sequence>=0), CHECK((sequence=0 AND revision IS NULL) OR (sequence>0 AND revision IS NOT NULL))) STRICT;
CREATE TABLE entries(id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('file','directory','tombstone')), fingerprint TEXT, hydration TEXT NOT NULL CHECK(hydration IN ('downloaded','evicted')), revision TEXT) STRICT;
CREATE TABLE operations(id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('scan','evict','download','apply','publish','merge')), entry_id TEXT, state TEXT NOT NULL CHECK(state IN ('pending','running','done','blocked')), detail TEXT NOT NULL DEFAULT '{}', FOREIGN KEY(entry_id) REFERENCES entries(id)) STRICT;
CREATE TABLE transfers(id TEXT PRIMARY KEY, object_id TEXT NOT NULL, direction TEXT NOT NULL CHECK(direction IN ('upload','download')), state TEXT NOT NULL CHECK(state IN ('pending','running','done','blocked')), attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts>=0)) STRICT;
CREATE TABLE conflicts(id TEXT PRIMARY KEY, entry_id TEXT NOT NULL, source_revision TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','resolved')), FOREIGN KEY(entry_id) REFERENCES entries(id)) STRICT;
CREATE TABLE proposals(id INTEGER PRIMARY KEY CHECK(id=1), revision TEXT NOT NULL UNIQUE, request_json TEXT NOT NULL, manifest BLOB NOT NULL, digest TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','accepted')), accepted_sequence INTEGER, CHECK((state='prepared' AND accepted_sequence IS NULL) OR (state='accepted' AND accepted_sequence>0))) STRICT;
CREATE TABLE chunks(object_id TEXT PRIMARY KEY, checksum TEXT NOT NULL, ciphertext_length INTEGER NOT NULL, plaintext_length INTEGER NOT NULL CHECK(plaintext_length BETWEEN 1 AND ${CHUNK_SIZE}), accessed INTEGER NOT NULL CHECK(accessed>=0)) STRICT;
`;
const schema2 = `CREATE TABLE suppression(path TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, operation_id TEXT NOT NULL, FOREIGN KEY(operation_id) REFERENCES operations(id)) STRICT;`;
const schema3 = `CREATE TABLE file_identity(entry_id TEXT PRIMARY KEY, device TEXT NOT NULL, inode TEXT NOT NULL, FOREIGN KEY(entry_id) REFERENCES entries(id)) STRICT;`;
const schema4 = `CREATE TABLE hydration(id TEXT PRIMARY KEY, entry_id TEXT NOT NULL REFERENCES entries(id), revision TEXT NOT NULL, sequence INTEGER NOT NULL CHECK(sequence>0), direction TEXT NOT NULL CHECK(direction IN ('evict','download')), root_device TEXT NOT NULL, root_inode TEXT NOT NULL, file_device TEXT, file_inode TEXT, CHECK((direction='evict' AND file_device IS NOT NULL AND file_inode IS NOT NULL) OR (direction='download' AND file_device IS NULL AND file_inode IS NULL))) STRICT;`;
const schema5 = `CREATE TABLE restores(singleton INTEGER PRIMARY KEY CHECK(singleton=1), revision TEXT NOT NULL, base_revision TEXT NOT NULL) STRICT;`;
const migrations = [schema1, schema2, schema3, schema4, schema5];
const schemaDigest = (db: Database) => hash(db.query<{ sql: string }, []>("SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all().map(r => r.sql).join("\n"));
let expectedSchema: string | undefined;
function expectedDigest(): string {
  if (!expectedSchema) {
    const db = new Database(":memory:");
    try { for (const sql of migrations) db.exec(sql); expectedSchema = schemaDigest(db); } finally { db.close(); }
  }
  return expectedSchema;
}
function secureDir(path: string, create = false): string {
  const target = resolve(path);
  if (create && !existsSync(target)) mkdirSync(target, { mode: 0o700 });
  const st = lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!() || (st.mode & 0o077) !== 0 || realpathSync(target) !== target) throw new Error("unsafe private directory");
  return target;
}
function secureFile(path: string): void {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o177) !== 0) throw new Error("unsafe private file");
}
function sidecars(path: string) { for (const suffix of ["", "-wal", "-shm", "-journal"]) if (existsSync(path + suffix)) secureFile(path + suffix); }
function syncDir(path: string) { const fd = openSync(path, constants.O_RDONLY | noSymlink); try { fsyncSync(fd); } finally { closeSync(fd); } }
function createPrivate(path: string) { const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noSymlink, 0o600); try { fchmodSync(fd, 0o600); fsyncSync(fd); } finally { closeSync(fd); } syncDir(dirname(path)); }
function row<T>(db: Database, sql: string, ...params: (string | number)[]): T | null { return db.query<T, (string | number)[]>(sql).get(...params); }
function all<T>(db: Database, sql: string, ...params: (string | number)[]): T[] { return db.query<T, (string | number)[]>(sql).all(...params); }
function run(db: Database, sql: string, ...params: (string | number | Uint8Array | null)[]) { db.query(sql).run(...params); }

export interface Head { revisionId: string | null; sequence: number }
export interface Entry { id: string; path: string; kind: "file" | "directory" | "tombstone"; fingerprint: string | null; hydration: "downloaded" | "evicted"; revision: string | null }
export interface Work { id: string; state: "pending" | "running" | "done" | "blocked" }
export interface HydrationIntent { id: string; entryId: string; revision: string; sequence: number; direction: "evict" | "download"; rootDevice: string; rootInode: string; fileDevice: string | null; fileInode: string | null }
export class ClientLocal implements ChunkJournal {
  private readonly db: Database;
  private readonly root: string;
  private readonly cache: string;
  private readonly vault: string;
  private closed = false;
  private tick = 0;
  readonly maxCacheBytes: number;

  constructor(directory: string, vaultId: string, deviceId: string, maxCacheBytes = 256 * 1024 * 1024) {
    this.vault = parseVaultId(vaultId); parseDeviceId(deviceId);
    if (!Number.isSafeInteger(maxCacheBytes) || maxCacheBytes < CHUNK_SIZE || maxCacheBytes > 50_000_000_000) throw new Error("invalid cache budget");
    this.maxCacheBytes = maxCacheBytes;
    this.root = secureDir(directory, true);
    this.cache = secureDir(join(this.root, "chunks"), true);
    const filename = join(this.root, "local.sqlite");
    if (!existsSync(filename)) createPrivate(filename);
    sidecars(filename);
    this.db = new Database(filename, { create: false, readwrite: true, strict: true });
    try {
      this.db.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL");
      if (row<{ foreign_keys: number }>(this.db, "PRAGMA foreign_keys")?.foreign_keys !== 1 || row<{ synchronous: number }>(this.db, "PRAGMA synchronous")?.synchronous !== 2 || row<{ journal_mode: string }>(this.db, "PRAGMA journal_mode")?.journal_mode !== "wal") throw new Error("unsafe SQLite settings");
      this.migrate();
      if (row<{ integrity_check: string }>(this.db, "PRAGMA integrity_check")?.integrity_check !== "ok" || schemaDigest(this.db) !== expectedDigest()) throw new Error("corrupt local schema");
      this.write(() => {
        const identity = row<{ vault: string; device: string }>(this.db, "SELECT vault,device FROM identity WHERE singleton=1");
        if (identity && (identity.vault !== vaultId || identity.device !== deviceId)) throw new Error("conflicting local identity");
        if (!identity) run(this.db, "INSERT INTO identity VALUES(1,?,?)", vaultId, deviceId);
      });
      sidecars(filename);
      this.repairCache();
      this.tick = row<{ n: number }>(this.db, "SELECT coalesce(max(accessed),0) n FROM chunks")!.n;
    } catch (error) { this.db.close(); throw error; }
  }

  private migrate() {
    const version = row<{ user_version: number }>(this.db, "PRAGMA user_version")!.user_version;
    if (version > migrations.length || version < 0) throw new Error("unsupported local schema");
    const ledger = row<{ name: string }>(this.db, "SELECT name FROM sqlite_schema WHERE name='migrations'");
    if (!ledger && version !== 0) throw new Error("missing migration ledger");
    if (ledger) {
      const history = all<{ version: number; checksum: string }>(this.db, "SELECT * FROM migrations ORDER BY version");
      if (history.length !== version || history.some((r, i) => r.version !== i + 1 || r.checksum !== hash(`${i + 1}\0${migrations[i]}`))) throw new Error("migration checksum mismatch");
    } else if (row<{ n: number }>(this.db, "SELECT count(*) n FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'")!.n) throw new Error("unrecognized schema");
    for (let i = version; i < migrations.length; i++) {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        this.db.exec(migrations[i]!);
        run(this.db, "INSERT INTO migrations VALUES(?,?)", i + 1, hash(`${i + 1}\0${migrations[i]}`));
        this.db.exec(`PRAGMA user_version=${i + 1}`);
        this.db.exec("COMMIT");
      } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    }
  }
  private write<T>(fn: () => T): T {
    if (this.closed) throw new Error("closed local database");
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); if (result && typeof result === "object" && "then" in result) throw new Error("async transaction"); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
  close() { if (!this.closed) { this.db.close(); this.closed = true; } }
  pragmas() { return { synchronous: row<{ synchronous: number }>(this.db, "PRAGMA synchronous")!.synchronous, version: row<{ user_version: number }>(this.db, "PRAGMA user_version")!.user_version }; }

  head(kind: "observed" | "accepted" | "applied"): Head {
    const r = row<{ revision: string | null; sequence: number }>(this.db, "SELECT revision,sequence FROM heads WHERE kind=?", kind);
    return { revisionId: r?.revision ?? null, sequence: r?.sequence ?? 0 };
  }
  /** A lower sequence or a changed identity at the same sequence is never accepted. */
  recordHead(kind: "observed" | "accepted" | "applied", head: Head) {
    integer(head.sequence);
    if ((head.sequence === 0) !== (head.revisionId === null)) throw new Error("invalid head");
    if (head.revisionId) parseRevisionId(head.revisionId);
    this.write(() => {
      const previous = this.head(kind);
      const accepted = this.head("accepted"), applied = this.head("applied");
      if (head.sequence < previous.sequence || head.sequence === previous.sequence && head.revisionId !== previous.revisionId) throw new Error("head rollback or fork");
      if (kind === "observed" && (head.sequence < accepted.sequence || head.sequence === accepted.sequence && head.revisionId !== accepted.revisionId) || kind === "accepted" && (head.sequence < applied.sequence || head.sequence === applied.sequence && head.revisionId !== applied.revisionId) || kind === "applied" && (head.sequence > accepted.sequence || head.sequence === accepted.sequence && head.revisionId !== accepted.revisionId)) throw new Error("invalid applied/accepted ordering");
      if (head.sequence > previous.sequence) run(this.db, "INSERT INTO heads VALUES(?,?,?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence", kind, head.revisionId, head.sequence);
    });
  }
  private path(value: string) {
    if (value === "") return value;
    if (typeof value !== "string" || value !== value.normalize("NFC") || new TextEncoder().encode(value).length > 4096 || value.split("/").some(p => !p || p === "." || p === ".." || new TextEncoder().encode(p).length > 255 || /[\x00-\x1f\x7f-\x9f\\:*?"<>|]/.test(p) || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) throw new Error("invalid relative path");
    return value;
  }
  upsertEntry(entry: Entry) {
    uuid(entry.id); this.path(entry.path);
    if (entry.revision) uuid(entry.revision);
    if (entry.fingerprint !== null) hex(entry.fingerprint);
    if (!["file","directory","tombstone"].includes(entry.kind) || !["downloaded","evicted"].includes(entry.hydration)) throw new Error("invalid entry");
    this.write(() => run(this.db, `INSERT INTO entries VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,kind=excluded.kind,fingerprint=excluded.fingerprint,hydration=excluded.hydration,revision=excluded.revision`, entry.id, entry.path, entry.kind, entry.fingerprint, entry.hydration, entry.revision));
  }
  entry(id: string): Entry | null { uuid(id); return row<Entry>(this.db, "SELECT id,path,kind,fingerprint,hydration,revision FROM entries WHERE id=?", id); }
  entries(): Entry[] { return all<Entry>(this.db, "SELECT * FROM entries ORDER BY path"); }
  identities(): { entryId: string; device: string; inode: string }[] {
    return all<{ entryId: string; device: string; inode: string }>(this.db, "SELECT entry_id entryId,device,inode FROM file_identity");
  }
  pendingHydration(): HydrationIntent | null {
    const record = row<{ id: string; entry_id: string; revision: string; sequence: number; direction: "evict" | "download"; root_device: string; root_inode: string; file_device: string | null; file_inode: string | null }>(this.db, "SELECT * FROM hydration LIMIT 1");
    if (!record) return null;
    uuid(record.id); uuid(record.entry_id); uuid(record.revision); integer(record.sequence);
    if (!/^[0-9]+$/.test(record.root_device) || !/^[0-9]+$/.test(record.root_inode) ||
        record.file_device !== null && !/^[0-9]+$/.test(record.file_device) || record.file_inode !== null && !/^[0-9]+$/.test(record.file_inode)) throw new Error("corrupt hydration intent");
    return { id: record.id, entryId: record.entry_id, revision: record.revision, sequence: record.sequence, direction: record.direction,
      rootDevice: record.root_device, rootInode: record.root_inode, fileDevice: record.file_device, fileInode: record.file_inode };
  }
  beginHydration(intent: HydrationIntent) {
    uuid(intent.id); uuid(intent.entryId); uuid(intent.revision); integer(intent.sequence);
    if (!intent.sequence || !/^[0-9]+$/.test(intent.rootDevice) || !/^[0-9]+$/.test(intent.rootInode) ||
        intent.direction === "evict" && (!intent.fileDevice || !intent.fileInode || !/^[0-9]+$/.test(intent.fileDevice) || !/^[0-9]+$/.test(intent.fileInode)) ||
        intent.direction === "download" && (intent.fileDevice !== null || intent.fileInode !== null)) throw new Error("invalid hydration intent");
    this.write(() => {
      if (this.pendingHydration() || this.pendingApplies().length || this.proposal()) throw new Error("other local work must finish before hydration");
      if (this.head("applied").revisionId !== intent.revision || this.head("applied").sequence !== intent.sequence ||
          this.head("accepted").revisionId !== intent.revision || this.head("accepted").sequence !== intent.sequence) throw new Error("hydration head changed");
      const entry = this.entry(intent.entryId);
      if (!entry || entry.kind !== "file" || entry.revision !== intent.revision || entry.hydration !== (intent.direction === "evict" ? "downloaded" : "evicted")) throw new Error("hydration entry changed");
      if (intent.direction === "evict") {
        const identity = row<{ device: string; inode: string }>(this.db, "SELECT device,inode FROM file_identity WHERE entry_id=?", intent.entryId);
        if (!identity || identity.device !== intent.fileDevice || identity.inode !== intent.fileInode) throw new Error("hydration file identity changed");
      }
      run(this.db, "INSERT INTO hydration VALUES(?,?,?,?,?,?,?,?,?)", intent.id, intent.entryId, intent.revision, intent.sequence, intent.direction,
        intent.rootDevice, intent.rootInode, intent.fileDevice, intent.fileInode);
      run(this.db, "INSERT INTO operations VALUES(?,?,?,'running','{}')", intent.id, intent.direction, intent.entryId);
    });
  }
  finishHydration(intent: HydrationIntent, device?: string, inode?: string) {
    this.write(() => {
      const current = this.pendingHydration();
      if (!current || JSON.stringify(current) !== JSON.stringify(intent)) throw new Error("hydration intent changed");
      if (this.head("applied").revisionId !== intent.revision || this.head("applied").sequence !== intent.sequence ||
          this.head("accepted").revisionId !== intent.revision || this.head("accepted").sequence !== intent.sequence) throw new Error("hydration head changed");
      const entry = this.entry(intent.entryId);
      if (!entry || entry.kind !== "file" || entry.revision !== intent.revision ||
          entry.hydration !== (intent.direction === "evict" ? "downloaded" : "evicted")) throw new Error("hydration entry changed");
      if (intent.direction === "download") {
        if (!device || !inode || !/^[0-9]+$/.test(device) || !/^[0-9]+$/.test(inode)) throw new Error("invalid installed file identity");
        run(this.db, "INSERT INTO file_identity VALUES(?,?,?)", intent.entryId, device, inode);
        const entry = this.entry(intent.entryId)!;
        if (!entry.fingerprint) throw new Error("missing file fingerprint");
        run(this.db, "INSERT INTO suppression VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,operation_id=excluded.operation_id", entry.path, entry.fingerprint, intent.id);
      } else {
        run(this.db, "DELETE FROM file_identity WHERE entry_id=?", intent.entryId);
        run(this.db, "DELETE FROM suppression WHERE path=(SELECT path FROM entries WHERE id=?)", intent.entryId);
      }
      run(this.db, "UPDATE entries SET hydration=? WHERE id=?", intent.direction === "evict" ? "evicted" : "downloaded", intent.entryId);
      run(this.db, "UPDATE operations SET state='done' WHERE id=?", intent.id);
      run(this.db, "DELETE FROM hydration WHERE id=?", intent.id);
    });
  }
  /** Call only after a plan has been accepted/applied. Replaces identities atomically. */
  recordScan(entries: Entry[], identities: { entryId: string; device: string; inode: string }[]) {
    for (const entry of entries) { uuid(entry.id); this.path(entry.path); if (entry.fingerprint !== null) hex(entry.fingerprint); if (entry.revision) uuid(entry.revision); }
    for (const identity of identities) { uuid(identity.entryId); if (!/^\d+$/.test(identity.device) || !/^\d+$/.test(identity.inode)) throw new Error("invalid filesystem identity"); }
    this.write(() => {
      // Two-phase path replacement permits swaps without deleting referenced operation rows.
      for (const entry of entries) run(this.db, "UPDATE entries SET path=? WHERE id=?", `.scan-${entry.id}`, entry.id);
      run(this.db, "DELETE FROM file_identity");
      for (const old of all<{ id: string }>(this.db, "SELECT id FROM entries")) if (!entries.some(entry => entry.id === old.id)) {
        // Referenced work cannot lose its FK. Retire its path instead of allowing
        // an omitted descendant of a deleted directory to block future reuse.
        const referenced = row<{ id: string }>(this.db, "SELECT id FROM operations WHERE entry_id=? UNION SELECT id FROM conflicts WHERE entry_id=? LIMIT 1", old.id, old.id);
        if (referenced) run(this.db, "UPDATE entries SET path=?,kind='tombstone',fingerprint=NULL,hydration='downloaded' WHERE id=?", `.retired-${old.id}`, old.id);
        else run(this.db, "DELETE FROM entries WHERE id=?", old.id);
      }
      for (const entry of entries) run(this.db, `INSERT INTO entries VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,kind=excluded.kind,fingerprint=excluded.fingerprint,hydration=excluded.hydration,revision=excluded.revision`, entry.id, entry.path, entry.kind, entry.fingerprint, entry.hydration, entry.revision);
      for (const item of identities) run(this.db, "INSERT INTO file_identity VALUES(?,?,?)", item.entryId, item.device, item.inode);
    });
  }
  private work(table: "operations" | "transfers" | "conflicts", id: string, fields: (string | number | null)[]) {
    uuid(id);
    this.write(() => {
      const previous = row<Record<string, unknown>>(this.db, `SELECT * FROM ${table} WHERE id=?`, id);
      if (previous) { if (JSON.stringify(Object.values(previous).slice(1).filter((_, i) => i !== 2 && (table !== "transfers" || i !== 3))) !== JSON.stringify(fields.filter((_, i) => i !== 2 && (table !== "transfers" || i !== 3)))) throw new Error("work identity conflict"); return; }
      run(this.db, `INSERT INTO ${table} VALUES(${Array(fields.length + 1).fill("?").join(",")})`, id, ...fields);
    });
  }
  enqueueOperation(id: string, kind: "scan" | "evict" | "download" | "apply" | "publish" | "merge", entryId: string | null = null, detail = "{}") {
    // Arbitrary persisted JSON risks leaking credentials; add typed safe fields when needed.
    if (detail !== "{}") throw new Error("operation detail must not contain secrets");
    this.work("operations", id, [kind, entryId, "pending", detail]);
  }
  /** Durable, secret-free apply intent. Pending/running work is a recovery barrier. */
  prepareApply(id: string, revision: string, sequence: number, plan?: string) {
    uuid(id); uuid(revision); integer(sequence);
    if (plan !== undefined && (typeof plan !== "string" || Buffer.byteLength(plan) > 8_000_000 || !plan.length)) throw new Error("invalid apply plan");
    if (!sequence || this.head("accepted").revisionId !== revision || this.head("accepted").sequence !== sequence)
      throw new Error("apply requires accepted head");
    this.work("operations", id, ["apply", null, "pending", JSON.stringify({ revision, sequence, ...(plan === undefined ? {} : { plan }) })]);
  }
  applyPlan(id: string): string | null {
    uuid(id);
    const r = row<{ detail: string }>(this.db, "SELECT detail FROM operations WHERE id=? AND kind='apply'", id);
    if (!r) throw new Error("missing apply intent");
    const detail = JSON.parse(r.detail) as { plan?: string };
    return detail.plan ?? null;
  }
  pendingApplies(): { id: string; revision: string; sequence: number; state: string }[] {
    return this.listWork("operations").filter(r => r.kind === "apply" && r.state !== "done").map(r => {
      const detail = JSON.parse(r.detail as string) as { revision: string; sequence: number };
      uuid(detail.revision); integer(detail.sequence);
      return { id: r.id as string, revision: detail.revision, sequence: detail.sequence, state: r.state as string };
    });
  }
  /** Commit metadata and applied head together after the filesystem is durable. */
  finishApply(id: string, head: Head, entries: Entry[], identities: { entryId: string; device: string; inode: string }[]) {
    uuid(id);
    const accepted = this.head("accepted"), applied = this.head("applied");
    if (!head.revisionId || accepted.sequence < head.sequence ||
        accepted.sequence === head.sequence && accepted.revisionId !== head.revisionId || applied.sequence >= head.sequence)
      throw new Error("invalid accepted/applied head for intent");
    const intent = this.pendingApplies().find(p => p.id === id);
    if (!intent || intent.revision !== head.revisionId || intent.sequence !== head.sequence || intent.state !== "running") throw new Error("missing running apply intent");
    for (const e of entries) { uuid(e.id); this.path(e.path); if (e.fingerprint !== null) hex(e.fingerprint); }
    for (const item of identities) { uuid(item.entryId); if (!/^\d+$/.test(item.device) || !/^\d+$/.test(item.inode)) throw new Error("invalid inode"); }
    this.write(() => {
      for (const old of all<{ id: string; path: string }>(this.db, "SELECT id,path FROM entries"))
        if (!entries.some(e => e.id === old.id && e.path === old.path && e.kind === "file" && e.hydration === "downloaded"))
          run(this.db, "DELETE FROM suppression WHERE path=?", old.path);
      for (const e of entries) run(this.db, "UPDATE entries SET path=? WHERE id=?", `.apply-${e.id}`, e.id);
      run(this.db, "DELETE FROM file_identity");
      for (const old of all<{ id: string }>(this.db, "SELECT id FROM entries")) if (!entries.some(e => e.id === old.id)) {
        if (row<{ id: string }>(this.db, "SELECT id FROM operations WHERE entry_id=? UNION SELECT id FROM conflicts WHERE entry_id=? LIMIT 1", old.id, old.id))
          run(this.db, "UPDATE entries SET path=?,kind='tombstone',fingerprint=NULL,hydration='downloaded' WHERE id=?", `.retired-${old.id}`, old.id);
        else run(this.db, "DELETE FROM entries WHERE id=?", old.id);
      }
      for (const e of entries) run(this.db, "INSERT INTO entries VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,kind=excluded.kind,fingerprint=excluded.fingerprint,hydration=excluded.hydration,revision=excluded.revision", e.id, e.path, e.kind, e.fingerprint, e.hydration, e.revision);
      for (const item of identities) run(this.db, "INSERT INTO file_identity VALUES(?,?,?)", item.entryId, item.device, item.inode);
      for (const e of entries) if (e.kind === "file" && e.hydration === "downloaded")
        run(this.db, "INSERT INTO suppression VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,operation_id=excluded.operation_id", e.path, e.fingerprint, id);
      run(this.db, "INSERT INTO heads VALUES('applied',?,?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence", head.revisionId, head.sequence);
      run(this.db, "UPDATE operations SET state='done' WHERE id=?", id);
    });
  }
  enqueueTransfer(id: string, objectId: string, direction: "upload" | "download") { parseObjectId(objectId); this.work("transfers", id, [objectId, direction, "pending", 0]); }
  addConflict(id: string, entryId: string, sourceRevision: string) { uuid(sourceRevision); this.work("conflicts", id, [entryId, sourceRevision, "open"]); }
  /** The accepted manifest, not a device-local acknowledgement, determines open conflicts. */
  reconcileConflicts(manifest: ManifestV1) {
    if (this.head("applied").revisionId !== manifest.revisionId) throw new Error("conflict manifest not applied");
    this.write(() => {
      const live = new Map(manifest.entries.filter(e => e.kind !== "tombstone" && e.conflict).map(e => [e.id, e.conflict!]));
      for (const [id, lineage] of live) {
        const entry = this.entry(id);
        if (!entry || entry.kind === "tombstone") throw new Error("missing applied conflict entry");
        const existing = row<{ entry_id: string; source_revision: string; state: string }>(this.db, "SELECT entry_id,source_revision,state FROM conflicts WHERE id=?", id);
        if (existing && (existing.entry_id !== id || existing.source_revision !== lineage.sourceRevisionId))
          throw new Error("conflict lineage changed");
        // An explicit historical restore can legitimately bring a resolved
        // copy back into the live tree; the applied head remains authoritative.
        if (existing?.state === "resolved") run(this.db, "UPDATE conflicts SET state='open' WHERE id=?", id);
        if (!existing) run(this.db, "INSERT INTO conflicts VALUES(?,?,?,'open')", id, id, lineage.sourceRevisionId);
      }
      for (const old of all<{ id: string }>(this.db, "SELECT id FROM conflicts WHERE state='open'"))
        if (!live.has(old.id)) run(this.db, "UPDATE conflicts SET state='resolved' WHERE id=?", old.id);
    });
  }
  listWork(table: "operations" | "transfers" | "conflicts") { return all<Record<string, unknown>>(this.db, `SELECT * FROM ${table} ORDER BY id`); }
  transition(table: "operations" | "transfers" | "conflicts", id: string, state: Work["state"] | "resolved") {
    uuid(id);
    const allowed: Record<string, string[]> = table === "conflicts" ? { open: ["resolved"], resolved: [] } : { pending: ["running", "blocked"], running: ["pending", "done", "blocked"], blocked: ["pending"], done: [] };
    this.write(() => {
      const previous = row<{ state: string }>(this.db, `SELECT state FROM ${table} WHERE id=?`, id);
      if (!previous) throw new Error("missing work");
      if (previous.state === state) return;
      if (!allowed[previous.state]?.includes(state)) throw new Error("invalid work transition");
      run(this.db, `UPDATE ${table} SET state=?${table === "transfers" && state === "running" ? ",attempts=attempts+1" : ""} WHERE id=?`, state, id);
    });
  }
  suppress(path: string, fingerprint: string, operationId: string) {
    this.path(path); hex(fingerprint); uuid(operationId);
    this.write(() => run(this.db, "INSERT INTO suppression VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET fingerprint=excluded.fingerprint,operation_id=excluded.operation_id", path, fingerprint, operationId));
  }
  matchesSuppression(path: string, fingerprint: string): boolean {
    this.path(path); hex(fingerprint);
    return row<{ fingerprint: string }>(this.db, "SELECT fingerprint FROM suppression WHERE path=?", path)?.fingerprint === fingerprint;
  }
  consumeSuppression(path: string, fingerprint: string): boolean {
    this.path(path); hex(fingerprint);
    return this.write(() => { const r = row<{ fingerprint: string }>(this.db, "SELECT fingerprint FROM suppression WHERE path=?", path); if (!r || r.fingerprint !== fingerprint) return false; run(this.db, "DELETE FROM suppression WHERE path=?", path); return true; });
  }

  /** Freeze before the first network advance; manifest is the encrypted *frame*, not plaintext. */
  freezeProposal(request: AdvanceHeadRequest, encryptedManifestFrame: Uint8Array) {
    const parsed = parseAdvanceHeadRequest(request);
    if (parsed.vaultId !== this.vault || parsed.proposedRevision.creatingDeviceId !== row<{ device: string }>(this.db, "SELECT device FROM identity")?.device) throw new Error("proposal identity conflict");
    parseIdempotencyKey(parsed.idempotencyKey);
    const ref = parsed.proposedRevision.references.find(r => r.objectId === parsed.proposedRevision.encryptedManifestObjectId);
    if (!ref || !frameMatches(encryptedManifestFrame, ref, this.vault)) throw new Error("encrypted manifest mismatch");
    const requestJson = JSON.stringify(parsed), manifest = encryptedManifestFrame.slice();
    const digest = hash(requestJson + "\0" + hash(manifest));
    this.write(() => {
      const existing = row<{ digest: string }>(this.db, "SELECT digest FROM proposals WHERE id=1");
      if (existing) { if (existing.digest !== digest) throw new Error("proposal already frozen"); return; }
      run(this.db, "INSERT INTO proposals VALUES(1,?,?,?,?,'prepared',NULL)", parsed.proposedRevision.revisionId, requestJson, manifest, digest);
    });
  }
  /** Atomically mark a frozen proposal as a restore before the first advance. */
  freezeRestoreProposal(request: AdvanceHeadRequest, encryptedManifestFrame: Uint8Array, baseRevision: string) {
    uuid(baseRevision);
    if (request.expectedRevisionId !== baseRevision || this.head("applied").revisionId !== baseRevision ||
        this.pendingHydration()) throw new Error("restore base changed");
    // freezeProposal validates the wire bytes; the outer transaction below
    // persists the same authenticated request and its restore classification.
    const parsed = parseAdvanceHeadRequest(request);
    const ref = parsed.proposedRevision.references.find(r => r.objectId === parsed.proposedRevision.encryptedManifestObjectId);
    if (!ref || !frameMatches(encryptedManifestFrame, ref, this.vault) || parsed.proposedRevision.creatingDeviceId !== row<{ device: string }>(this.db, "SELECT device FROM identity")?.device)
      throw new Error("invalid restore proposal");
    const requestJson = JSON.stringify(parsed), frame = encryptedManifestFrame.slice(), digest = hash(requestJson + "\0" + hash(frame));
    this.write(() => {
      if (this.proposal() || this.restoreProposal()) throw new Error("proposal already frozen");
      run(this.db, "INSERT INTO proposals VALUES(1,?,?,?,?,'prepared',NULL)", parsed.proposedRevision.revisionId, requestJson, frame, digest);
      run(this.db, "INSERT INTO restores VALUES(1,?,?)", parsed.proposedRevision.revisionId, baseRevision);
    });
  }
  restoreProposal(): { revision: string; baseRevision: string } | null {
    const value = row<{ revision: string; base_revision: string }>(this.db, "SELECT revision,base_revision FROM restores WHERE singleton=1");
    if (!value) return null;
    uuid(value.revision); uuid(value.base_revision);
    if (this.proposal()?.request.proposedRevision.revisionId !== value.revision) throw new Error("restore proposal identity conflict");
    return { revision: value.revision, baseRevision: value.base_revision };
  }
  finishRestoreProposal() {
    this.write(() => {
      const restore = this.restoreProposal(), proposal = this.proposal();
      if (!restore || proposal?.state !== "accepted" || this.head("applied").revisionId !== restore.revision) throw new Error("restore not applied");
      run(this.db, "DELETE FROM restores"); run(this.db, "DELETE FROM proposals");
    });
  }
  discardStaleRestore() {
    this.write(() => {
      const restore = this.restoreProposal();
      if (!restore || this.proposal()?.state !== "prepared") throw new Error("restore not stale");
      run(this.db, "DELETE FROM restores"); run(this.db, "DELETE FROM proposals");
    });
  }
  proposal(): { request: AdvanceHeadRequest; encryptedManifestFrame: Uint8Array; state: "prepared" | "accepted"; acceptedSequence: number | null } | null {
    const r = row<{ request_json: string; manifest: Uint8Array; digest: string; state: "prepared" | "accepted"; accepted_sequence: number | null }>(this.db, "SELECT * FROM proposals WHERE id=1");
    if (!r) return null;
    const parsed = parseAdvanceHeadRequest(JSON.parse(r.request_json));
    if (JSON.stringify(parsed) !== r.request_json || hash(r.request_json + "\0" + hash(r.manifest)) !== r.digest || parsed.vaultId !== this.vault || !frameMatches(r.manifest, parsed.proposedRevision.references.find(ref => ref.objectId === parsed.proposedRevision.encryptedManifestObjectId)!, this.vault)) throw new Error("corrupt frozen proposal");
    return { request: parsed, encryptedManifestFrame: r.manifest.slice(), state: r.state, acceptedSequence: r.accepted_sequence };
  }
  acceptProposal(sequence: number) {
    integer(sequence); if (!sequence) throw new Error("invalid accepted sequence");
    const proposal = this.proposal(); if (!proposal) throw new Error("no proposal");
    this.write(() => {
      const prior = this.head("accepted");
      const revision = proposal.request.proposedRevision.revisionId;
      if (prior.sequence > sequence || prior.sequence === sequence && prior.revisionId !== revision || proposal.acceptedSequence !== null && proposal.acceptedSequence !== sequence) throw new Error("proposal acceptance conflict");
      if (prior.sequence < sequence) run(this.db, "INSERT INTO heads VALUES('accepted',?,?) ON CONFLICT(kind) DO UPDATE SET revision=excluded.revision,sequence=excluded.sequence", revision, sequence);
      run(this.db, "UPDATE proposals SET state='accepted',accepted_sequence=? WHERE id=1", sequence);
    });
  }
  clearProposal() { this.write(() => { const p = this.proposal(); if (p && p.state !== "accepted") throw new Error("unresolved proposal cannot be discarded"); run(this.db, "DELETE FROM proposals"); }); }
  /** Only a definitive stale-head response permits replacing a prepared request. */
  discardStaleProposal(revisionId: string) {
    uuid(revisionId);
    this.write(() => {
      const p = this.proposal();
      if (!p || p.state !== "prepared" || p.request.proposedRevision.revisionId !== revisionId) throw new Error("not a stale prepared proposal");
      run(this.db, "DELETE FROM proposals WHERE id=1");
    });
  }

  private chunkPath(id: string) { return join(this.cache, id); }
  private validateRef(vault: string, ref: VisibleObjectReference): number {
    if (parseVaultId(vault) !== this.vault || ref.objectType !== "chunk" || ref.objectFormatVersion !== 1 || ref.ciphertextLength < 97 || ref.ciphertextLength > CHUNK_SIZE + 96) throw new Error("invalid chunk identity");
    parseObjectId(ref.objectId); parseCiphertextChecksum(ref.ciphertextChecksum);
    return ref.ciphertextLength - 96;
  }
  async get(vault: string, ref: VisibleObjectReference): Promise<Uint8Array | null> {
    const length = this.validateRef(vault, ref);
    const r = row<{ checksum: string; ciphertext_length: number; plaintext_length: number }>(this.db, "SELECT * FROM chunks WHERE object_id=?", ref.objectId);
    if (!r) return null;
    if (r.checksum !== ref.ciphertextChecksum || r.ciphertext_length !== ref.ciphertextLength || r.plaintext_length !== length) throw new Error("cache reference conflict");
    const path = this.chunkPath(ref.objectId);
    try {
      secureFile(path);
      const fd = openSync(path, constants.O_RDONLY | noSymlink);
      try {
        const st = fstatSync(fd);
        if (!st.isFile() || st.nlink !== 1 || st.uid !== process.getuid!() || (st.mode & 0o177) !== 0) throw new Error("unsafe cached chunk");
        if (st.size !== length) throw new Error("partial cached chunk");
        const data = readFileSync(fd); if (data.length !== length) throw new Error("partial cached chunk");
        return new Uint8Array(data);
      }
      finally { closeSync(fd); }
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT" || error instanceof Error && error.message === "partial cached chunk") { this.write(() => run(this.db, "DELETE FROM chunks WHERE object_id=?", ref.objectId)); return null; }
      throw error;
    }
  }
  async put(vault: string, ref: VisibleObjectReference, plaintext: Uint8Array): Promise<void> {
    const length = this.validateRef(vault, ref);
    if (!(plaintext instanceof Uint8Array) || plaintext.length !== length) throw new Error("invalid chunk length");
    const existing = row<{ checksum: string; ciphertext_length: number }>(this.db, "SELECT * FROM chunks WHERE object_id=?", ref.objectId);
    if (existing && (existing.checksum !== ref.ciphertextChecksum || existing.ciphertext_length !== ref.ciphertextLength)) throw new Error("cache reference conflict");
    const target = this.chunkPath(ref.objectId), stage = join(this.cache, `.stage-${randomUUID()}`);
    if (existsSync(target)) secureFile(target);
    const fd = openSync(stage, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | noSymlink, 0o600);
    try { fchmodSync(fd, 0o600); const copy = plaintext.slice(); let offset = 0; while (offset < copy.length) { const written = writeSync(fd, copy, offset, copy.length - offset); if (!written) throw new Error("short cache write"); offset += written; } fsyncSync(fd); }
    finally { closeSync(fd); }
    try {
      renameSync(stage, target); syncDir(this.cache);
      this.write(() => run(this.db, "INSERT INTO chunks VALUES(?,?,?,?,?) ON CONFLICT(object_id) DO UPDATE SET accessed=excluded.accessed", ref.objectId, ref.ciphertextChecksum, ref.ciphertextLength, length, ++this.tick));
      this.trimCache();
    } finally { if (existsSync(stage)) unlinkSync(stage); }
  }
  private trimCache() {
    const chunks = all<{ object_id: string; plaintext_length: number }>(this.db, "SELECT object_id,plaintext_length FROM chunks ORDER BY accessed,object_id");
    let used = chunks.reduce((n, r) => n + r.plaintext_length, 0);
    for (const r of chunks) {
      if (used <= this.maxCacheBytes) break;
      const path = this.chunkPath(r.object_id); if (existsSync(path)) { secureFile(path); unlinkSync(path); syncDir(this.cache); }
      this.write(() => run(this.db, "DELETE FROM chunks WHERE object_id=?", r.object_id)); used -= r.plaintext_length;
    }
  }
  private repairCache() {
    for (const name of readdirSync(this.cache)) {
      const path = join(this.cache, name); secureFile(path);
      if (name.startsWith(".stage-")) { unlinkSync(path); continue; }
      if (!/^[0-9a-f]{64}$/.test(name)) throw new Error("unexpected cache file");
      const r = row<{ plaintext_length: number }>(this.db, "SELECT plaintext_length FROM chunks WHERE object_id=?", name);
      if (!r || lstatSync(path).size !== r.plaintext_length) { unlinkSync(path); if (r) this.write(() => run(this.db, "DELETE FROM chunks WHERE object_id=?", name)); }
    }
    for (const r of all<{ object_id: string }>(this.db, "SELECT object_id FROM chunks")) if (!existsSync(this.chunkPath(r.object_id))) this.write(() => run(this.db, "DELETE FROM chunks WHERE object_id=?", r.object_id));
    syncDir(this.cache); this.trimCache();
  }
}
function frameMatches(frame: Uint8Array, ref: VisibleObjectReference, vault: string) {
  if (!(frame instanceof Uint8Array) || ref.objectType !== "manifest" || frame.length !== ref.ciphertextLength || frame.length < 109 || frame.length > CHUNK_SIZE + 108 || hash(frame) !== ref.ciphertextChecksum) return false;
  const header = parseObjectFrameHeader(frame.subarray(0, 80));
  return header.vaultId === vault && header.objectType === "manifest" && header.objectId === ref.objectId && header.completeLength === frame.length;
}
