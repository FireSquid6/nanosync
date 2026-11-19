export { api, baseUrl, login } from './client.ts';
export { privateDirectory, secureRead, secureCreate, secureInstall, secureReplace, syncPrivateDirectory, provisionSecret } from './security.ts';
export { acquireSyncLock, observeSyncLock, type FileIdentity } from './sync-lock.ts';
export { createConnection, connectRegisteredVault, discoverConnection, records, repairConnection, disconnectConnections, removeServerConnection, withConnectionRegistry, type Connection } from './connections.ts';
export { listRemoteVaults, authenticatedServer, resolveRemoteVault, type RemoteVault, type EnrollmentResult, enrollServer, key, keyWritePending, server, servers, unlockVault, pendingEnrollments, connectionSummary, type ServerRegistration, type ServerMetadata, type PendingEnrollment } from './vault-client.ts';
export { SyncRunner, type SyncOptions } from './sync-runner.ts';
export { ClientError } from './errors.ts';
export { startBoundSync } from './bound-sync.ts';
export { openBoundSync, stopOwnedSync, stopBoundSyncForRemoval, type BoundSyncSession, type BoundSyncOptions, type SyncOwner } from './sync-control.ts';
export type { EnrollmentEvent, SyncEvent } from './events.ts';
export { credentialStatus, initializeCredentials, desktopCredentials, migrateCredentials, resumeCredentialMigration, resumeCredentialCleanup, rollbackCredentialMigration, withCredentialRegistry, type CredentialMode, type CredentialStore, type CredentialOptions } from './credentials.ts';

export { readSettings, readPreferences, setLifecycle, setPreferences, validateNotifications, setPaused, pauseCauses, type ClientSettings, type ClientPreferences, type LifecyclePreferences, type NotificationPreferences } from './settings.ts';
export { credentialDecision } from './credentials.ts';
export { inspectDestination, checkedBindingRoot, inspectRemoval, resumeRemoval } from './connections.ts';
export { removalStatus, type RemovalIntent } from './removal-state.ts';
export { listConflicts, checkedConflictFolder, viewIgnores, validateIgnoreText, readIgnoreFile } from './local-actions.ts';
export { setIgnores } from './sync-control.ts';
export { onboardingSnapshot, requireDesktopCredentials, vaultKeyStatus, type OnboardingSnapshot } from './onboarding.ts';
export { clientStatus, selectSavedBinding, type SyncPhase, type TransferProgress, type ClientStatusSnapshot, type StatusIssueCode } from './status.ts';
export { collectDiagnostics, exportDiagnostics, type DiagnosticsRuntime, type DiagnosticsOptions } from './diagnostics.ts';
export { createNotificationSelection, deliverNotifications, claimNotifications, recordNotificationDelivery, notificationText,
  type NotificationBatch, type NotificationCategory } from './notifications.ts';
