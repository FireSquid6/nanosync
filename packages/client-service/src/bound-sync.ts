import { join } from 'node:path';
import { discoverConnection } from './connections.ts';
import { ClientError } from './errors.ts';
import { privateDirectory } from './security.ts';
import { SyncRunner, type SyncOptions } from './sync-runner.ts';
import { key, authenticatedServer } from './vault-client.ts';
import { withCredentialRegistry, type CredentialOptions } from './credentials.ts';

export async function startBoundSync(
  directory: string, from: string, options: Pick<SyncOptions, 'onEvent'> & CredentialOptions = {},
): Promise<SyncRunner> {
  return withCredentialRegistry(directory, async () => {
    const binding = discoverConnection(directory, from);
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
        masterKey: master, baseUrl: info.baseUrl, token: info.token, onEvent: options.onEvent,
      });
    } finally { master.fill(0); }
  });
}
