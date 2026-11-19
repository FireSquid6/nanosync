import { ClientLocal } from '@nanosync/client-local';
import { readIgnoreFile, validateIgnoreText } from '@nanosync/linux-client';
import { join, dirname } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { records, checkedBindingRoot } from './connections.ts';
import { selectSavedBinding } from './status.ts';
import { ClientError } from './errors.ts';
import { assertNoRemoval, removalStatus } from './removal-state.ts';

export { validateIgnoreText, readIgnoreFile };
export function viewIgnores(root: string, from: string) {
  assertNoRemoval(root);
  const binding = selectSavedBinding(root, from);
  return {
    version: 1 as const,
    connectionId: binding.connectionId,
    ...readIgnoreFile(join(checkedBindingRoot(root, binding.connectionId), '.nanosyncignore')),
  };
}
export function listConflicts(root: string, from?: string) {
  const removal = removalStatus(root);
  return {
    version: 1 as const,
    bindings: (from ? [selectSavedBinding(root, from)] : records(root)).map((binding) => {
      if (removal?.bindings.some((item) => item.connection.connectionId === binding.connectionId))
        return {
          connectionId: binding.connectionId,
          root: binding.root,
          conflicts: [],
          issue: 'REMOVAL_PENDING',
        };
      try {
        return {
          connectionId: binding.connectionId,
          root: binding.root,
          conflicts: ClientLocal.readConflicts(
            join(root, 'replicas', binding.connectionId),
            binding.vaultId,
            binding.deviceId,
          ),
          issue: null,
        };
      } catch (error) {
        return {
          connectionId: binding.connectionId,
          root: binding.root,
          conflicts: [],
          issue: error instanceof Error && 'code' in error ? String(error.code) : 'JOURNAL_INVALID',
        };
      }
    }),
  };
}
export function checkedConflictFolder(root: string, bindingId: string, conflictId: string): string {
  assertNoRemoval(root);
  const checked = checkedBindingRoot(root, bindingId);
  const listing = listConflicts(root, checked).bindings[0]!;
  if (listing.issue)
    throw new ClientError(
      listing.issue,
      'Conflict journal unavailable; refresh or recover with its compatible owner.',
    );
  const conflict = listing.conflicts.find((item) => item.id === conflictId);
  if (!conflict) throw new ClientError('NOT_FOUND', 'Open conflict not found; refresh.');
  let current = checked;
  for (const part of conflict.path.split('/')) {
    current = join(current, part);
    const stat = lstatSync(current);
    if (
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid!() ||
      realpathSync(current) !== current
    )
      throw new ClientError(
        'FOLDER_UNAVAILABLE',
        'Conflict location changed; inspect the original folder.',
      );
  }
  const folder = dirname(current);
  if (!lstatSync(folder).isDirectory())
    throw new ClientError('FOLDER_UNAVAILABLE', 'Conflict folder unavailable.');
  return folder;
}
