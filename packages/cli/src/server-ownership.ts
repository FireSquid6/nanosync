import { acquireSyncLock } from '@nanosync/client-service';

/** One storage owner per server directory, including distinct instances/processes.
 * Metadata-only administration deliberately does not acquire this gate.
 */
export function acquireServerStorage(root: string): () => void {
  try { return acquireSyncLock(root); }
  catch (cause) {
    throw new Error('Cannot own server storage: stop the server runtime and wait for any local provisioning/initialization to finish, then retry. Do not remove a live ownership lock.', { cause });
  }
}
