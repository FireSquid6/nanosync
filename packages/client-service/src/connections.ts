import { credentialBarrier, credentialMetadata, adoptLegacyCredentials, cleanupCredentialRecords, finishCredentialCleanup, assertRemovalCredentialCleanup, credentialStatus, withCredentialRegistry, withCredentialOperation, type CredentialOptions } from "./credentials.ts";
import { ClientLocal, StatusReadError } from '@nanosync/client-local';
import { LinuxScanner } from '@nanosync/linux-client';
import { ClientError } from './errors.ts';
import { acquireSyncLock } from "./sync-lock.ts";
import { randomUUID } from "node:crypto";
import { constants, closeSync, existsSync, lstatSync, openSync, realpathSync, readdirSync, renameSync, writeFileSync, fsyncSync, unlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parseDeviceId, parseVaultId } from "@nanosync/protocol";
import { privateDirectory, secureCreate, secureRead, secureReplace } from "./security.ts";

import { present } from './settings.ts';
import { assertNoRemoval, removalStatus, writeRemoval, finishRemoval, pathPresent, type RemovalIntent } from './removal-state.ts';
import { observeSyncLock } from './sync-lock.ts';

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
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("sync directory is missing; restore it or disconnect its saved binding with --force");
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
  const text = secureRead(file, 512).toString('utf8');
  let value: Marker;
  try { value = JSON.parse(text); }
  catch { throw new ClientError('FOLDER_UNAVAILABLE', 'Invalid root marker; restore its original contents.'); }
  if (value?.version !== 1 || Object.keys(value).length !== 2) throw new Error("invalid .nanosync marker; restore its original contents before disconnecting");
  return { version: 1, connectionId: id(value.connectionId) };
}
function record(global: string, connectionId: string): Connection {
  const text = secureRead(join(global, 'connections', `${id(connectionId)}.json`), 2048).toString('utf8');
  let value: Connection;
  try { value = JSON.parse(text); }
  catch { throw new ClientError('REMOVAL_INVALID', 'Invalid binding record; preserve private state and restore compatible metadata.'); }
  if (value?.version !== 1 || Object.keys(value).length !== 6 || value.connectionId !== connectionId ||
      typeof value.root !== "string" || resolve(value.root) !== value.root ||
      typeof value.serverId !== "string") throw new Error("invalid connection record; restore private connection state from backup");
  parseVaultId(value.vaultId); parseDeviceId(value.deviceId);
  return value;
}
export function records(global: string): Connection[] {
  credentialBarrier(global);
  const directory = join(privateDirectory(global), "connections");
  if (!existsSync(directory)) return removalStatus(global)?.bindings.map(item => item.connection) ?? [];
  privateDirectory(directory);
  const found = readdirSync(directory).map(name => {
    if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw new Error("unexpected connection state file");
    return record(global, name.slice(0, -5));
  });
  for (const item of removalStatus(global)?.bindings ?? []) {
    const existing = found.find(binding => binding.connectionId === item.connection.connectionId);
    if (existing && JSON.stringify(existing) !== JSON.stringify(item.connection)) throw new ClientError('REMOVAL_INVALID', 'Binding changed during removal.');
    if (!existing) found.push(item.connection);
  }
  return found;
}
function missingRoot(path: string): boolean {
  try { lstatSync(path); return false; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return true; throw error; }
}
function overlaps(a: string, b: string): boolean { return a === b || a.startsWith(b + sep) || b.startsWith(a + sep); }
function hasMarker(path: string, globalDirectory: string): boolean {
  const file = join(path, MARKER);
  // The default private-state directory shares the marker's name, not its role.
  return file !== resolve(globalDirectory) && existsSync(file);
}
function ancestorMarker(path: string, globalDirectory: string): boolean {
  let current = dirname(path);
  while (true) {
    if (hasMarker(current, globalDirectory)) return true;
    const parent = dirname(current);
    if (parent === current) return false;
    current = parent;
  }
}

/** The nearest marker wins. A copied marker is never allowed to share the source journal. */
export function discoverConnection(globalDirectory: string, from: string, allowMissingRoot = false): Connection {
  credentialBarrier(globalDirectory);
  if (allowMissingRoot && missingRoot(resolve(from))) {
    const saved = records(globalDirectory).find(connection => connection.root === resolve(from));
    if (!saved) throw new Error("no saved binding for the missing directory");
    return saved;
  }
  let current = rootPath(from);
  while (true) {
    if (hasMarker(current, globalDirectory)) {
      const found = marker(current);
      let connection: Connection;
      try { connection = record(globalDirectory, found.connectionId); }
      catch { throw new Error("missing or invalid global connection state; restore private connection state from backup"); }
      if (connection.root !== current) throw new Error("connection marker was copied or moved; restore its original location or disconnect the original binding before reconnecting");
      return connection;
    }
    const parent = dirname(current);
    if (parent === current) throw new Error("no .nanosync connection found; run nanosync client vaults connect");
    current = parent;
  }
}

export function checkedBindingRoot(global: string, bindingId: string): string {
  parseVaultId(bindingId);
  if (!present(global)) throw new ClientError('NOT_FOUND', 'Saved folder binding not found.');
  const binding = records(global).find(item => item.connectionId === bindingId);
  if (!binding) throw new ClientError('NOT_FOUND', 'Saved folder binding not found.');
  assertBindingRoot(global, binding);
  return binding.root;
}

const ROOT_IDENTITY = 'root-identity.json';
function saveRootIdentity(global: string, connection: Connection, replace = false): void {
  const replicas = privateDirectory(join(global, 'replicas'));
  const replica = privateDirectory(join(replicas, connection.connectionId));
  const stat = lstatSync(rootPath(connection.root), { bigint: true });
  const path = join(replica, ROOT_IDENTITY);
  const value = JSON.stringify({ version: 1, device: String(stat.dev), inode: String(stat.ino) });
  if (replace && present(path)) secureReplace(path, value); else secureCreate(path, value);
  // The identity file is not durable if any newly created ancestor entry can disappear.
  syncDirectory(replicas); syncDirectory(global); syncDirectory(dirname(global));
}
function savedRootIdentity(replica: string): { device: string; inode: string } | null {
  const path = join(replica, ROOT_IDENTITY);
  if (!present(path)) return null;
  try {
    privateDirectory(replica);
    const value = JSON.parse(secureRead(path, 512).toString('utf8'));
    if (!value || Object.keys(value).sort().join(',') !== 'device,inode,version' || value.version !== 1 ||
        typeof value.device !== 'string' || !/^\d+$/.test(value.device) ||
        typeof value.inode !== 'string' || !/^\d+$/.test(value.inode)) throw new Error('invalid root identity');
    return { device: value.device, inode: value.inode };
  } catch {
    throw new ClientError('FOLDER_UNAVAILABLE', 'Saved root identity is unsafe or invalid; inspect or restore private state before retrying.');
  }
}
/** Only an explicit validated start may establish identity for a never-scanned legacy binding. */
export function assertBindingRoot(global: string, connection: Connection, establish = false): void {
  try {
    if (discoverConnection(global, connection.root).connectionId !== connection.connectionId) throw new Error('binding marker changed');
    const replica = join(global, 'replicas', connection.connectionId), path = join(replica, ROOT_IDENTITY);
    const stat = lstatSync(connection.root, { bigint: true });
    const expected = savedRootIdentity(replica) ??
      ClientLocal.readStatus(replica, connection.vaultId, connection.deviceId)?.rootIdentity ?? null;
    if (expected && (expected.device !== String(stat.dev) || expected.inode !== String(stat.ino))) throw new Error('root identity changed');
    if (!present(path) && establish) saveRootIdentity(global, connection);
  } catch (error) {
    if (error instanceof StatusReadError) throw error;
    throw new ClientError('FOLDER_UNAVAILABLE', 'Folder unavailable or root identity changed; restore its original path and marker, then retry. Local state is preserved.', 2);
  }
}

/** Setup has no file transfer side effects. Existing files are deliberately left alone. */
export function createConnection(globalDirectory: string, destination: string, serverId: string, vaultId: string, deviceId: string,
  confirmNonempty = false): Connection {
  return withConnectionRegistry(globalDirectory, () => createLocked(globalDirectory, destination, serverId, vaultId, deviceId, confirmNonempty));
}

/** Client adapter: revalidate the selected server while mutation is serialized with removal. */
export function connectRegisteredVault(globalDirectory: string, destination: string, serverId: string, vaultId: string, deviceId: string, confirmNonempty = false, expectedRoot?: { dev: string; ino: string }): Connection {
  return withConnectionRegistry(globalDirectory, () => {
    const saved = credentialMetadata(globalDirectory, `servers/${parseVaultId(serverId)}.json`);
    if (saved.serverId !== serverId || saved.deviceId !== deviceId) throw new Error('server connection changed; select it again');
    if (expectedRoot) {
      const current = lstatSync(rootPath(destination), { bigint: true });
      if (String(current.dev) !== expectedRoot.dev || String(current.ino) !== expectedRoot.ino) throw new ClientError('SELECTION_CHANGED', 'Folder changed; select it again.');
    }
    return createLocked(globalDirectory, destination, serverId, vaultId, deviceId, confirmNonempty);
  });
}
export function inspectDestination(globalDirectory: string, destination: string): { path: string; nonempty: boolean } {
  return withConnectionRegistry(globalDirectory, () => checkedDestination(globalDirectory, destination));
}
function checkedDestination(globalDirectory: string, destination: string): { path: string; nonempty: boolean } {
  const global = privateDirectory(globalDirectory), root = rootPath(destination);
  if (overlaps(root, global)) throw new Error("sync destination overlaps private global state");
  if (ancestorMarker(root, global)) throw new Error("sync destination is nested under a marked sync root");
  if (records(global).some(item => overlaps(root, item.root))) throw new Error("sync roots may not overlap or already be bound");
  if (existsSync(join(root, MARKER))) throw new Error("destination already has a marker; use explicit move or copy repair");
  return { path: root, nonempty: readdirSync(root).length > 0 };
}
function createLocked(globalDirectory: string, destination: string, serverId: string, vaultId: string, deviceId: string, confirmNonempty: boolean): Connection {
  const global = privateDirectory(globalDirectory), selected = checkedDestination(global, destination), root = selected.path;
  if (selected.nonempty && !confirmNonempty) throw new Error("destination contains files; confirm that existing files participate in synchronization");
  if (!serverId || serverId.includes("\0")) throw new Error("invalid server registration");
  const connection: Connection = { version: 1, connectionId: randomUUID(), root, serverId, vaultId: parseVaultId(vaultId), deviceId: parseDeviceId(deviceId) };
  const directory = privateDirectory(join(global, "connections"));
  // Publish identity ancestry before the record, and the record before the marker.
  saveRootIdentity(global, connection);
  secureCreate(join(directory, `${connection.connectionId}.json`), JSON.stringify(connection));
  createFile(join(root, MARKER), JSON.stringify({ version: 1, connectionId: connection.connectionId }));
  return connection;
}

/** A scanned move preserves filesystem identity and journal; a copy gets an independent replica. */
export function repairConnection(globalDirectory: string, destination: string, mode: "move" | "copy", confirmNonempty = false): Connection {
  return withConnectionRegistry(globalDirectory, () => repairLocked(globalDirectory, destination, mode, confirmNonempty));
}
function repairLocked(
  globalDirectory: string,
  destination: string,
  mode: 'move' | 'copy',
  confirmNonempty: boolean,
): Connection {
  const global = privateDirectory(globalDirectory),
    root = rootPath(destination);
  if (
    overlaps(global, root) ||
    ancestorMarker(root, global) ||
    records(global).some((item) => overlaps(root, item.root))
  )
    throw new Error('sync destination overlaps an existing connection');
  const source = marker(root),
    old = record(global, source.connectionId);
  if (old.root === root) throw new Error('connection is already bound to this directory');
  if (mode === 'copy') {
    // A copy starts with an independent journal, and must not inherit an old
    // marker. The caller must explicitly acknowledge existing files.
    if (!confirmNonempty)
      throw new Error('copied files will participate in synchronization; confirmation required');
    const connection: Connection = { ...old, connectionId: randomUUID(), root };
    const path = join(global, 'connections', `${connection.connectionId}.json`);
    saveRootIdentity(global, connection);
    secureCreate(path, JSON.stringify(connection));
    replaceFile(
      join(root, MARKER),
      JSON.stringify({ version: 1, connectionId: connection.connectionId }),
    );
    return connection;
  }
  if (existsSync(old.root))
    throw new Error(
      'old root still exists; moving a connection requires its old root to be absent',
    );
  const replica = privateDirectory(
    join(privateDirectory(join(global, 'replicas')), old.connectionId),
  );
  const release = acquireSyncLock(replica);
  let local: ClientLocal | null = null;
  try {
    if (present(join(replica, 'local.sqlite')))
      local = new ClientLocal(replica, old.vaultId, old.deviceId);
    const facts = local?.statusFacts();
    const expected = facts?.rootIdentity ?? savedRootIdentity(replica);
    const stat = lstatSync(root, { bigint: true });
    const sameRoot = expected?.device === String(stat.dev) && expected.inode === String(stat.ino);
    const tracked = !!facts?.rootIdentity || !!local?.entries().length;
    const needsRecovery =
      !!facts &&
      (Object.values(facts.pending).some((count) => count !== 0) ||
        JSON.stringify(facts.heads.accepted) !== JSON.stringify(facts.heads.applied));
    if (!sameRoot && (tracked || needsRecovery)) {
      if (needsRecovery)
        throw new ClientError(
          'MOVE_RECOVERY_REQUIRED',
          'Pending recovery cannot be rebound to a copied root. Restore the original directory at its saved path and finish recovery, or inspect preserved state before explicitly abandoning that replica. Binding and journal are unchanged.',
        );
      throw new ClientError(
        'MOVE_REQUIRES_COPY',
        'A scanned move must preserve filesystem identity. Restore the original directory, or use explicit copy repair for an independent binding. The old journal is preserved.',
      );
    }
    const path = join(global, 'connections', `${old.connectionId}.json`);
    const updated = { ...old, root };
    saveRootIdentity(global, updated, true);
    replaceFile(path, JSON.stringify(updated));
    return updated;
  } finally {
    try {
      local?.close();
    } finally {
      release();
    }
  }
}

function replaceFile(path: string, text: string): void {
  // Do not follow a marker or record symlink. A temporary private file is
  // fsynced before atomic replacement of the checked regular file.
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.uid !== process.getuid!() ||
    before.mode & 0o177
  )
    throw new Error('unsafe connection state file');
  const temporary = `${path}.${randomUUID()}.stage`;
  createFile(temporary, text);
  const current = lstatSync(path);
  if (current.dev !== before.dev || current.ino !== before.ino)
    throw new Error('connection state changed during repair');
  renameSync(temporary, path);
  syncDirectory(dirname(path));
}

function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
function createFile(path: string, text: string): void {
  const fd = openSync(
    path,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  syncDirectory(dirname(path));
}

async function hasUnsyncedWork(replica: string, connection: Connection): Promise<boolean> {
  if (!existsSync(join(replica, 'local.sqlite')))
    return readdirSync(connection.root).some((name) => name !== MARKER);
  const local = new ClientLocal(replica, connection.vaultId, connection.deviceId);
  try {
    return (
      local.statusFacts().conflicts > 0 ||
      !!local.proposal() ||
      !!local.pendingHydration() ||
      !!local.restoreProposal() ||
      local.listWork('operations').some((work) => work.state !== 'done') ||
      local.listWork('transfers').some((work) => work.state !== 'done') ||
      JSON.stringify(local.head('accepted')) !== JSON.stringify(local.head('applied')) ||
      (await new LinuxScanner(connection.root, local).hasUnsyncedChanges())
    );
  } finally {
    local.close();
  }
}

/** Serialize binding mutation and server forgetting across CLI processes. Never bypassed by force. */
export function withConnectionRegistry<T>(globalDirectory: string, action: () => T): T {
  const directory = privateDirectory(join(privateDirectory(globalDirectory), 'registry-lock'));
  const release = acquireSyncLock(directory);
  try {
    credentialBarrier(globalDirectory);
    assertNoRemoval(globalDirectory);
    return action();
  } finally {
    release();
  }
}

export async function removeServerConnection(
  global: string,
  serverId: string,
  force = false,
  options: CredentialOptions = {},
): Promise<void> {
  parseDeviceId(serverId);
  await withCredentialOperation(global, () =>
    withCredentialRegistry(global, async () => {
      const pending = removalStatus(global);
      if (pending) {
        if (pending.kind !== 'server' || pending.serverId !== serverId || pending.force !== force)
          assertNoRemoval(global);
        return executeRemoval(global, pending, options);
      }
      const attached = records(global).filter((connection) => connection.serverId === serverId);
      if (attached.length && !force)
        throw new ClientError(
          'CONNECTION_IN_USE',
          'Vaults remain attached; disconnect them or explicitly use --force',
        );
      if (credentialStatus(global).cleanupPending)
        throw new ClientError(
          'CREDENTIAL_CLEANUP_PENDING',
          'Resume the original credential cleanup before starting another removal.',
        );
      if (!pathPresent(join(global, 'servers', `${serverId}.json`)))
        throw new ClientError('NOT_FOUND', 'Server connection not found.');
      const serverMetadata = credentialMetadata(global, `servers/${serverId}.json`);
      if (serverMetadata.serverId !== serverId)
        throw new ClientError('CONFLICT', 'Server identity changed.');
      adoptLegacyCredentials(global);
      const paths = [`servers/${serverId}.json`];
      for (const leaf of ['keys', 'pending']) {
        const directory = join(global, leaf);
        if (!pathPresent(directory)) continue;
        for (const name of readdirSync(privateDirectory(directory))) {
          const path = `${leaf}/${name}`,
            metadata = credentialMetadata(global, path);
          if (metadata.serverId === serverId) paths.push(path);
        }
      }
      return beginRemoval(global, attached, force, serverId, paths, options);
    }),
  );
}

export async function disconnectConnections(
  global: string,
  connections: Connection[],
  force = false,
  options: CredentialOptions = {},
): Promise<void> {
  await withCredentialRegistry(global, async () => {
    const pending = removalStatus(global);
    if (pending) {
      if (
        pending.kind !== 'disconnect' ||
        pending.force !== force ||
        JSON.stringify(pending.bindings.map((item) => item.connection.connectionId).sort()) !==
          JSON.stringify(connections.map((item) => item.connectionId).sort())
      )
        assertNoRemoval(global);
      return executeRemoval(global, pending, options);
    }
    return beginRemoval(global, connections, force, null, [], options);
  });
}
export async function resumeRemoval(
  global: string,
  requestId: string,
  confirmed: boolean,
  options: CredentialOptions = {},
) {
  if (!confirmed)
    throw new ClientError('CONFIRMATION_REQUIRED', 'Explicit removal confirmation is required.');
  parseVaultId(requestId);
  await withCredentialOperation(global, () =>
    withCredentialRegistry(global, async () => {
      const pending = removalStatus(global);
      if (!pending || pending.requestId !== requestId)
        throw new ClientError('NOT_FOUND', 'Removal request not found; refresh.');
      await executeRemoval(global, pending, options);
    }),
  );
}
function replicaPath(global: string, connection: Connection) {
  return privateDirectory(
    join(privateDirectory(join(global, 'replicas')), connection.connectionId),
  );
}
async function beginRemoval(
  global: string,
  connections: Connection[],
  force: boolean,
  serverId: string | null,
  paths: string[],
  options: CredentialOptions,
) {
  assertNoRemoval(global);
  const releases: (() => void)[] = [];
  const bindings: RemovalIntent['bindings'] = [];
  try {
    for (const connection of [...connections].sort((left, right) =>
      left.connectionId.localeCompare(right.connectionId),
    ))
      releases.push(acquireSyncLock(replicaPath(global, connection)));
    for (const connection of connections) {
      if (JSON.stringify(record(global, connection.connectionId)) !== JSON.stringify(connection))
        throw new ClientError('CONFLICT', 'Binding identity changed.');
      const absent = missingRoot(connection.root);
      if (!absent) assertBindingRoot(global, connection);
      else if (!force)
        throw new ClientError(
          'FOLDER_UNAVAILABLE',
          'Restore the saved root or explicitly disconnect with --force.',
        );
      if (!force && (await hasUnsyncedWork(replicaPath(global, connection), connection)))
        throw new ClientError(
          'UNSYNCED_WORK',
          'Possible unsynced work; use --force to explicitly discard pending synchronization state (files are preserved).',
        );
      if (!absent) assertBindingRoot(global, connection);
      const stat = absent ? null : lstatSync(rootPath(connection.root), { bigint: true });
      bindings.push({
        connection,
        rootWasMissing: absent,
        rootIdentity: stat
          ? { device: String(stat.dev), inode: String(stat.ino) }
          : savedRootIdentity(replicaPath(global, connection)),
      });
    }
    const intent: RemovalIntent = {
      version: 1,
      requestId: randomUUID(),
      kind: serverId ? 'server' : 'disconnect',
      serverId,
      force,
      phase: 'removing-bindings',
      bindings,
      credentialPaths: paths.sort(),
    };
    writeRemoval(global, intent, options.checkpoint);
    options.checkpoint?.('removal-intent');
    await removeOwned(global, intent, options);
  } finally {
    for (const release of releases.reverse()) release();
  }
}
async function executeRemoval(global: string, intent: RemovalIntent, options: CredentialOptions) {
  const releases: (() => void)[] = [];
  try {
    for (const item of [...intent.bindings].sort((left, right) =>
      left.connection.connectionId.localeCompare(right.connection.connectionId),
    ))
      releases.push(acquireSyncLock(replicaPath(global, item.connection)));
    await removeOwned(global, intent, options);
  } finally {
    for (const release of releases.reverse()) release();
  }
}
function validateRemovalRoot(item: RemovalIntent['bindings'][number]) {
  const connection = item.connection;
  if (missingRoot(connection.root)) return;
  const root = rootPath(connection.root),
    stat = lstatSync(root, { bigint: true });
  if (
    !item.rootIdentity ||
    String(stat.dev) !== item.rootIdentity.device ||
    String(stat.ino) !== item.rootIdentity.inode
  )
    throw new ClientError(
      'FOLDER_UNAVAILABLE',
      'Root changed during removal; preserve the original removal intent.',
    );
  if (pathPresent(join(root, MARKER)) && marker(root).connectionId !== connection.connectionId)
    throw new ClientError(
      'CONFLICT',
      'Foreign marker preserved; restore the original removal identity.',
    );
}
async function removeOwned(global: string, intent: RemovalIntent, options: CredentialOptions) {
  for (const path of intent.credentialPaths) {
    if (!pathPresent(join(global, path))) continue;
    if (
      intent.phase === 'credentials-complete' ||
      credentialMetadata(global, path).serverId !== intent.serverId
    )
      throw new ClientError(
        'REMOVAL_INVALID',
        'Credential inventory changed during removal; preserve it for inspection.',
      );
  }
  if (intent.credentialPaths.length)
    assertRemovalCredentialCleanup(global, intent.credentialPaths, intent.serverId);
  // Validate every surviving identity before changing any member of a multi-binding removal.
  for (const item of intent.bindings) {
    validateRemovalRoot(item);
    const path = join(global, 'connections', `${item.connection.connectionId}.json`);
    if (
      intent.phase !== 'removing-bindings' &&
      (pathPresent(path) ||
        (!missingRoot(item.connection.root) && pathPresent(join(item.connection.root, MARKER))))
    )
      throw new ClientError(
        'REMOVAL_INVALID',
        'Binding metadata reappeared after removal; preserve it for inspection.',
      );
    if (
      pathPresent(path) &&
      JSON.stringify(record(global, item.connection.connectionId)) !==
        JSON.stringify(item.connection)
    )
      throw new ClientError('CONFLICT', 'Binding changed during removal.');
  }
  // A visible journal may be a rename left by a failed directory fsync; prove durability again.
  if (JSON.stringify(removalStatus(global)) !== JSON.stringify(intent))
    throw new ClientError('REMOVAL_INVALID', 'Removal intent changed before replay.');
  secureRead(join(global, 'removal.json'), 1_000_000, true);
  if (intent.credentialPaths.length && pathPresent(join(global, 'credential-cleanup.json')))
    secureRead(join(global, 'credential-cleanup.json'), 1_000_000, true);
  if (intent.phase === 'removing-bindings') {
    for (const item of intent.bindings) {
      const connection = item.connection;
      validateRemovalRoot(item);
      if (!missingRoot(connection.root)) {
        if (pathPresent(join(connection.root, MARKER))) unlinkSync(join(connection.root, MARKER));
        syncDirectory(connection.root);
      }
      options.checkpoint?.('removal-marker');
      const recordPath = join(global, 'connections', `${connection.connectionId}.json`);
      if (pathPresent(recordPath)) unlinkSync(recordPath);
      if (pathPresent(dirname(recordPath))) syncDirectory(dirname(recordPath));
      options.checkpoint?.('removal-record');
      const replica = replicaPath(global, connection);
      for (const name of [
        'chunks',
        'local.sqlite',
        'local.sqlite-wal',
        'local.sqlite-shm',
        'local.sqlite-journal',
        ROOT_IDENTITY,
        'status.json',
        ...readdirSync(replica).filter((name) =>
          /^(?:root-identity|status)\.json\.[0-9a-f]{32}\.stage$/.test(name),
        ),
      ]) {
        const path = join(replica, name);
        if (pathPresent(path)) {
          const stat = lstatSync(path);
          if (
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid!() ||
            (name !== 'chunks' && (!stat.isFile() || stat.nlink !== 1 || stat.mode & 0o177))
          )
            throw new ClientError(
              'REMOVAL_INVALID',
              'Unsafe replica state preserved during removal.',
            );
          if (name === 'chunks') privateDirectory(path);
          rmSync(path, { recursive: name === 'chunks' });
          syncDirectory(replica);
        }
        options.checkpoint?.('removal-replica-file');
      }
      syncDirectory(replica);
    }
    intent.phase = 'cleaning-credentials';
    writeRemoval(global, intent);
    options.checkpoint?.('removal-bindings');
  }
  if (intent.phase === 'cleaning-credentials') {
    if (intent.credentialPaths.length)
      await cleanupCredentialRecords(global, intent.credentialPaths, options, true);
    intent.phase = 'credentials-complete';
    writeRemoval(global, intent);
    options.checkpoint?.('removal-credentials');
  }
  if (intent.credentialPaths.length) finishCredentialCleanup(global);
  options.checkpoint?.('removal-cleanup-finalized');
  finishRemoval(global);
  options.checkpoint?.('removal-complete');
}
export async function inspectRemoval(
  global: string,
  selection: { binding: string } | { serverId: string },
) {
  return withCredentialRegistry(global, async () => {
    const connections = records(global).filter((item) =>
      'binding' in selection
        ? item.connectionId === selection.binding
        : item.serverId === selection.serverId,
    );
    if ('binding' in selection && !connections.length)
      throw new ClientError('NOT_FOUND', 'Binding not found.');
    const releases: (() => void)[] = [];
    try {
      const owners = connections.map((connection) => ({
        connection,
        ownerPresent: !!observeSyncLock(replicaPath(global, connection))?.live,
      }));
      for (const item of [...owners].sort((left, right) =>
        left.connection.connectionId.localeCompare(right.connection.connectionId),
      ))
        if (!item.ownerPresent)
          releases.push(acquireSyncLock(replicaPath(global, item.connection)));
      const bindings = [];
      for (const item of owners) {
        let dirty: boolean | null = null,
          rootAvailable = false;
        try {
          assertBindingRoot(global, item.connection);
          rootAvailable = true;
          if (!item.ownerPresent)
            dirty = await hasUnsyncedWork(replicaPath(global, item.connection), item.connection);
        } catch (error) {
          if (rootAvailable) throw error;
        }
        bindings.push({ ...item, dirty, rootAvailable });
      }
      return { version: 1 as const, bindings };
    } finally {
      for (const release of releases.reverse()) release();
    }
  });
}
