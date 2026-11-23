import type { ClientSnapshot } from '../../../../packages/client-service/src/service.ts';
export type { ClientSnapshot, FolderSummary, ServerSummary } from '../../../../packages/client-service/src/service.ts';

export type Result<T = null> = { ok: true; value: T } | { ok: false; error: string };
export type DesktopRPC = {
  bun: {
    requests: {
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
