import { lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join, resolve } from 'node:path';
import { parseVaultId } from '@nanosync/protocol';
import { privateDirectory, secureCreate, secureRead, syncPrivateDirectory } from './security.ts';
import { acquireSyncLock, observeSyncLock } from './sync-lock.ts';
import { ClientError } from './errors.ts';

export const SETTINGS = 'settings.json';
export const SETTINGS_LOCK = 'settings-lock';
export const settingsStage = /^settings\.json\.[0-9a-f]{32}\.stage$/;
export interface ClientSettings {
  version: 1 | 2 | 3;
  revision: number;
  globalPaused: boolean;
  bindingPaused: Record<string, boolean>;
}
export interface LifecyclePreferences {
  startAtLogin: boolean;
  trayEnabled: boolean | null;
  keepSyncingAfterClose: boolean;
}
export interface NotificationPreferences {
  enabled: boolean;
  conflicts: boolean;
  revokedAccess: boolean;
  persistentFailures: boolean;
  includeNamesAndPaths: boolean;
}
export const notificationDefaults: NotificationPreferences = {
  enabled: true, conflicts: true, revokedAccess: true, persistentFailures: true,
  includeNamesAndPaths: false,
};
export function validateNotifications(value: unknown): asserts value is NotificationPreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== Object.keys(notificationDefaults).sort().join(',') ||
      Object.values(value).some(choice => typeof choice !== 'boolean'))
    throw new ClientError('INVALID_INPUT', 'Choose each notification preference explicitly.');
}
export interface ClientPreferences extends ClientSettings {
  version: 3;
  notifications: NotificationPreferences;
  lifecycle: LifecyclePreferences;
  continuousRequested: Record<string, 'cli' | 'desktop'>;
}
export function readPreferences(root: string): ClientPreferences {
  const saved = readSettings(root);
  return {
    lifecycle: { startAtLogin: false, trayEnabled: null, keepSyncingAfterClose: true },
    continuousRequested: {},
    ...saved, version: 3,
    notifications: saved.version === 3
      ? (saved as ClientPreferences).notifications : { ...notificationDefaults },
  };
}
function validateLifecycle(value: unknown): asserts value is LifecyclePreferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== 'keepSyncingAfterClose,startAtLogin,trayEnabled' ||
      typeof (value as LifecyclePreferences).startAtLogin !== 'boolean' ||
      typeof (value as LifecyclePreferences).keepSyncingAfterClose !== 'boolean' ||
      ![true, false, null].includes((value as LifecyclePreferences).trayEnabled))
    throw new ClientError('INVALID_INPUT', 'Choose each lifecycle preference explicitly.');
}
export function setLifecycle(root: string, lifecycle: LifecyclePreferences, expectedRevision: number): ClientPreferences {
  return setPreferences(root, { lifecycle }, expectedRevision);
}
export function setPreferences(root: string, patch: {
  lifecycle?: LifecyclePreferences;
  notifications?: Partial<NotificationPreferences>;
}, expectedRevision: number): ClientPreferences {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch) || !Object.keys(patch).length ||
      Object.keys(patch).some(key => !['lifecycle', 'notifications'].includes(key)))
    throw new ClientError('INVALID_INPUT', 'Choose settings to change.');
  if (patch.lifecycle !== undefined) {
    validateLifecycle(patch.lifecycle);
    if (patch.lifecycle.trayEnabled === null)
      throw new ClientError('INPUT_REQUIRED', 'Choose whether to enable the tray.');
  }
  if (patch.notifications !== undefined) {
    const choices = patch.notifications;
    if (!choices || typeof choices !== 'object' || Array.isArray(choices) ||
        !Object.keys(choices).length || Object.keys(choices).some(key => !Object.hasOwn(notificationDefaults, key)) ||
        Object.values(choices).some(choice => typeof choice !== 'boolean'))
      throw new ClientError('INVALID_INPUT', 'Notification choices must be boolean.');
  }
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)
    throw new ClientError('INVALID_INPUT', 'Expected settings revision must be a nonnegative integer.');
  return updateSettings(root, expectedRevision, () => {
    const settings = readPreferences(root);
    if (patch.lifecycle) settings.lifecycle = { ...patch.lifecycle };
    if (patch.notifications) settings.notifications = { ...settings.notifications, ...patch.notifications };
    return settings;
  }, true) as ClientPreferences;
}
/** Absence means not requested; the value records the accepting owner, never the requester. */
export function setContinuousIntent(root: string, binding: string, origin: 'cli' | 'desktop'): void {
  parseVaultId(binding);
  if (!['cli', 'desktop'].includes(origin)) throw new ClientError('INVALID_INPUT', 'Invalid sync origin');
  updateSettings(root, undefined, () => {
    const settings = readPreferences(root);
    settings.continuousRequested[binding] = origin;
    return settings;
  }, true);
}
export function present(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
export function readSettings(root: string): ClientSettings {
  try { return settingsAtRoot(root); }
  catch { throw new ClientError('SETTINGS_INVALID', 'Saved client settings are invalid or unreadable; inspect or restore settings.json before retrying.'); }
}
function settingsAtRoot(root: string): ClientSettings {
  if (!present(root)) return { version: 1, revision: 0, globalPaused: false, bindingPaused: {} };
  privateDirectory(root);
  const path = join(root, SETTINGS);
  if (!present(path)) return { version: 1, revision: 0, globalPaused: false, bindingPaused: {} };
  return readSettingsRecord(path);
}
export function readSettingsRecord(path: string): ClientSettings {
  try { return parseSettingsRecord(path); }
  catch { throw new ClientError('SETTINGS_INVALID', 'Saved client settings are invalid or unreadable; inspect or restore settings.json before retrying.'); }
}
function parseSettingsRecord(path: string): ClientSettings {
  const value = JSON.parse(secureRead(path, 1_000_000).toString('utf8'));
  const keys = value?.version === 3
    ? 'bindingPaused,continuousRequested,globalPaused,lifecycle,notifications,revision,version'
    : value?.version === 2 ? 'bindingPaused,continuousRequested,globalPaused,lifecycle,revision,version' : 'bindingPaused,globalPaused,revision,version';
  if (!value || Object.keys(value).sort().join(',') !== keys ||
      ![1, 2, 3].includes(value.version) || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.globalPaused !== 'boolean' || !value.bindingPaused ||
      typeof value.bindingPaused !== 'object' ||
      Array.isArray(value.bindingPaused)) throw new Error('Invalid client settings');
  for (const [id, paused] of Object.entries(value.bindingPaused)) {
    parseVaultId(id);
    if (typeof paused !== 'boolean') throw new Error('Invalid binding pause');
  }
  if (value.version === 3) validateNotifications(value.notifications);
  if (value.version >= 2) {
    validateLifecycle(value.lifecycle);
    if (!value.continuousRequested || typeof value.continuousRequested !== 'object' || Array.isArray(value.continuousRequested)) throw new Error('Invalid start intent');
    for (const [id, origin] of Object.entries(value.continuousRequested)) {
      parseVaultId(id);
      if (origin !== 'cli' && origin !== 'desktop') throw new Error('Invalid start origin');
    }
  }
  return value as ClientSettings;
}
/** Uncommitted replacement stages may be empty/truncated after a crash; their contents are never intent. */
export function validateSettingsStage(path: string): void {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid!() ||
      stat.mode & 0o177 || stat.size > 1_000_000) throw new Error('Unsafe settings stage');
}
export function pauseCauses(settings: ClientSettings, binding: string) {
  return { global: settings.globalPaused, binding: settings.bindingPaused[binding] ?? false };
}
/** Separate from credential operations: pause never needs an unlocked credential store. */
export function setPaused(
  root: string, target: { all: true } | { binding: string }, paused: boolean, expectedRevision?: number,
): ClientSettings {
  if (!target || typeof target !== 'object' ||
      !((Object.keys(target).join(',') === 'all' && 'all' in target && target.all === true) ||
        (Object.keys(target).join(',') === 'binding' && 'binding' in target)))
    throw new ClientError('INVALID_INPUT', 'Choose exactly one pause target');
  if (typeof paused !== 'boolean') throw new ClientError('INVALID_INPUT', 'Pause must be boolean');
  if ('binding' in target) parseVaultId(target.binding);
  return updateSettings(root, expectedRevision, () => {
    const settings = readSettings(root);
    if ('all' in target) settings.globalPaused = paused;
    else settings.bindingPaused[target.binding] = paused;
    return settings;
  });
}
/** Caller holds the credential registry: publish the schema barrier before new incident writes. */
export function upgradePreferencesUnderRegistry(root: string): void {
  if (readSettings(root).version === 3) return;
  assertUpgradeOwners(root);
  updateSettings(root, undefined, () => readPreferences(root));
}
export function assertUpgradeOwners(root: string): void {
  root = resolve(root);
  const replicas = join(root, 'replicas');
  if (!present(replicas)) return;
  privateDirectory(replicas);
  for (const binding of readdirSync(replicas)) {
    parseVaultId(binding);
    const replica = privateDirectory(join(replicas, binding));
    const lock = observeSyncLock(replica);
    if (!lock?.live) continue;
    try {
      const metadata = JSON.parse(secureRead(join(replica, '.sync-control'), 8192).toString('utf8'));
      if (metadata.version !== 3 || metadata.root !== root || metadata.binding !== binding ||
          metadata.pid !== lock.owner.pid || metadata.starttime !== lock.owner.starttime ||
          metadata.lockDev !== lock.inode.dev || metadata.lockIno !== lock.inode.ino) throw Error('Incompatible owner');
    } catch {
      throw new ClientError('OWNER_INCOMPATIBLE', 'Stop every older or unadvertised sync owner before upgrading shared settings, then retry.');
    }
  }
}
function updateSettings(root: string, expectedRevision: number | undefined, change: () => ClientSettings, upgrade = false): ClientSettings {
  const directory = privateDirectory(root);
  // Registry before settings: old executables cannot acquire a new writer during schema upgrade.
  const registry = upgrade ? acquireSyncLock(privateDirectory(join(directory, 'registry-lock'))) : undefined;
  let release: (() => void) | undefined;
  try {
    release = acquireSyncLock(privateDirectory(join(directory, SETTINGS_LOCK)));
    if (upgrade && readSettings(directory).version !== 3) assertUpgradeOwners(directory);
    const settings = change();
    if (expectedRevision !== undefined && expectedRevision !== settings.revision)
      throw new ClientError('CONFLICT', 'Settings changed; refresh and retry');
    settings.revision++;
    if (!Number.isSafeInteger(settings.revision)) throw new Error('Settings revision exhausted');
    const path = join(directory, SETTINGS);
    for (const name of readdirSync(directory).filter(name => settingsStage.test(name))) {
      validateSettingsStage(join(directory, name));
      unlinkSync(join(directory, name));
    }
    const text = JSON.stringify(settings);
    if (Buffer.byteLength(text) > 1_000_000)
      throw new ClientError('INVALID_INPUT', 'Too many saved pause settings');
    const stage = `${path}.${randomBytes(16).toString('hex')}.stage`;
    secureCreate(stage, text);
    renameSync(stage, path); syncPrivateDirectory(directory);
    return settings;
  } finally { try { release?.(); } finally { registry?.(); } }
}
