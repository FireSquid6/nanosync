import { recordCredentialUnavailable } from './status.ts';
import { pauseCauses, readSettings } from './settings.ts';
import { join } from 'node:path';
import { discoverConnection, assertBindingRoot } from './connections.ts';
import { ClientError } from './errors.ts';
import { privateDirectory } from './security.ts';
import { SyncRunner, type SyncOptions } from './sync-runner.ts';
import { key, authenticatedServer } from './vault-client.ts';
import { withCredentialRegistry, type CredentialOptions } from './credentials.ts';

export async function startBoundSync(
  directory: string, from: string, options: Pick<SyncOptions, 'onEvent' | 'now' | 'owner' | 'fetch'> & CredentialOptions = {},
): Promise<SyncRunner> {
  return withCredentialRegistry(directory, async () => {
    const binding = discoverConnection(directory, from, true);
    try {
      const info = await authenticatedServer(directory, binding.serverId, options);
      if (binding.deviceId !== info.deviceId) {
        throw new ClientError('CONFLICT', 'binding device differs from connection');
      }
      const master = await key(directory, info.serverId, binding.vaultId, options);
      if (!master) throw new ClientError('INPUT_REQUIRED', 'vault key is missing; reconnect to unlock');
      try {
        const replicas = privateDirectory(join(privateDirectory(directory), 'replicas'));
        return SyncRunner.start({
          clientDirectory: privateDirectory(join(replicas, binding.connectionId)),
          syncDirectory: binding.root, vaultId: binding.vaultId, deviceId: binding.deviceId,
          owner: options.owner, now: options.now, fetch: options.fetch,
          validateRoot: () => assertBindingRoot(directory, binding, true),
          beforeWork() {
            const pause = pauseCauses(readSettings(directory), binding.connectionId);
            if (pause.global || pause.binding) throw new ClientError('SYNC_PAUSED', 'Sync paused; resume this folder or global syncing before retrying.');
            assertBindingRoot(directory, binding);
          },
          masterKey: master, baseUrl: info.baseUrl, token: info.token, onEvent: options.onEvent,
        });
      } finally { master.fill(0); }
    } catch (error) {
      recordCredentialUnavailable(directory, binding, error, options.now);
      throw error;
    }
  });
}
