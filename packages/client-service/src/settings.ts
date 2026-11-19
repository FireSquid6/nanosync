import { lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { parseVaultId } from '@nanosync/protocol';
import { privateDirectory, secureCreate, secureRead, syncPrivateDirectory } from './security.ts';
import { acquireSyncLock } from './sync-lock.ts';
import { ClientError } from './errors.ts';

export const SETTINGS = 'settings.json';
export const SETTINGS_LOCK = 'settings-lock';
export const settingsStage = /^settings\.json\.[0-9a-f]{32}\.stage$/;
export interface ClientSettings {
  version: 1;
  revision: number;
  globalPaused: boolean;
  bindingPaused: Record<string, boolean>;
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
  if (!value || Object.keys(value).sort().join(',') !== 'bindingPaused,globalPaused,revision,version' ||
      value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
      typeof value.globalPaused !== 'boolean' || !value.bindingPaused ||
      typeof value.bindingPaused !== 'object' ||
      Array.isArray(value.bindingPaused)) throw new Error('Invalid client settings');
  for (const [id, paused] of Object.entries(value.bindingPaused)) {
    parseVaultId(id);
    if (typeof paused !== 'boolean') throw new Error('Invalid binding pause');
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
  const directory = privateDirectory(root);
  const release = acquireSyncLock(privateDirectory(join(directory, SETTINGS_LOCK)));
  try {
    const settings = readSettings(directory);
    if (expectedRevision !== undefined && expectedRevision !== settings.revision)
      throw new ClientError('CONFLICT', 'Settings changed; refresh and retry');
    if ('all' in target) settings.globalPaused = paused;
    else settings.bindingPaused[target.binding] = paused;
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
  } finally { release(); }
}
