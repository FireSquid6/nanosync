import { SETTINGS, SETTINGS_LOCK, readSettings, validateSettingsStage, settingsStage } from './settings.ts';
import { isDeepStrictEqual } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { baseUrl } from './client.ts';
import { existsSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseAuthToken, parseDeviceId, decodeCanonicalBase64Url } from '@nanosync/protocol';
import { ClientError } from './errors.ts';
import { acquireSyncLock } from './sync-lock.ts';
import {
  privateDirectory,
  secureCreate,
  secureRead,
  secureReplace,
  syncPrivateDirectory,
} from './security.ts';

import { assertNoRemoval, removalStatus, pathPresent, REMOVAL, removalStage, validateRemovalStage } from './removal-state.ts';

export type CredentialMode = 'protected-file' | 'os-store';
interface Descriptor {
  version: 1;
  rootId: string;
  generation: string;
  mode: CredentialMode;
}
interface Reference {
  generation: string;
  itemId: string;
}
type RecordValue = Record<string, unknown>;
export interface CredentialStore {
  get(options: { service: string; name: string }): Promise<string | null>;
  set(options: { service: string; name: string; value: string }): Promise<void>;
  delete(options: { service: string; name: string }): Promise<boolean>;
}
export interface CredentialOptions {
  store?: CredentialStore;
  retryCredentialWrite?: boolean;
  checkpoint?: (name: string) => void;
}
const MODE = 'credentials.json';
const MIGRATION = 'credential-migration.json';
const CLEANUP = 'credential-cleanup.json';
const cleanupStage = /^credential-cleanup\.json\.[0-9a-f]{32}\.stage$/;
const leaves = ['servers', 'pending', 'keys'] as const;
const uuid = (value: unknown) =>
  typeof value === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
function stateInvalid(message: string): never {
  throw new ClientError('CREDENTIAL_STATE_INVALID', message);
}
function read(path: string): any {
  try {
    const value = JSON.parse(secureRead(path, 1_000_000).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) stateInvalid('not an object');
    return value;
  } catch {
    stateInvalid(
      'Cannot read protected credential state; restore compatible state without resetting this root',
    );
  }
}
function put(path: string, value: unknown) {
  const text = JSON.stringify(value);
  if (existsSync(path)) secureReplace(path, text);
  else secureCreate(path, text);
}
function remove(path: string) {
  if (pathPresent(path)) {
    secureRead(path, 1_000_000);
    unlinkSync(path);
  }
  const parent = resolve(path, '..');
  if (pathPresent(parent)) syncPrivateDirectory(parent);
}
function exact(value: object, allowed: string[]) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((name) => !allowed.includes(name))
  )
    stateInvalid('Unexpected credential metadata fields; inspect state without resetting it');
}
function descriptor(root: string): Descriptor | undefined {
  const path = join(root, MODE);
  if (!existsSync(path)) return undefined;
  const value = read(path) as Descriptor;
  exact(value, ['version', 'rootId', 'generation', 'mode']);
  if (
    value.version !== 1 ||
    !uuid(value.rootId) ||
    !uuid(value.generation) ||
    !['protected-file', 'os-store'].includes(value.mode)
  )
    stateInvalid('Invalid credential descriptor; restore compatible state, do not reset this root');
  return value;
}
function files(root: string): string[] {
  return leaves
    .flatMap((leaf) => {
      const directory = join(root, leaf);
      if (!existsSync(directory)) return [];
      privateDirectory(directory);
      return readdirSync(directory).map((name) => {
        const pattern =
          leaf === 'pending'
            ? /^[0-9a-f]{64}\.json$/
            : leaf === 'keys'
              ? /^[0-9a-f-]{36}-[0-9a-f-]{36}\.json$/
              : /^[0-9a-f-]{36}\.json$/;
        if (!pattern.test(name))
          stateInvalid('Unexpected credential file; inspect interrupted state');
        return `${leaf}/${name}`;
      });
    })
    .sort();
}
function field(path: string): 'token' | 'masterKey' {
  return path.startsWith('keys/') ? 'masterKey' : 'token';
}
function validateSecret(path: string, value: unknown): asserts value is string {
  if (field(path) === 'masterKey') {
    if (typeof value !== 'string' || !/^[0-9a-f]{64}$/.test(value))
      stateInvalid('Stored vault key is invalid');
  } else {
    try {
      parseAuthToken(value);
    } catch {
      stateInvalid('Stored credential is invalid');
    }
  }
}
function validateRecord(path: string, value: RecordValue) {
  try {
    validateRecordValue(path, value);
  } catch {
    stateInvalid('Invalid credential metadata; restore compatible state without resetting it');
  }
}
function validateRecordValue(path: string, value: RecordValue) {
  const common = ['version', 'serverId', 'credential', 'credentialWrite'];
  const allowed = path.startsWith('keys/')
    ? ['vaultId', 'masterKey']
    : path.startsWith('pending/')
      ? ['url', 'token', 'deviceId', 'name', 'alias', 'fingerprint', 'expiresAtMs', 'status']
      : ['baseUrl', 'deviceId', 'name', 'token'];
  exact(value, [...common, ...allowed]);
  if (value.credentialWrite !== undefined && value.credentialWrite !== 'pending')
    stateInvalid('invalid credential write phase');
  if (
    value.version !== 1 &&
    value.version !== 2 &&
    !(path.startsWith('pending/') && value.version === undefined)
  )
    stateInvalid('unsupported credential record');
  if ((value.credential !== undefined) !== (value.version === 2)) {
    stateInvalid('Credential schema and reference differ');
  }
  if (value.credentialWrite !== undefined && value.credential === undefined) {
    stateInvalid('Credential write phase has no reference');
  }
  parseDeviceId(value.serverId);
  if (path.startsWith('keys/')) {
    parseDeviceId(value.vaultId);
    if (path !== `keys/${value.serverId}-${value.vaultId}.json`)
      stateInvalid('vault key identity differs');
  } else {
    parseDeviceId(value.deviceId);
    if (path.startsWith('servers/') && path !== `servers/${value.serverId}.json`)
      stateInvalid('server identity differs');
    const url = value.baseUrl ?? value.url;
    if (
      typeof url !== 'string' ||
      baseUrl(url) !== url ||
      typeof value.name !== 'string' ||
      !value.name
    )
      stateInvalid('invalid credential metadata');
    if (path.startsWith('pending/')) {
      if (typeof value.fingerprint !== 'string') stateInvalid('invalid fingerprint');
      decodeCanonicalBase64Url(value.fingerprint, 32);
      if (
        typeof value.alias !== 'string' ||
        !value.alias ||
        !Number.isSafeInteger(value.expiresAtMs) ||
        (value.status !== undefined &&
          !['pending', 'denied', 'expired'].includes(String(value.status)))
      )
        stateInvalid('invalid pending metadata');
      if (path !== `pending/${createHash('sha256').update(url).digest('hex')}.json`)
        stateInvalid('pending URL differs');
    }
  }
}
export function credentialStatus(directory: string) {
  const root = resolve(directory);
  if (existsSync(root)) {
    privateDirectory(root);
    for (const name of readdirSync(root).filter(name => removalStage.test(name))) validateRemovalStage(join(root, name));
    for (const name of readdirSync(root).filter(name => cleanupStage.test(name))) validateSettingsStage(join(root, name));
  }
  removalStatus(root);
  const saved = descriptor(root);
  const migration = existsSync(join(root, MIGRATION));
  const cleanupPending = existsSync(join(root, CLEANUP));
  if (saved) return { ...saved, migrationPending: migration, cleanupPending };
  if (migration || cleanupPending)
    stateInvalid('Incomplete credential upgrade; restore its descriptor');
  const inventory = files(root);
  for (const path of inventory) {
    const value = read(join(root, path));
    if (value.credential || (value.version && value.version !== 1))
      stateInvalid('Partial credential upgrade; do not initialize as empty');
    validateRecord(path, value);
    validateSecret(path, value[field(path)]);
  }
  let existingLayout = false;
  if (existsSync(root)) {
    privateDirectory(root);
    const allowed = [
      'servers',
      'pending',
      'keys',
      'connections',
      'replicas',
      'registry-lock',
      'credential-operation',
      SETTINGS, SETTINGS_LOCK, REMOVAL,
    ];
    for (const name of readdirSync(root).filter(name => settingsStage.test(name))) validateSettingsStage(join(root, name));
    if (readdirSync(root).some((name) => !allowed.includes(name) && !settingsStage.test(name) && !removalStage.test(name) && !cleanupStage.test(name)))
      stateInvalid('Unrecognized or incomplete client state; do not initialize as empty');
    readSettings(root);
    if (existsSync(join(root, SETTINGS_LOCK))) privateDirectory(join(root, SETTINGS_LOCK));
    for (const leaf of ['connections', 'replicas']) {
      const directory = join(root, leaf);
      if (!existsSync(directory)) continue;
      privateDirectory(directory);
      for (const name of readdirSync(directory)) {
        const identity = leaf === 'connections' ? name.replace(/\.json$/, '') : name;
        if (!uuid(identity) || (leaf === 'connections' && name !== `${identity}.json`)) {
          stateInvalid('Unrecognized existing client layout');
        }
        if (leaf === 'replicas') privateDirectory(join(directory, name));
        else {
          const binding = read(join(directory, name));
          exact(binding, ['version', 'connectionId', 'serverId', 'vaultId', 'deviceId', 'root']);
          if (
            binding.version !== 1 ||
            binding.connectionId !== identity ||
            !uuid(binding.serverId) ||
            !uuid(binding.vaultId) ||
            !uuid(binding.deviceId) ||
            typeof binding.root !== 'string' ||
            resolve(binding.root) !== binding.root
          ) {
            stateInvalid('Invalid existing binding identity');
          }
        }
        existingLayout = true;
      }
    }
  }
  if (inventory.length || existingLayout) {
    return {
      mode: 'protected-file' as const,
      legacy: true,
      migrationPending: false,
      cleanupPending: false,
    };
  }
  return { mode: 'uninitialized' as const, migrationPending: false, cleanupPending: false };
}
export function credentialBarrier(root: string) {
  if (existsSync(join(root, MIGRATION)))
    throw new ClientError(
      'CREDENTIAL_MIGRATION_PENDING',
      'Credential migration pending; use client credentials resume or rollback',
    );
}
function registry<T>(root: string, action: () => T): T {
  privateDirectory(root);
  const lock = privateDirectory(join(root, 'registry-lock'));
  const release = acquireSyncLock(lock);
  try {
    return action();
  } finally {
    release();
  }
}
const registryContext = new AsyncLocalStorage<{ root: string; active: boolean }>();
const registryQueue = new Map<string, Promise<void>>();
export async function withCredentialRegistry<T>(
  root: string,
  action: () => Promise<T>,
): Promise<T> {
  root = resolve(root);
  const current = registryContext.getStore();
  if (current?.root === root && current.active) {
    credentialBarrier(root);
    return action();
  }
  const previous = registryQueue.get(root);
  const next = Promise.withResolvers<void>();
  registryQueue.set(root, next.promise);
  await previous;
  let release: (() => void) | undefined;
  const context = { root, active: true };
  try {
    privateDirectory(root);
    release = acquireSyncLock(privateDirectory(join(root, 'registry-lock')));
    credentialBarrier(root);
    return await registryContext.run(context, action);
  } finally {
    context.active = false;
    try {
      release?.();
    } finally {
      next.resolve();
      if (registryQueue.get(root) === next.promise) registryQueue.delete(root);
    }
  }
}
export async function withCredentialOperation<T>(root: string, action: () => Promise<T>) {
  const release = await withCredentialRegistry(root, async () =>
    acquireSyncLock(privateDirectory(join(root, 'credential-operation'))),
  );
  try {
    return await action();
  } finally {
    release();
  }
}
function installDescriptor(root: string, mode: CredentialMode): Descriptor {
  const value: Descriptor = { version: 1, rootId: randomUUID(), generation: randomUUID(), mode };
  secureCreate(join(root, MODE), JSON.stringify(value));
  return value;
}
// The caller holds the registry gate and has authorized the legacy mutation.
export function adoptLegacyCredentials(root: string): void {
  if (descriptor(root)) return;
  if (credentialStatus(root).mode !== 'protected-file')
    stateInvalid('No recognized legacy credential mode to adopt');
  installDescriptor(root, 'protected-file');
}
export function initializeCredentials(root: string, mode?: CredentialMode): Descriptor {
  return registry(root, () => {
    credentialBarrier(root); assertNoRemoval(root);
    const status = credentialStatus(root);
    if (mode !== undefined && !['protected-file', 'os-store'].includes(mode))
      throw new ClientError('INVALID_INPUT', 'Invalid credential mode');
    if (status.mode !== 'uninitialized' && mode && mode !== status.mode)
      throw new ClientError(
        'CREDENTIAL_MODE_CONFLICT',
        'Use explicit credential migration to change this root',
      );
    if (status.mode === 'uninitialized' && !mode)
      throw new ClientError(
        'INPUT_REQUIRED',
        'Select --credential-mode protected-file or os-store for a new client root',
      );
    const saved = descriptor(root);
    if (saved) return saved;
    return installDescriptor(root, mode ?? 'protected-file');
  });
}
export function desktopCredentials(root: string) {
  const status = credentialStatus(root);
  return { ...status, decisionRequired: status.mode === 'protected-file' };
}
/** Renderer-safe decision state; never expose descriptor references or migration inventory. */
export function credentialDecision(root: string) {
  const status = credentialStatus(root);
  const phase = status.migrationPending ? migration(root).phase : null;
  return {
    mode: status.mode, decisionRequired: status.mode === 'protected-file',
    migrationPending: status.migrationPending, cleanupPending: status.cleanupPending,
    phase, canRollback: phase !== null && phase !== 'cleanup',
  };
}
function unavailable(): ClientError {
  return new ClientError(
    'CREDENTIALS_UNAVAILABLE',
    'Cannot access the OS credential. Unlock your credential store, ensure Secret Service is running in this login session, then retry. Local state is preserved.',
  );
}
function storeFor(options: CredentialOptions): CredentialStore {
  return options.store ?? Bun.secrets;
}
function address(saved: Descriptor, ref: Reference) {
  exact(ref, ['generation', 'itemId']);
  if (
    !uuid(ref?.generation) ||
    typeof ref.itemId !== 'string' ||
    !/^[0-9a-f-]{36,73}$/.test(ref.itemId)
  )
    stateInvalid('Invalid credential reference');
  return {
    service: 'org.nanosync.credentials',
    name: `${saved.rootId}/${ref.generation}/${ref.itemId}`,
  };
}
function recordReference(path: string, value: RecordValue, saved: Descriptor): Reference {
  const ref = value.credential as Reference;
  address(saved, ref);
  const itemId = path.startsWith('keys/')
    ? `${value.serverId}-${value.vaultId}`
    : String(value.serverId);
  if (ref.generation !== saved.generation || ref.itemId !== itemId)
    stateInvalid('credential reference identity differs');
  return ref;
}
async function native<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch {
    throw unavailable();
  }
}
async function required(saved: Descriptor, ref: Reference, options: CredentialOptions) {
  const value = await native(() => storeFor(options).get(address(saved, ref)));
  if (value === null) throw unavailable();
  return value;
}
export function credentialMetadata(root: string, path: string): RecordValue {
  credentialBarrier(root);
  const value = read(join(root, path));
  validateRecord(path, value);
  const saved = descriptor(root);
  if (value.credential) {
    if (!saved || saved.mode !== 'os-store' || value.credential.generation !== saved.generation)
      stateInvalid('Incomplete credential upgrade; resume recovery');
    recordReference(path, value, saved);
    if (field(path) in value) stateInvalid('mixed credential providers');
  } else {
    if (saved?.mode === 'os-store') stateInvalid('OS credential reference missing');
    validateSecret(path, value[field(path)]);
  }
  const { [field(path)]: secret, ...metadata } = value;
  return metadata;
}
export async function readCredentialRecord<T>(
  root: string,
  path: string,
  options: CredentialOptions = {},
): Promise<T> {
  return withCredentialRegistry(root, async () => {
    assertNoRemoval(root);
    if (existsSync(join(root, CLEANUP)))
      throw new ClientError(
        'CREDENTIAL_CLEANUP_PENDING',
        'Credential cleanup pending; repeat the confirmed removal or fresh enrollment',
      );
    const value = await readRecord<RecordValue>(root, path, descriptor(root), options);
    if (value.credentialWrite === 'pending') {
      const { [field(path)]: secret, credentialWrite: phase, ...ready } = value;
      put(join(root, path), ready);
      delete value.credentialWrite;
    }
    return value as T;
  });
}
async function readRecord<T>(
  root: string,
  path: string,
  saved: Descriptor | undefined,
  options: CredentialOptions,
): Promise<T> {
  const value = read(join(root, path));
  validateRecord(path, value);
  if (value.credential) {
    if (field(path) in value) stateInvalid('mixed credential providers');
    if (!saved || saved.mode !== 'os-store' || value.credential.generation !== saved.generation)
      stateInvalid('Credential generation differs; resume the interrupted upgrade');
    value[field(path)] = await required(saved, recordReference(path, value, saved), options);
  } else if (saved?.mode === 'os-store')
    stateInvalid('OS-store metadata contains an unexpected file credential');
  validateSecret(path, value[field(path)]);
  return value as T;
}
export async function writeCredentialRecord(
  root: string,
  path: string,
  value: RecordValue,
  options: CredentialOptions = {},
) {
  credentialBarrier(root); assertNoRemoval(root);
  adoptLegacyCredentials(root);
  const saved = descriptor(root);
  if (existsSync(join(root, CLEANUP)))
    throw new ClientError(
      'CREDENTIAL_CLEANUP_PENDING',
      'Credential cleanup pending; resume the authorized cleanup before writing credentials',
    );
  const secret = value[field(path)];
  validateRecord(path, value);
  validateSecret(path, secret);
  privateDirectory(join(root, path.split('/')[0]!));
  if (!saved || saved.mode === 'protected-file') {
    put(join(root, path), value);
    return;
  }
  const ref = {
    generation: saved.generation,
    itemId: path.startsWith('keys/')
      ? `${value.serverId}-${value.vaultId}`
      : String(value.serverId),
  };
  const { [field(path)]: omitted, ...metadata } = value;
  // Publish the identity first: an ambiguous store write must never become an empty root.
  const recordPath = join(root, path);
  const prior = existsSync(recordPath) ? read(recordPath) : undefined;
  if (prior) {
    validateRecord(path, prior);
    recordReference(path, prior, saved);
  }
  const incomplete = !prior || prior.credentialWrite === 'pending';
  put(recordPath, {
    ...metadata,
    version: 2,
    credential: ref,
    ...(incomplete ? { credentialWrite: 'pending' } : {}),
  });
  options.checkpoint?.('record-intent');
  const current = await native(() => storeFor(options).get(address(saved, ref)));
  if (current !== null && current !== secret)
    throw new ClientError('CONFLICT', 'Stored credential differs from pending identity');
  await native(() => storeFor(options).set({ ...address(saved, ref), value: secret }));
  options.checkpoint?.('record-stored');
  if ((await required(saved, ref, options)) !== secret) throw unavailable();
  const { credentialWrite: phase, ...ready } = metadata;
  put(recordPath, { ...ready, version: 2, credential: ref });
  options.checkpoint?.('record-ready');
}
interface Cleanup {
  version: 1;
  paths: string[];
  references: { path: string; metadata: RecordValue; reference: Reference }[];
}
export function assertRemovalCredentialCleanup(root: string, paths: string[], serverId: string | null): void {
  if (!pathPresent(join(root, CLEANUP))) return;
  try {
    const intent = read(join(root, CLEANUP)) as Cleanup;
    exact(intent, ['version', 'paths', 'references']);
    if (intent.version !== 1 || !Array.isArray(intent.paths) || !Array.isArray(intent.references) ||
        JSON.stringify([...intent.paths].sort()) !== JSON.stringify([...paths].sort())) throw new Error('cleanup identity differs');
    const saved = descriptor(root);
    if (intent.references.length !== (saved?.mode === 'os-store' ? paths.length : 0) || new Set(intent.references.map(item => item.path)).size !== intent.references.length) throw new Error('cleanup reference inventory differs');
    for (const item of intent.references) {
      exact(item, ['path', 'metadata', 'reference']);
      validateRecord(item.path, item.metadata);
      if (!saved || !paths.includes(item.path) || item.metadata.serverId !== serverId || 'token' in item.metadata || 'masterKey' in item.metadata) throw new Error('cleanup server differs');
      const expected = recordReference(item.path, item.metadata, saved);
      address(saved, item.reference);
      if (expected.itemId !== item.reference.itemId || expected.generation !== item.reference.generation) throw new Error('cleanup reference differs');
    }
  } catch {
    throw new ClientError('REMOVAL_INVALID', 'Credential cleanup is unsafe or differs from the original removal; preserve private state.');
  }
}

async function erase(saved: Descriptor, ref: Reference, options: CredentialOptions) {
  const target = address(saved, ref),
    store = storeFor(options);
  const marker = `nanosync-deleted:${randomUUID()}`;
  await native(() => store.set({ ...target, value: marker }));
  options.checkpoint?.('cleanup-marker');
  if ((await required(saved, ref, options)) !== marker) throw unavailable();
  if (!(await native(() => store.delete(target)))) throw unavailable();
  options.checkpoint?.('cleanup-deleted');
  if ((await native(() => store.get(target))) !== null) throw unavailable();
}
export async function cleanupCredentialRecords(
  root: string,
  paths: string[],
  options: CredentialOptions = {},
  retainIntent = false,
) {
  credentialBarrier(root);
  if (!retainIntent) assertNoRemoval(root);
  const journalPath = join(root, CLEANUP),
    saved = descriptor(root);
  let intent: Cleanup;
  if (existsSync(journalPath)) {
    intent = read(journalPath);
    if (!Array.isArray(intent.paths)) stateInvalid('Invalid cleanup intent');
    if (JSON.stringify([...intent.paths].sort()) !== JSON.stringify([...paths].sort()))
      throw new ClientError(
        'CREDENTIAL_CLEANUP_PENDING',
        'Another credential cleanup is pending; repeat its original removal',
      );
  } else {
    const references = paths
      .filter((path) => existsSync(join(root, path)))
      .flatMap((path) => {
        const value = read(join(root, path));
        if (!value.credential) return [];
        if (!saved) stateInvalid('cleanup descriptor missing');
        const metadata = credentialMetadata(root, path);
        return [{ path, metadata, reference: recordReference(path, value, saved) }];
      });
    intent = { version: 1, paths, references };
    const stage = `${journalPath}.${randomBytes(16).toString('hex')}.stage`;
    secureCreate(stage, JSON.stringify(intent));
    options.checkpoint?.('cleanup-intent-staged');
    renameSync(stage, journalPath);
    options.checkpoint?.('cleanup-intent-published');
    syncPrivateDirectory(root);
  }
  exact(intent, ['version', 'paths', 'references']);
  if (intent.version !== 1 || !Array.isArray(intent.paths) || !Array.isArray(intent.references))
    stateInvalid('invalid credential cleanup intent');
  if (new Set(intent.paths).size !== intent.paths.length) {
    stateInvalid('Duplicate cleanup path');
  }
  const expectedReferences = saved?.mode === 'os-store' ? intent.paths.length : 0;
  if (
    intent.references.length !== expectedReferences ||
    new Set(intent.references.map((item) => item.path)).size !== intent.references.length
  ) {
    stateInvalid('Cleanup reference inventory incomplete');
  }
  for (const path of intent.paths)
    if (!/^(servers|keys|pending)\/[0-9a-f-]+\.json$/.test(path))
      stateInvalid('invalid cleanup path');
  if (intent.references.length && !saved) stateInvalid('cleanup descriptor missing');
  // Replay can see an intent whose original publication fsync failed; flush it before erasing secrets.
  secureRead(journalPath, 1_000_000, true);
  for (const item of intent.references) {
    exact(item, ['path', 'metadata', 'reference']);
    validateRecord(item.path, item.metadata);
    if ('token' in item.metadata || 'masterKey' in item.metadata)
      stateInvalid('Cleanup metadata must not contain secrets');
    const ref = item.reference;
    address(saved!, ref);
    const expected = recordReference(item.path, item.metadata, saved!);
    if (expected.itemId !== ref.itemId || expected.generation !== ref.generation)
      stateInvalid('Cleanup references differ');
    if (ref.generation !== saved!.generation || !intent.paths.includes(item.path))
      stateInvalid('cleanup reference identity differs');
    if (!item.path.startsWith('pending/') && !item.path.endsWith(`/${ref.itemId}.json`))
      stateInvalid('cleanup item differs');
    if (existsSync(join(root, item.path))) {
      const current = credentialMetadata(root, item.path);
      if (!isDeepStrictEqual(current, item.metadata)) {
        stateInvalid('Cleanup source identity changed');
      }
    }
    await erase(saved!, ref, options);
  }
  for (const path of intent.paths) remove(join(root, path));
  options.checkpoint?.('cleanup-files');
  if (!retainIntent) finishCredentialCleanup(root);
}
export function finishCredentialCleanup(root: string): void {
  const removal = removalStatus(root);
  if (removal && removal.phase !== 'credentials-complete') throw new ClientError('REMOVAL_PENDING', 'Retain credential inventory until removal completion is durable.');
  if (removal) secureRead(join(root, REMOVAL), 1_000_000, true);
  for (const name of readdirSync(root).filter(name => cleanupStage.test(name))) {
    validateSettingsStage(join(root, name)); unlinkSync(join(root, name));
  }
  remove(join(root, CLEANUP));
}
export async function resumeCredentialCleanup(
  root: string,
  confirmation: boolean,
  options: CredentialOptions = {},
) {
  assertNoRemoval(root);
  if (!confirmation)
    throw new ClientError('CONFIRMATION_REQUIRED', 'Explicit --confirm-cleanup required');
  return withCredentialOperation(root, () =>
    withCredentialRegistry(root, async () => {
      const intent = read(join(root, CLEANUP)) as Cleanup;
      await cleanupCredentialRecords(root, intent.paths, options);
      return credentialStatus(root);
    }),
  );
}
interface Migration {
  version: 1;
  source: Descriptor;
  target: Descriptor;
  phase: 'copying' | 'target-ready' | 'cleanup';
  items: { path: string; metadata: RecordValue; reference: Reference }[];
}
async function migrationLock<T>(root: string, action: () => Promise<T>) {
  privateDirectory(root); assertNoRemoval(root);
  const releases = [acquireSyncLock(privateDirectory(join(root, 'registry-lock')))];
  try {
    releases.push(acquireSyncLock(privateDirectory(join(root, 'credential-operation'))));
    const replicas = join(root, 'replicas');
    if (existsSync(replicas)) {
      privateDirectory(replicas);
      for (const name of readdirSync(replicas).sort()) {
        if (!uuid(name)) stateInvalid('unexpected replica directory');
        releases.push(acquireSyncLock(privateDirectory(join(replicas, name))));
      }
    }
    return await action();
  } finally {
    for (const release of releases.reverse()) release();
  }
}
function migration(root: string): Migration {
  const intent = read(join(root, MIGRATION)) as Migration;
  exact(intent, ['version', 'source', 'target', 'phase', 'items']);
  exact(intent.source, ['version', 'rootId', 'generation', 'mode']);
  exact(intent.target, ['version', 'rootId', 'generation', 'mode']);
  if (
    intent.version !== 1 ||
    intent.source.version !== 1 ||
    intent.target.version !== 1 ||
    intent.source.mode !== 'protected-file' ||
    intent.target.mode !== 'os-store' ||
    !Array.isArray(intent.items) ||
    !['copying', 'target-ready', 'cleanup'].includes(intent.phase)
  )
    stateInvalid('invalid migration intent');
  const saved = descriptor(root);
  if (
    !saved ||
    !uuid(intent.source.rootId) ||
    !uuid(intent.source.generation) ||
    !uuid(intent.target.generation) ||
    intent.source.rootId !== intent.target.rootId ||
    intent.source.generation === intent.target.generation ||
    saved.rootId !== intent.source.rootId ||
    ![intent.source.generation, intent.target.generation].includes(saved.generation) ||
    (saved.generation === intent.target.generation &&
      (intent.phase !== 'cleanup' || saved.mode !== 'os-store')) ||
    (saved.generation === intent.source.generation && saved.mode !== 'protected-file')
  )
    stateInvalid('migration identity differs');
  const paths = new Set<string>();
  for (const item of intent.items) {
    exact(item, ['path', 'metadata', 'reference']);
    if (paths.has(item.path)) stateInvalid('duplicate migration item');
    paths.add(item.path);
    if (!/^(servers|keys|pending)\/[0-9a-f-]+\.json$/.test(item.path))
      stateInvalid('invalid migration path');
    validateRecord(item.path, item.metadata);
    address(intent.target, item.reference);
    const ref = recordReference(item.path, item.metadata, intent.target);
    if (ref.generation !== item.reference.generation || ref.itemId !== item.reference.itemId)
      stateInvalid('migration references differ');
    if ('token' in item.metadata || 'masterKey' in item.metadata)
      stateInvalid('migration metadata contains secrets');
  }
  return intent;
}
export async function migrateCredentials(
  root: string,
  confirmation: boolean,
  options: CredentialOptions = {},
) {
  if (!confirmation)
    throw new ClientError(
      'CONFIRMATION_REQUIRED',
      'Explicit --confirm-migration is required; --yes does not authorize migration',
    );
  if (credentialStatus(root).mode === 'uninitialized')
    throw new ClientError('INPUT_REQUIRED', 'Initialize a credential mode before migration');
  return migrationLock(root, async () => {
    credentialBarrier(root);
    if (existsSync(join(root, CLEANUP)))
      throw new ClientError(
        'CREDENTIAL_CLEANUP_PENDING',
        'Finish connection credential cleanup before migrating',
      );
    let source = descriptor(root);
    if (!source) {
      const status = credentialStatus(root);
      if (status.mode !== 'protected-file') stateInvalid('Source mode changed');
      source = {
        version: 1,
        rootId: randomUUID(),
        generation: randomUUID(),
        mode: 'protected-file',
      };
      put(join(root, MODE), source);
    }
    if (source.mode !== 'protected-file')
      throw new ClientError('CREDENTIAL_MODE_CONFLICT', 'This root already uses OS store');
    const target: Descriptor = { ...source, mode: 'os-store', generation: randomUUID() };
    const items = [];
    for (const path of files(root)) {
      const value = await readRecord<RecordValue>(root, path, source, options);
      const { [field(path)]: secret, ...metadata } = value;
      const reference = {
        generation: target.generation,
        itemId: path.startsWith('keys/')
          ? `${value.serverId}-${value.vaultId}`
          : String(value.serverId),
      };
      items.push({ path, metadata: { ...metadata, version: 2, credential: reference }, reference });
    }
    put(join(root, MIGRATION), { version: 1, source, target, phase: 'copying', items });
    options.checkpoint?.('migration-intent');
    return finishMigration(root, options);
  });
}
function verifyInventory(root: string, intent: Migration) {
  const expected = intent.items.map((item) => item.path).sort();
  if (!isDeepStrictEqual(files(root), expected)) {
    stateInvalid('Credential inventory changed; preserve the migration barrier and inspect state');
  }
}
async function verifyTarget(
  root: string,
  intent: Migration,
  item: Migration['items'][number],
  options: CredentialOptions,
) {
  const target = await required(intent.target, item.reference, options);
  validateSecret(item.path, target);
  const source = read(join(root, item.path));
  validateRecord(item.path, source);
  const secretField = field(item.path);
  if (secretField in source) {
    validateSecret(item.path, source[secretField]);
    if (source[secretField] !== target) throw unavailable();
    const { [secretField]: secret, ...metadata } = source;
    const expected = { ...metadata, version: 2, credential: item.reference };
    if (!isDeepStrictEqual(expected, item.metadata)) {
      stateInvalid('Source metadata changed since migration inventory');
    }
  } else if (!isDeepStrictEqual(source, item.metadata)) {
    stateInvalid('Source cleanup metadata differs from migration intent');
  }
}
async function verifyTargets(root: string, intent: Migration, options: CredentialOptions) {
  verifyInventory(root, intent);
  for (const item of intent.items) await verifyTarget(root, intent, item, options);
}
async function finishMigration(root: string, options: CredentialOptions) {
  const intent = migration(root),
    journal = join(root, MIGRATION);
  if (intent.phase !== 'cleanup') {
    for (const item of intent.items) {
      const value = await readRecord<RecordValue>(root, item.path, intent.source, options);
      const secret = value[field(item.path)] as string;
      await native(() =>
        storeFor(options).set({ ...address(intent.target, item.reference), value: secret }),
      );
      options.checkpoint?.('migration-item-stored');
      if ((await required(intent.target, item.reference, options)) !== secret) throw unavailable();
    }
    await verifyTargets(root, intent, options);
    intent.phase = 'target-ready';
    put(journal, intent);
    options.checkpoint?.('migration-target-ready');
    await verifyTargets(root, intent, options);
    intent.phase = 'cleanup';
    put(journal, intent);
    options.checkpoint?.('migration-cleanup-intent');
  }
  await verifyTargets(root, intent, options);
  for (const item of intent.items) {
    // Recheck the still-secret source immediately before destroying its file value.
    await verifyTarget(root, intent, item, options);
    put(join(root, item.path), item.metadata);
    options.checkpoint?.('migration-source-cleaned');
  }
  await verifyTargets(root, intent, options);
  for (const item of intent.items) {
    const value = read(join(root, item.path));
    if (field(item.path) in value || !isDeepStrictEqual(value, item.metadata)) {
      stateInvalid('Source cleanup incomplete');
    }
  }
  verifyInventory(root, intent);
  put(join(root, MODE), intent.target);
  options.checkpoint?.('migration-committed');
  remove(journal);
  options.checkpoint?.('migration-complete');
  return credentialStatus(root);
}
export async function resumeCredentialMigration(
  root: string,
  confirmation: boolean,
  options: CredentialOptions = {},
) {
  if (!confirmation)
    throw new ClientError('CONFIRMATION_REQUIRED', 'Explicit --confirm-migration required');
  return migrationLock(root, () => finishMigration(root, options));
}
export async function rollbackCredentialMigration(
  root: string,
  confirmation: boolean,
  options: CredentialOptions = {},
) {
  if (!confirmation)
    throw new ClientError('CONFIRMATION_REQUIRED', 'Explicit --confirm-rollback required');
  return migrationLock(root, async () => {
    const intent = migration(root);
    if (intent.phase === 'cleanup')
      throw new ClientError(
        'CREDENTIAL_ROLL_FORWARD_REQUIRED',
        'Source cleanup started; resume migration, rollback is no longer safe',
      );
    verifyInventory(root, intent);
    for (const item of intent.items) {
      const source = await readRecord<RecordValue>(root, item.path, intent.source, options);
      const { [field(item.path)]: secret, ...metadata } = source;
      const expected = { ...metadata, version: 2, credential: item.reference };
      if (!isDeepStrictEqual(expected, item.metadata)) {
        stateInvalid('Original source metadata changed; preserve staged credentials');
      }
    }
    for (const item of intent.items) await erase(intent.target, item.reference, options);
    remove(join(root, MIGRATION));
    return credentialStatus(root);
  });
}
