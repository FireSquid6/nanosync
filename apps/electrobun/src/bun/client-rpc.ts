import type { ClientService } from '../../../../packages/client-service/src/service.ts';
import type { ConnectionSetup } from '../../../../packages/client-service/src/connection-setup.ts';
import { validIdRequest } from '../shared/rpc.ts';
import type { ClientSnapshot, Result } from '../shared/rpc.ts';

type Dependencies = {
  service: Pick<ClientService, 'snapshot' | 'sync' | 'migrate'>;
  setup: Pick<ConnectionSetup, 'pending' | 'enroll' | 'check' | 'vaults' | 'connect'>;
  chooseFolder(): Promise<string | null>;
  openExternal(url: string): boolean;
  quit(): Promise<Result>;
  stopping(): boolean;
  publish(snapshot: ClientSnapshot): void;
};
function fields(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    required.every(key => Object.hasOwn(value, key)) &&
    Object.keys(value).every(key => required.includes(key) || optional.includes(key));
}
const text = (value: unknown, max: number) => typeof value === 'string' && value.length > 0 && value.length <= max && !value.includes('\0');
const optionalText = (value: unknown, max: number) => value === undefined || typeof value === 'string' && value.length <= max && !value.includes('\0');
const id = (value: unknown) => validIdRequest({ id: value });
export function setupError(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  const messages: Record<string, string> = {
    CREDENTIAL_STORE_LOCKED: 'Unlock the OS credential store and retry. No protected-file fallback was used.',
    CREDENTIALS_REQUIRED: 'Choose credential migration in Connections before continuing.',
    PASSWORD_REQUIRED: 'Retry enrollment and enter the account password again to resume this request.',
    INVALID_INPUT: 'Check the connection name, device name and selected folder, then retry.',
    INVALID_SERVER_URL: 'Enter a valid HTTPS server URL. HTTP is allowed only for loopback servers.',
    AUTHENTICATION_FAILED: 'The server rejected the password. Check it and retry.',
    ENROLLMENT_CONFLICT: 'A connection or enrollment already uses this URL or alias. Select the connection or resume the original request.',
    NOT_FOUND: 'The connection or vault no longer exists. Refresh and select it again.',
    RECOVERY_KEY_REQUIRED: 'Enter the vault recovery key to connect this local copy.',
    INVALID_RECOVERY_KEY: 'The recovery key could not unlock this vault. Check the key and selected vault.',
    FOLDER_UNAVAILABLE: 'Choose an existing, owned directory without symbolic links.',
    NONEMPTY_CONFIRMATION_REQUIRED: 'Confirm that existing folder contents will be reconciled.',
    OVERLAPPING_ROOT: 'This folder overlaps an existing local copy or private client state. Choose a separate directory.',
    CONFLICT: 'The folder or connection is in use or has changed. Refresh and check its active owner.',
  };
  return typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code]! : 'Operation failed. Check the server, credentials and selected folder, then retry.';
}
function administrationUrl(value: string): string {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/admin' ||
    !(url.protocol === 'https:' || url.protocol === 'http:' && loopback)) throw new Error('Unsafe administration URL');
  return url.href;
}

/** The client root and external administration URLs are never supplied by the webview. */
export function createClientRequests(deps: Dependencies) {
  return async (method: string, params: unknown) => {
    const invalid = { ok: false, error: 'Invalid request.' } as const;
    if (method === 'quit') return params === undefined ? deps.quit() : invalid;
    if (deps.stopping()) return { ok: false, error: 'Desktop sync is stopping.' } as const;
    try {
      switch (method) {
        case 'snapshot':
          if (params !== undefined) return invalid;
          return { ok: true, value: await deps.service.snapshot() } as const;
        case 'listEnrollments':
          if (params !== undefined) return invalid;
          return { ok: true, value: deps.setup.pending() } as const;
        case 'chooseFolder':
          if (params !== undefined) return invalid;
          return { ok: true, value: await deps.chooseFolder() } as const;
        case 'enroll': {
          if (!fields(params, ['url', 'alias', 'deviceName'], ['password', 'fresh']) ||
            !text(params.url, 2048) || !text(params.alias, 128) || !text(params.deviceName, 128) ||
            !optionalText(params.password, 4096) || !(params.fresh === undefined || typeof params.fresh === 'boolean')) return invalid;
          const value = await deps.setup.enroll({ url: params.url as string, alias: params.alias as string,
            deviceName: params.deviceName as string, password: params.password as string | undefined, fresh: params.fresh as boolean | undefined });
          deps.publish(await deps.service.snapshot());
          return { ok: true, value } as const;
        }
        case 'connectFolder': {
          if (!fields(params, ['serverId', 'vaultId', 'path', 'confirmNonempty'], ['recoveryKey']) ||
            !id(params.serverId) || !id(params.vaultId) || !text(params.path, 4096) ||
            typeof params.confirmNonempty !== 'boolean' || !optionalText(params.recoveryKey, 4096)) return invalid;
          const value = await deps.setup.connect({ serverId: params.serverId as string, vaultId: params.vaultId as string,
            path: params.path as string, confirmNonempty: params.confirmNonempty, recoveryKey: params.recoveryKey as string | undefined });
          deps.publish(await deps.service.snapshot());
          return { ok: true, value } as const;
        }
        case 'checkEnrollment':
        case 'listVaults':
        case 'openAdministration':
        case 'sync':
        case 'migrate': {
          if (!validIdRequest(params)) return invalid;
          if (method === 'checkEnrollment') {
            const value = await deps.setup.check(params.id);
            deps.publish(await deps.service.snapshot());
            return { ok: true, value } as const;
          }
          if (method === 'listVaults') return { ok: true, value: await deps.setup.vaults(params.id) } as const;
          if (method === 'openAdministration') {
            const enrollment = deps.setup.pending().find(item => item.id === params.id);
            if (!enrollment?.adminUrl) return { ok: false, error: 'No server administration URL is available. Contact the server operator.' } as const;
            if (!deps.openExternal(administrationUrl(enrollment.adminUrl))) return { ok: false, error: 'Unable to open the system browser.' } as const;
            return { ok: true, value: null } as const;
          }
          const snapshot = await deps.service.snapshot();
          const known = method === 'sync' ? snapshot.folders : snapshot.servers;
          if (!known.some(item => item.id === params.id)) return { ok: false, error: 'Item no longer exists. Refresh and try again.' } as const;
          if (method === 'sync') await deps.service.sync(params.id);
          else await deps.service.migrate(params.id);
          deps.publish(await deps.service.snapshot());
          return { ok: true, value: null } as const;
        }
        default: return { ok: false, error: 'Unsupported request.' } as const;
      }
    } catch (error) { return { ok: false, error: setupError(error) } as const; }
  };
}
