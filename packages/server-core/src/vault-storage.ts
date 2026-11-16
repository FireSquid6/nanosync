import type { Filesystem } from '@nanosync/server-object-storage';

// One runtime owns a storage instance. Serialize reclamation with every writer,
// including writes which have not reached the catalog yet. Tombstoning itself
// never waits for a slow upload. On restart no old writer survives.
const queues = new WeakMap<Filesystem, Map<string, Promise<unknown>>>();
export async function withVaultStorage<T>(storage: Filesystem, vault: string, work: () => Promise<T>): Promise<T> {
  let queue = queues.get(storage);
  if (!queue) { queue = new Map(); queues.set(storage, queue); }
  const previous = queue.get(vault) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queue.set(vault, next);
  try { return await next; }
  finally { if (queue.get(vault) === next) queue.delete(vault); }
}
