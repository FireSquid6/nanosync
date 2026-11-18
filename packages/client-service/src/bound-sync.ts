import { join } from 'node:path';
import { discoverConnection, withConnectionRegistry } from './connections.ts';
import { ClientError } from './errors.ts';
import { privateDirectory } from './security.ts';
import { SyncRunner, type SyncOptions } from './sync-runner.ts';
import { key, server } from './vault-client.ts';

export function startBoundSync(
  directory: string, from: string, options: Pick<SyncOptions, 'onEvent'> = {},
): SyncRunner {
  const binding = discoverConnection(directory, from), info = server(directory, binding.serverId);
  if (binding.deviceId !== info.deviceId) {
    throw new ClientError('CONFLICT', 'binding device differs from connection');
  }
  const master = key(directory, info.serverId, binding.vaultId);
  if (!master) throw new ClientError('INPUT_REQUIRED', 'vault key is missing; reconnect to unlock');
  try {
    return withConnectionRegistry(directory, () => {
      if (discoverConnection(directory, binding.root).connectionId !== binding.connectionId) {
        throw new ClientError('CONFLICT', 'binding changed');
      }
      server(directory, binding.serverId);
      const replicas = privateDirectory(join(privateDirectory(directory), 'replicas'));
      return SyncRunner.start({
        clientDirectory: privateDirectory(join(replicas, binding.connectionId)),
        syncDirectory: binding.root, vaultId: binding.vaultId, deviceId: binding.deviceId,
        masterKey: master, baseUrl: info.baseUrl, token: info.token, onEvent: options.onEvent,
      });
    });
  } finally { master.fill(0); }
}
