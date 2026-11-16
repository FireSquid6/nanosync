import { randomBytes } from 'node:crypto';
import { ProtocolValidationError, parseDeviceId, parseVaultId, type OwnerActor } from '@nanosync/protocol';
import { AuthenticationService, mapAuthRepositoryError } from './auth-service.ts';
import { ApiError, json, readStrictJson } from './http.ts';
import { isLoopback, type ServerConfig } from './config.ts';
import type { OwnerOperations } from './owner-operations.ts';

export interface AdminAsset { body: string | Uint8Array; contentType: string; }
export type AdminAssets = Readonly<Record<string, AdminAsset>>;
interface Session { csrf: string; created: number; touched: number; }
const cookieName = 'nanosync_admin';
const forbidden = () => new ApiError(403, 'FORBIDDEN', 'Browser origin, transport or CSRF validation failed');
const unauthorized = () => new ApiError(401, 'UNAUTHORIZED', 'Browser login is required');
const malformed = () => new ApiError(400, 'MALFORMED_REQUEST', 'Invalid administration request');

/** One instance per serving runtime; no durable sessions or bearer-token fallback. */
export class BrowserAdministration {
  private readonly sessions = new Map<string, Session>();
  private attempts: number[] = [];
  constructor(private readonly config: ServerConfig, private readonly auth: AuthenticationService,
    private readonly owner: OwnerOperations, private readonly clock: () => number,
    private readonly assets: AdminAssets = {}) {}

  origin(request: Request, trustedProxy = false): string {
    const url = new URL(request.url);
    if (trustedProxy && this.config.externalOrigin) return this.config.externalOrigin;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname) && isLoopback(this.config.hostname))) throw forbidden();
    if (this.config.externalOrigin && url.origin !== this.config.externalOrigin) throw forbidden();
    return url.origin;
  }
  async handle(request: Request, trustedProxy = false): Promise<Response> {
    try {
      const url = new URL(request.url), path = url.pathname;
      const origin = this.origin(request, trustedProxy), secure = origin.startsWith('https:');
      const now = this.clock();
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('Invalid clock');
      for (const [id, session] of this.sessions) if (now - session.touched >= 1_800_000 || now - session.created >= 43_200_000) this.sessions.delete(id);
      if (request.headers.has('authorization')) throw unauthorized();
      if (request.headers.get('origin') !== null && request.headers.get('origin') !== origin) throw forbidden();
      const mutation = !['GET', 'HEAD'].includes(request.method);
      if (mutation && (request.headers.get('origin') !== origin || !request.headers.get('x-nanosync-csrf'))) throw forbidden();
      if (!path.startsWith('/admin/api/')) {
        if (request.method !== 'GET') throw new ApiError(405, 'MALFORMED_REQUEST', 'Method not supported');
        const asset = this.assets[path];
        if (!asset) throw new ApiError(404, 'NOT_FOUND', 'Route not found');
        return new Response(typeof asset.body === "string" ? asset.body : Uint8Array.from(asset.body).buffer, { headers: { 'content-type': asset.contentType, 'cache-control':'no-store', 'x-content-type-options':'nosniff', 'content-security-policy':"default-src 'self'; frame-ancestors 'none'; base-uri 'none'" } });
      }
      if (url.search && path !== '/admin/api/activity') throw malformed();
      if (path === '/admin/api/session' && request.method === 'POST') {
        const input = await body(request, ['password']);
        await this.password(input.password);
        if (this.sessions.size >= 1000) throw new ApiError(429, 'RATE_LIMITED', 'Too many browser sessions');
        const id = token(), csrf = token();
        this.sessions.set(id, { csrf, created: now, touched: now });
        return this.result({ authenticated: true, csrfToken: csrf }, { 'set-cookie': cookie(id, secure) });
      }
      const cookies = (request.headers.get('cookie') ?? '').split(';').map(v => v.trim()).filter(v => v.startsWith(cookieName + '='));
      const id = cookies.length === 1 ? cookies[0]!.slice(cookieName.length + 1) : '';
      const session = this.sessions.get(id);
      if (!session) throw unauthorized();
      if (mutation && request.headers.get('x-nanosync-csrf') !== session.csrf) throw forbidden();
      session.touched = now;
      const actor: OwnerActor = { origin: 'browser', actorId: null };
      if (path === '/admin/api/session' && request.method === 'GET') return this.result({ authenticated: true, csrfToken: session.csrf });
      if (path === '/admin/api/session' && request.method === 'DELETE') {
        this.sessions.delete(id); return this.result({ authenticated: false }, { 'set-cookie': cookie('', secure) + '; Max-Age=0' });
      }
      if (path === '/admin/api/devices' && request.method === 'GET') return this.result({ devices: this.owner.devices(actor), enrollments: this.owner.pending(actor) });
      const device = /^\/admin\/api\/devices\/([^/]+)\/(approve|deny|revoke)$/.exec(path);
      if (device && request.method === 'POST') {
        await body(request, []);
        const deviceId = parseDeviceId(device[1]);
        if (device[2] === 'revoke') this.owner.revoke(actor, deviceId);
        else this.owner.decideEnrollment(actor, { protocolVersion: 1, deviceId, decision: device[2] });
        return this.result({ status: device[2] });
      }
      if (path === '/admin/api/vaults' && request.method === 'GET') return this.result({ vaults: this.owner.listVaults(actor) });
      if (path === '/admin/api/vaults' && request.method === 'POST') {
        requireJson(request);
        return this.result(await this.owner.createVault(actor, await readStrictJson(request, 16_384)));
      }
      const vault = /^\/admin\/api\/vaults\/([^/]+)\/(rename|delete)$/.exec(path);
      if (vault && request.method === 'POST') {
        const vaultId = parseVaultId(vault[1]);
        if (vault[2] === 'rename') { const input = await body(request, ['name']); this.owner.renameVault(actor, vaultId, input.name as string); }
        else {
          const input = await body(request, ['confirmName', 'password']);
          await this.password(input.password);
          const current = this.owner.listVaults(actor).find(v => v.vaultId === vaultId);
          if (!current) throw new ApiError(404, 'NOT_FOUND', 'Vault not found');
          if (input.confirmName !== current.name) throw new ApiError(409, 'CONFLICT', 'Exact vault name confirmation required');
          this.owner.markVaultDeleted(actor, vaultId);
        }
        return this.result({ vaultId });
      }
      if (path === '/admin/api/activity' && request.method === 'GET') {
        if ([...url.searchParams.keys()].some(k => k !== 'limit') || url.searchParams.getAll('limit').length > 1) throw malformed();
        const raw = url.searchParams.get('limit') ?? '100';
        if (!/^(?:[1-9]|[1-9][0-9]|100)$/.test(raw)) throw malformed();
        return this.result({ activity: this.owner.recentActivity(actor, Number(raw)) });
      }
      throw new ApiError(404, 'NOT_FOUND', 'Route not found');
    } catch (error) {
      if (error instanceof ProtocolValidationError || error instanceof TypeError) throw malformed();
      if (error instanceof Error) {
        if (error.message === 'vault ID is deleted') throw new ApiError(410, 'VAULT_DELETED', 'Vault is permanently deleted');
        if (error.message === 'vault not found') throw new ApiError(404, 'NOT_FOUND', 'Vault not found');
        if (/^vault (?:ID|name) already in use/.test(error.message)) throw new ApiError(409, 'CONFLICT', 'Vault identity or name conflicts');
        if (['invalid vault name', 'invalid vault genesis', 'invalid recovery wrap', 'Invalid genesis frame checksum', 'Owner genesis requires reserved owner author'].includes(error.message)) throw malformed();
      }
      mapAuthRepositoryError(error);
    }
  }
  private async password(value: unknown): Promise<void> {
    if (typeof value !== 'string' || Buffer.byteLength(value) < 1 || Buffer.byteLength(value) > 1024) throw malformed();
    const now = this.clock();
    this.attempts = this.attempts.filter(t => now - t < 60_000);
    if (this.attempts.length >= 5) throw new ApiError(429, 'RATE_LIMITED', 'Password verification rate limited', { 'retry-after':'60' }, 60);
    this.attempts.push(now); // Reserve before awaiting expensive password verification.
    await this.auth.verifyOwnerPassword(value);
  }
  private result(value: object, headers?: Record<string, string>): Response { return json({ protocolVersion: 1, ...value }, 200, { ...headers, 'cache-control':'no-store', 'x-content-type-options':'nosniff' }); }
}
function token(): string { return randomBytes(32).toString('base64url'); }
function cookie(id: string, secure: boolean): string { return `${cookieName}=${id}; HttpOnly; SameSite=Strict; Path=/admin${secure ? '; Secure' : ''}`; }
function requireJson(request: Request): void { if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') ?? '')) throw malformed(); }
async function body(request: Request, fields: string[]): Promise<Record<string, unknown>> {
  requireJson(request); const input = await readStrictJson(request, 4096);
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== [...fields].sort().join()) throw malformed();
  return input as Record<string, unknown>;
}
