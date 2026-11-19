import { enrollmentVerificationCode } from '@nanosync/protocol';
import { credentialDecision, type CredentialOptions } from './credentials.ts';
import { ClientError } from './errors.ts';
import { readPreferences } from './settings.ts';
import { clientStatus } from './status.ts';
import {
  connectionSummary,
  key,
  keyWritePending,
  listRemoteVaults,
  pendingEnrollments,
  server,
  servers,
} from './vault-client.ts';

export function onboardingSnapshot(root: string) {
  const credentials = credentialDecision(root);
  const settings = readPreferences(root);
  const blocked =
    credentials.mode !== 'os-store' || credentials.migrationPending || credentials.cleanupPending;
  return {
    credentials,
    settings,
    nativeEffects: {
      startup: 'not-installed',
      tray: 'not-installed',
      backgroundPolicy: 'not-applied',
    } as const,
    connections: blocked ? [] : servers(root).map(connectionSummary),
    pending: blocked
      ? []
      : pendingEnrollments(root).map((item) => ({
          url: item.url,
          alias: item.alias,
          deviceId: item.deviceId,
          deviceName: item.name,
          expiresAtMs: item.expiresAtMs,
          status: Date.now() >= item.expiresAtMs ? 'expired' : (item.status ?? 'pending'),
          verificationCode: enrollmentVerificationCode(item.deviceId, item.fingerprint),
        })),
    status: blocked ? null : clientStatus(root),
  };
}
export function requireDesktopCredentials(root: string): void {
  const decision = credentialDecision(root);
  if (decision.migrationPending)
    throw new ClientError('CREDENTIAL_MIGRATION_PENDING', 'Resume credential migration first.');
  if (decision.cleanupPending)
    throw new ClientError('CREDENTIAL_CLEANUP_PENDING', 'Resume credential cleanup first.');
  if (decision.mode !== 'os-store')
    throw new ClientError(
      'CREDENTIAL_DECISION_REQUIRED',
      'Choose OS storage or continue using the CLI.',
    );
}
export async function vaultKeyStatus(
  root: string,
  serverId: string,
  vaultId: string,
  options: CredentialOptions = {},
) {
  const info = server(root, serverId);
  const vaults = await listRemoteVaults(root, info, options);
  if (!vaults.some((item) => item.vaultId === vaultId))
    throw new ClientError('NOT_FOUND', 'Choose an available vault.');
  const credentialWritePending = keyWritePending(root, info.serverId, vaultId);
  if (credentialWritePending) return { keyRequired: false, credentialWritePending: true };
  const stored = await key(root, info.serverId, vaultId, options);
  if (!stored) return { keyRequired: true, credentialWritePending: false };
  stored.fill(0);
  return { keyRequired: false, credentialWritePending: false };
}
export type OnboardingSnapshot = ReturnType<typeof onboardingSnapshot>;
