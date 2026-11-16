import { acquireSyncLock } from "./sync-lock.ts";
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, openSync, realpathSync, readdirSync, renameSync, writeFileSync, fsyncSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseDeviceId, parseVaultId } from "@nanosync/protocol";
import { privateDirectory, secureCreate, secureRead } from "./security.ts";

const MARKER = ".nanosync";
type Marker = { version: 1; connectionId: string };
export interface Connection {
  version: 1;
  connectionId: string;
  root: string;
  serverId: string;
  vaultId: string;
  deviceId: string;
}

function rootPath(path: string): string {
  const root = resolve(path);
  let stat;
  try { stat = lstatSync(root); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("sync directory is missing; run nanosync setup to repair");
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid!() || realpathSync(root) !== root)
    throw new Error("sync destination must be an owned, real directory without symlinks");
  return root;
}
function id(value: unknown): string {
  if (typeof value !== "string" || value !== value.toLowerCase()) throw new Error("invalid connection ID");
  return parseVaultId(value);
}
function marker(path: string): Marker {
  const file = join(path, MARKER);
  const value = JSON.parse(secureRead(file, 512).toString("utf8")) as Marker;
  if (value?.version !== 1 || Object.keys(value).length !== 2) throw new Error("invalid .nanosync marker; run setup to repair");
  return { version: 1, connectionId: id(value.connectionId) };
}
function record(global: string, connectionId: string): Connection {
  const value = JSON.parse(secureRead(join(global, "connections", `${id(connectionId)}.json`), 2048).toString("utf8")) as Connection;
  if (value?.version !== 1 || Object.keys(value).length !== 6 || value.connectionId !== connectionId ||
      typeof value.root !== "string" || resolve(value.root) !== value.root ||
      typeof value.serverId !== "string") throw new Error("invalid connection record; run setup to repair");
  parseVaultId(value.vaultId); parseDeviceId(value.deviceId);
  return value;
}
export function records(global: string): Connection[] {
  const directory = join(privateDirectory(global), "connections");
  if (!existsSync(directory)) return [];
  privateDirectory(directory);
  return readdirSync(directory).map(name => {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("unexpected connection state file");
    return record(global, name.slice(0, -5));
  });
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); }
function ancestorMarker(path: string): boolean {
  let current = dirname(path);
  while (true) {
    if (existsSync(join(current, MARKER))) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The nearest marker wins. A copied marker is never allowed to share the source journal. */
export function discoverConnection(globalDirectory: string, from: string): Connection {
  let current = rootPath(from);
  while (true) {
    if (existsSync(join(current, MARKER))) {
      const found = marker(current);
      let connection: Connection;
      try { connection = record(globalDirectory, found.connectionId); }
      catch { throw new Error("missing or invalid global connection state; run nanosync setup to repair"); }
      if (connection.root !== current) throw new Error("connection marker was copied or moved; run nanosync setup to repair");
      return connection;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("no .nanosync connection found; run nanosync setup");
    current = parent;
  }
}

/** Setup has no file transfer side effects. Existing files are deliberately left alone. */
export function createConnection(globalDirectory: string, destination: string, serverId: string, vaultId: string, deviceId: string,
  confirmNonempty = false): Connection {
  const global = privateDirectory(globalDirectory), root = rootPath(destination);
  if (overlaps(root, global)) throw new Error("sync destination overlaps private global state");
  if (ancestorMarker(root)) throw new Error("sync destination is nested under a marked sync root");
  if (records(global).some(item => overlaps(root, item.root))) throw new Error("sync roots may not overlap or already be bound");
  if (existsSync(join(root, MARKER))) throw new Error("destination already has a marker; use explicit move or copy repair");
  if (readdirSync(root).length && !confirmNonempty) throw new Error("destination contains files; confirm that existing files participate in synchronization");
  if (!serverId || serverId.includes("\0")) throw new Error("invalid server registration");
  const connection: Connection = { version: 1, connectionId: randomUUID(), root, serverId, vaultId: parseVaultId(vaultId), deviceId: parseDeviceId(deviceId) };
  const directory = privateDirectory(join(global, "connections"));
  // The record is published first: a crash can leave an orphan, but cannot
  // leave a marker that points to a missing journal. Orphans require repair.
  secureCreate(join(directory, `${connection.connectionId}.json`), JSON.stringify(connection));
  createFile(join(root, MARKER), JSON.stringify({ version: 1, connectionId: connection.connectionId }));
  return connection;
}

/** A move retains the journal; a copy always gets a distinct identity and journal. */
export function repairConnection(globalDirectory: string, destination: string, mode: "move" | "copy", confirmNonempty = false): Connection {
  const global = privateDirectory(globalDirectory), root = rootPath(destination);
  if (overlaps(global, root) || ancestorMarker(root) || records(global).some(item => overlaps(root, item.root)))
    throw new Error("sync destination overlaps an existing connection");
  const source = marker(root), old = record(global, source.connectionId);
  if (old.root === root) throw new Error("connection is already bound to this directory");
  if (mode === "copy") {
    // A copy starts with an independent journal, and must not inherit an old
    // marker. The caller must explicitly acknowledge existing files.
    if (!confirmNonempty) throw new Error("copied files will participate in synchronization; confirmation required");
    const connection: Connection = { ...old, connectionId: randomUUID(), root };
    const path = join(global, "connections", `${connection.connectionId}.json`);
    secureCreate(path, JSON.stringify(connection));
    replaceFile(join(root, MARKER), JSON.stringify({ version: 1, connectionId: connection.connectionId }));
    return connection;
  }
  if (existsSync(old.root)) throw new Error("old root still exists; moving a connection requires its old root to be absent");
  const path = join(global, "connections", `${old.connectionId}.json`);
  const updated = { ...old, root };
  replaceFile(path, JSON.stringify(updated));
  return updated;
}

function replaceFile(path: string, text: string): void {
  // Do not follow a marker or record symlink. A temporary private file is
  // fsynced before atomic replacement of the checked regular file.
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1 || before.uid !== process.getuid!() || before.mode & 0o177)
    throw new Error("unsafe connection state file");
  const temporary = `${path}.${randomUUID()}.stage`;
  createFile(temporary, text);
  const current = lstatSync(path);
  if (current.dev !== before.dev || current.ino !== before.ino) throw new Error("connection state changed during repair");
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function createFile(path: string, text: string): void {
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  try { writeFileSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
  syncDirectory(dirname(path));
}

/** Conservative until a full filesystem/journal dirty check: any replica state or files needs force. */
export function disconnectConnections(globalDirectory: string, connections: Connection[], force = false): void {
  const global = privateDirectory(globalDirectory);
  const releases: (() => void)[] = [];
  const replicaPaths: string[] = [];
  try {
    for (const connection of connections) {
      if (discoverConnection(global, connection.root).connectionId !== connection.connectionId) throw new Error("binding identity changed");
      const replica = privateDirectory(join(privateDirectory(join(global, "replicas")), connection.connectionId));
      releases.push(acquireSyncLock(replica));
      replicaPaths.push(replica);
      if (!force && (readdirSync(connection.root).some(name => name !== MARKER) || existsSync(join(replica, "local.sqlite"))))
        throw new Error("possible unsynced work; use --force to explicitly discard pending synchronization state (files are preserved)");
    }
    for (const connection of connections) {
      unlinkSync(join(connection.root, MARKER)); syncDirectory(connection.root);
      unlinkSync(join(global, "connections", `${connection.connectionId}.json`));
    }
    if (connections.length) syncDirectory(join(global, "connections"));
    // Discard known journal/cache files while ownership is still held. Never
    // recursively remove the lock directory after release: a new owner may
    // already have acquired it. Empty private replica directories may remain.
    for (const replica of replicaPaths) {
      for (const name of ["chunks", "local.sqlite", "local.sqlite-wal", "local.sqlite-shm", "local.sqlite-journal"]) {
        const path = join(replica, name);
        if (existsSync(path)) rmSync(path, {recursive:true});
      }
      syncDirectory(replica);
    }
  } finally { for (const release of releases.reverse()) release(); }
}
