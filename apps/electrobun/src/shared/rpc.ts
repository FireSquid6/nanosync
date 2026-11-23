import type { EnrollmentSummary, VaultSummary } from '../../../../packages/client-service/src/connection-setup.ts';
export type { EnrollmentSummary, VaultSummary } from '../../../../packages/client-service/src/connection-setup.ts';
import type { ClientSnapshot } from '../../../../packages/client-service/src/service.ts';
export type { ClientSnapshot, FolderSummary, ServerSummary } from '../../../../packages/client-service/src/service.ts';

export type Result<T = null> = { ok: true; value: T } | { ok: false; error: string };
export type DesktopRPC = {
  bun: {
    requests: {
      listEnrollments: { params: undefined; response: Result<EnrollmentSummary[]> };
      enroll: { params: { url: string; alias: string; deviceName: string; password?: string; fresh?: boolean }; response: Result<EnrollmentSummary> };
      checkEnrollment: { params: { id: string }; response: Result<EnrollmentSummary> };
      listVaults: { params: { id: string }; response: Result<VaultSummary[]> };
      connectFolder: { params: { serverId: string; vaultId: string; path: string; recoveryKey?: string; confirmNonempty: boolean }; response: Result<{ id: string }> };
      chooseFolder: { params: undefined; response: Result<string | null> };
      openAdministration: { params: { id: string }; response: Result };
      snapshot: { params: undefined; response: Result<ClientSnapshot> };
      sync: { params: { id: string }; response: Result };
      migrate: { params: { id: string }; response: Result };
      quit: { params: undefined; response: Result };
    };
    messages: {};
  };
  webview: { requests: {}; messages: { snapshotChanged: ClientSnapshot } };
};

export function validIdRequest(value: unknown): value is { id: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = Object.keys(value);
  return fields.length === 1 && fields[0] === 'id' && 'id' in value &&
    typeof value.id === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i.test(value.id);
}
