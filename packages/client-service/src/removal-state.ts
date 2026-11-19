import { join, resolve } from 'node:path';
import { lstatSync, readdirSync, renameSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { parseVaultId, parseDeviceId } from '@nanosync/protocol';
import { secureRead, secureCreate, secureReplace, syncPrivateDirectory } from './security.ts';
import { ClientError } from './errors.ts';
import type { Connection } from './connections.ts';

export const REMOVAL = 'removal.json';
export const removalStage = /^removal\.json\.[0-9a-f]{32}\.stage$/;
export interface RemovalIntent {
  version: 1;
  requestId: string;
  kind: 'disconnect' | 'server';
  serverId: string | null;
  force: boolean;
  phase: 'removing-bindings' | 'cleaning-credentials' | 'credentials-complete';
  bindings: {
    connection: Connection;
    rootIdentity: { device: string; inode: string } | null;
    rootWasMissing: boolean;
  }[];
  credentialPaths: string[];
}
export function pathPresent(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}
function keys(value: object, expected: string) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== expected
  )
    throw new Error('invalid removal fields');
}
export function validateRemovalStage(path: string) {
  const stat = lstatSync(path);
  if (
    !stat.isFile() ||
    stat.uid !== process.getuid!() ||
    stat.nlink !== 1 ||
    stat.mode & 0o177 ||
    stat.size > 1_000_000
  )
    throw new ClientError(
      'REMOVAL_INVALID',
      'Unsafe removal stage; preserve private state and inspect it.',
    );
}
export function removalStatus(root: string): RemovalIntent | null {
  if (!pathPresent(join(root, REMOVAL))) return null;
  try {
    const value: RemovalIntent = JSON.parse(
      secureRead(join(root, REMOVAL), 1_000_000).toString('utf8'),
    );
    keys(value, 'bindings,credentialPaths,force,kind,phase,requestId,serverId,version');
    parseVaultId(value.requestId);
    if (
      value.version !== 1 ||
      !['disconnect', 'server'].includes(value.kind) ||
      typeof value.force !== 'boolean' ||
      !['removing-bindings', 'cleaning-credentials', 'credentials-complete'].includes(
        value.phase,
      ) ||
      !Array.isArray(value.bindings) ||
      !Array.isArray(value.credentialPaths)
    )
      throw new Error('invalid removal intent');
    if (value.kind === 'server') parseVaultId(value.serverId);
    else if (value.serverId !== null || value.credentialPaths.length)
      throw new Error('invalid disconnect');
    const ids = new Set<string>();
    for (const item of value.bindings) {
      keys(item, 'connection,rootIdentity,rootWasMissing');
      const binding = item.connection;
      keys(binding, 'connectionId,deviceId,root,serverId,vaultId,version');
      parseVaultId(binding.connectionId);
      parseVaultId(binding.vaultId);
      parseDeviceId(binding.deviceId);
      if (
        binding.version !== 1 ||
        typeof binding.serverId !== 'string' ||
        !binding.serverId ||
        binding.serverId.includes('\0') ||
        typeof binding.root !== 'string' ||
        resolve(binding.root) !== binding.root ||
        binding.root.includes('\0') ||
        ids.has(binding.connectionId) ||
        typeof item.rootWasMissing !== 'boolean' ||
        (item.rootWasMissing && !value.force) ||
        (value.serverId !== null && binding.serverId !== value.serverId)
      )
        throw new Error('invalid removal binding');
      ids.add(binding.connectionId);
      if (item.rootIdentity !== null) {
        keys(item.rootIdentity, 'device,inode');
        if (
          typeof item.rootIdentity.device !== 'string' ||
          typeof item.rootIdentity.inode !== 'string' ||
          !/^\d+$/.test(item.rootIdentity.device) ||
          !/^[1-9]\d*$/.test(item.rootIdentity.inode)
        )
          throw new Error('invalid root identity');
      } else if (!item.rootWasMissing) throw new Error('missing root identity');
    }
    if (
      (value.kind === 'server' &&
        !value.credentialPaths.includes(`servers/${value.serverId}.json`)) ||
      new Set(value.credentialPaths).size !== value.credentialPaths.length ||
      value.credentialPaths.some(
        (path) => typeof path !== 'string' || !validCredentialPath(path, value.serverId),
      )
    )
      throw new Error('invalid cleanup inventory');
    return value;
  } catch {
    throw new ClientError(
      'REMOVAL_INVALID',
      'Removal state is unsafe or invalid; preserve it and inspect private state.',
    );
  }
}
function validCredentialPath(path: string, serverId: string | null): boolean {
  if (!serverId) return false;
  if (path === `servers/${serverId}.json`) return true;
  if (/^pending\/[0-9a-f]{64}\.json$/.test(path)) return true;
  const prefix = `keys/${serverId}-`;
  if (!path.startsWith(prefix) || !path.endsWith('.json')) return false;
  const vault = path.slice(prefix.length, -5);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(vault)) return false;
  parseVaultId(vault);
  return true;
}

export function assertNoRemoval(root: string): void {
  if (removalStatus(root))
    throw new ClientError(
      'REMOVAL_PENDING',
      'Removal pending; inspect client removals view and explicitly resume its original request.',
    );
}
export function writeRemoval(
  root: string,
  intent: RemovalIntent,
  checkpoint?: (phase: string) => void,
) {
  const text = JSON.stringify(intent);
  if (Buffer.byteLength(text) > 1_000_000)
    throw new ClientError('INVALID_INPUT', 'Removal inventory is too large.');
  const path = join(root, REMOVAL);
  if (pathPresent(path)) secureReplace(path, text);
  else {
    const stage = `${path}.${randomBytes(16).toString('hex')}.stage`;
    secureCreate(stage, text);
    checkpoint?.('removal-intent-staged');
    if (pathPresent(path))
      throw new ClientError('REMOVAL_INVALID', 'Removal intent appeared during publication.');
    renameSync(stage, path);
    checkpoint?.('removal-intent-published');
    syncPrivateDirectory(root);
  }
}
export function finishRemoval(root: string) {
  for (const name of readdirSync(root).filter((name) => removalStage.test(name))) {
    validateRemovalStage(join(root, name));
    unlinkSync(join(root, name));
  }
  unlinkSync(join(root, REMOVAL));
  syncPrivateDirectory(root);
}
