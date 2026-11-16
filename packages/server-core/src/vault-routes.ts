import { VaultRepository } from '@nanosync/server-metadata';
import { AuthenticationService } from './auth-service.ts';
import { ApiError, json } from './http.ts';

/** Approved devices can discover vaults, never provision them. */
export async function handleVaultRoute(request: Request, pathname: string, auth: AuthenticationService,
  repository: VaultRepository): Promise<Response> {
  auth.authorize(request);
  if (pathname === '/v1/vaults' && request.method === 'GET') return json({ protocolVersion: 1, vaults: repository.list() });
  throw new ApiError(404, 'NOT_FOUND', 'Route not found');
}
