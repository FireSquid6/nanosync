export { api, baseUrl, login } from './client.ts';
export { privateDirectory, secureRead, secureCreate, secureInstall, secureReplace, syncPrivateDirectory, provisionSecret } from './security.ts';
export { acquireSyncLock, type FileIdentity } from './sync-lock.ts';
export { createConnection, connectRegisteredVault, discoverConnection, records, repairConnection, disconnectConnections, removeServerConnection, withConnectionRegistry, type Connection } from './connections.ts';
export { listRemoteVaults, resolveRemoteVault, type RemoteVault, enrollServer, key, server, servers, unlockVault, pendingEnrollments, connectionSummary, type ServerRegistration, type PendingEnrollment } from './vault-client.ts';
export { SyncRunner, type SyncOptions } from './sync-runner.ts';
export { ClientError } from './errors.ts';
export { startBoundSync } from './bound-sync.ts';
export type { EnrollmentEvent, SyncEvent } from './events.ts';
