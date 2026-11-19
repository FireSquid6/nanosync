import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { openBoundSync, discoverConnection, privateDirectory } from '../../src/index.ts';
import { acquireSyncLock } from '../../src/sync-lock.ts';

const [root, files, origin, instanceId, mode] = process.argv.slice(2) as [string, string, 'cli' | 'desktop', string, string];
const emit = (value: unknown) => console.log(JSON.stringify(value));
if (mode === 'pre-advertise') {
  const binding = discoverConnection(root, files);
  acquireSyncLock(privateDirectory(join(privateDirectory(join(root, 'replicas')), binding.connectionId)));
  emit({ ready: true });
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'crash') process.exit(17);
  }
} else {
  const session = await openBoundSync(root, files, { origin, instanceId });
  emit({ ready: true, owner: session.owner });
  const controller = new AbortController();
  let watching: Promise<void> | undefined;
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'crash') process.exit(17);
    if (line === 'watch') {
      watching = session.watch(controller.signal, head => emit({ head }), () => emit({ watchError: true }));
      void watching.catch(() => emit({ watchStopped: true }));
      emit({ watching: true });
    }
    if (line === 'sync') {
      try { emit({ head: await session.syncOnce() }); }
      catch (error) { emit({ code: error && typeof error === 'object' && 'code' in error ? error.code : 'OPERATION_FAILED' }); }
    }
    if (line === 'close') {
      controller.abort();
      await session.close();
      await watching?.catch(() => {});
      process.exit(0);
    }
  }
  await session.close();
}
