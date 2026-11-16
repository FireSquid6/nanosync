import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AuthenticationRepository, BootstrapRepository, ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase, VaultRepository } from '@nanosync/server-metadata';
import { LocalFilesystem } from '@nanosync/server-object-storage';
import { AuthenticationService, OwnerOperations, createServerConfig, createServerHandler, type ServerConfigInput } from '../src/index.ts';

const origin = 'http://127.0.0.1:7337';
function req(path: string, method = 'GET', body?: unknown, headers: Record<string,string> = {}, base = origin) {
 return new Request(base + path, { method, headers: { origin: base, ...(body ? { 'content-type':'application/json' } : {}), ...headers }, ...(body ? { body:JSON.stringify(body) } : {}) });
}
async function fixture(verify: (bytes: Uint8Array) => Promise<boolean> = async b => new TextDecoder().decode(b) === 'correct') {
 const root = await mkdtemp(join(tmpdir(), 'browser-')); const db = new ServerMetadataDatabase(':memory:');
 const record = { algorithm: 'argon2id' as const, version: 19 as const, memoryKiB:65536, iterations:3, parallelism:1, salt:new Uint8Array(16), hash:new Uint8Array(32) };
 new BootstrapRepository(db).initializeOwner('123e4567-e89b-42d3-a456-426614174000' as any, record, 1);
 const filesystem = new LocalFilesystem(root); await filesystem.existsBatch([]); let now = 10, peer: string | null = null;
 const repository = new AuthenticationRepository(db);
 const authentication = new AuthenticationService(repository, { pepper:new Uint8Array(32), password: { hash:async () => record, verify }, clock:() => now });
 const owner = new OwnerOperations(db, filesystem, () => now);
 const make = (config: ServerConfigInput = {webUi:true}) => createServerHandler({ filesystem, authentication, catalog:new ObjectCatalogRepository(db), revisions:new RevisionRepository(db), vaults:new VaultRepository(db), owner, clock:() => now, peerAddress:() => peer,
   adminAssets: { '/admin': {body:'<h1>Admin</h1>',contentType:'text/html'} }, config:createServerConfig(config, () => {}) });
 const handle = make();
 const login = async (handler = handle, base = origin) => {
  const response = await handler(req('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'},base));
  expect(response.status).toBe(200); const cookie = response.headers.get('set-cookie')!;
  const { csrfToken } = await response.json() as any;
  return { cookie:cookie.split(';')[0]!, 'x-nanosync-csrf':csrfToken as string };
 };
 return { db, make, handle, login, repository, owner, setNow:(n:number) => {now=n;}, setPeer:(s:string) => {peer=s;}, close:async () => {db.close(); await rm(root,{recursive:true,force:true});} };
}

test('browser routes are opt-in; login CSRF, cookies, logout, idle/absolute expiry and restart', async () => {
 const f = await fixture();
 try {
 const disabled = f.make({webUi:false});
 for (const path of ['/admin','/admin/app.js','/admin/api/session','/admin/api/devices','/admin/api/vaults','/admin/api/activity']) {
  for (const method of ['GET','POST','DELETE']) expect((await disabled(req(path,method))).status).toBe(404);
 }
 expect((await f.handle(req('/admin'))).status).toBe(200);
 expect((await f.handle(req('/admin/api/session','POST',{password:'correct'},{origin:'https://evil.test','x-nanosync-csrf':'login'}))).status).toBe(403);
 expect((await f.handle(req('/admin/api/session','POST',{password:'correct'}))).status).toBe(403);
 expect((await f.handle(req('/admin/api/session','POST',{password:'correct'},{origin:'null','x-nanosync-csrf':'login'}))).status).toBe(403);
 const response = await f.handle(req('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'}));
 const cookie = response.headers.get('set-cookie')!;
 expect(cookie).toContain('HttpOnly'); expect(cookie).toContain('SameSite=Strict'); expect(cookie).toContain('Path=/admin'); expect(cookie).not.toMatch(/Max-Age|Expires|Secure/);
 expect(response.headers.get('cache-control')).toBe('no-store');
 const {csrfToken} = await response.json() as any;
 const headers = {cookie:cookie.split(';')[0]!, 'x-nanosync-csrf':csrfToken};
 expect((await f.handle(req('/admin/api/session','DELETE',undefined,{...headers,'x-nanosync-csrf':'wrong'}))).status).toBe(403);
 expect((await f.make()(req('/admin/api/session','GET',undefined,headers))).status).toBe(401);
 expect((await f.handle(req('/admin/api/session','DELETE',undefined,headers))).headers.get('set-cookie')).toContain('Max-Age=0');
 expect((await f.handle(req('/admin/api/session','GET',undefined,headers))).status).toBe(401);
 const idle = await f.login(); f.setNow(1_800_010);
 expect((await f.handle(req('/admin/api/session','GET',undefined,idle))).status).toBe(401);
 const absolute = await f.login();
 for (let i=1;i<48;i++) { f.setNow(1_800_010+i*900_000); expect((await f.handle(req('/admin/api/session','GET',undefined,absolute))).status).toBe(200); }
 f.setNow(1_800_010+43_200_000);
 expect((await f.handle(req('/admin/api/session','GET',undefined,absolute))).status).toBe(401);
 } finally {await f.close();}
});

test('browser authority never authorizes sync, provisioning, enrollment or device APIs and vice versa', async () => {
 const f = await fixture();
 try {
 const headers = await f.login();
 for (const path of ['/v1/head','/v1/objects','/v1/vaults','/v1/recovery-wrap','/v1/admin/devices','/v1/auth/enrollments/status']) expect((await f.handle(req(path,'GET',undefined,headers))).status).toBe(401);
 const login = await f.handle(req('/v1/auth/password','POST',{protocolVersion:1,password:'correct'}));
 const { sessionToken } = await login.json() as any;
 for (const path of ['/admin/api/session','/admin/api/devices','/admin/api/vaults','/admin/api/activity']) expect((await f.handle(req(path,'GET',undefined,{authorization:`Bearer ${sessionToken}`}))).status).toBe(401);
 expect(f.db.get<{count:number}>('SELECT count(*) AS count FROM password_sessions')!.count).toBe(1); // Browser login minted none.
 const id = '223e4567-e89b-42d3-a456-426614174000';
 expect((await f.handle(req('/v1/auth/enrollments','POST',{protocolVersion:1,deviceId:id,displayName:'Phone',platform:'linux',clientVersion:'1',fingerprint:Buffer.alloc(32).toString('base64url')},{authorization:`Bearer ${sessionToken}`}))).status).toBe(202);
 const devices = await (await f.handle(req('/admin/api/devices','GET',undefined,headers))).json() as any;
 expect(devices.enrollments[0].verificationCode).toBeDefined();
 expect((await f.handle(req(`/admin/api/devices/${id}/approve`,'POST',{},headers))).status).toBe(200);
 expect((await f.handle(req('/admin/api/devices','GET',undefined,{authorization:`Bearer ${sessionToken}`}))).status).toBe(401);
 expect((await f.handle(req('/v1/vaults','POST',{}, {authorization:`Bearer ${sessionToken}`}))).status).toBe(404);
 expect((await f.handle(req(`/v1/vaults/${id}/rename`,'POST',{name:'bad'}, {authorization:`Bearer ${sessionToken}`}))).status).toBe(404);
 expect((await f.handle(req('/v1/vaults','GET',undefined,{authorization:`Bearer ${sessionToken}`}))).status).toBe(200);
 expect((await f.handle(req(`/admin/api/devices/${id}/revoke`,'POST',{},headers))).status).toBe(200);
 expect((await f.handle(req('/v1/vaults','GET',undefined,{authorization:`Bearer ${sessionToken}`}))).status).toBe(401);
 const denied = await f.handle(req('/v1/auth/password','POST',{protocolVersion:1,password:'correct'})); const token = (await denied.json() as any).sessionToken;
 const secondId = '323e4567-e89b-42d3-a456-426614174000';
 await f.handle(req('/v1/auth/enrollments','POST',{protocolVersion:1,deviceId:secondId,displayName:'Tablet',platform:'linux',clientVersion:'1',fingerprint:Buffer.alloc(32,1).toString('base64url')},{authorization:`Bearer ${token}`}));
 expect((await f.handle(req(`/admin/api/devices/${secondId}/deny`,'POST',{},headers))).status).toBe(200);
 expect((await (await f.handle(req('/v1/auth/enrollments/status','GET',undefined,{authorization:`Bearer ${token}`}))).json() as any).status).toBe('denied');
 const activity = await (await f.handle(req('/admin/api/activity?limit=2','GET',undefined,headers))).json() as any;
 expect(activity.activity).toHaveLength(2); expect(activity.activity.every((a:any) => a.origin === 'browser')).toBe(true);
 for (const query of ['limit=101','limit=0','limit=1&limit=2','secret=x']) expect((await f.handle(req('/admin/api/activity?'+query,'GET',undefined,headers))).status).toBe(400);
 } finally {await f.close();}
});

test('only explicit HTTPS origin plus exact trusted peer establishes proxy security; capability links never trust Host', async () => {
 const f = await fixture();
 try {
 const remote = f.make({webUi:true,hostname:'0.0.0.0',acknowledgeInsecureNonLoopback:true});
 expect((await remote(req('/admin','GET',undefined,{'x-forwarded-proto':'https',forwarded:'proto=https'},'http://example.test'))).status).toBe(403);
 expect((await remote(req('/admin','GET',undefined,{},origin))).status).toBe(403);
 const config = {webUi:true,externalOrigin:'https://sync.example',trustedProxyAddresses:['127.0.0.1']};
 const proxy = f.make(config);
 expect((await proxy(req('/admin','GET',undefined,{origin:'https://sync.example'},'http://internal'))).status).toBe(403);
 f.setPeer('127.0.0.1');
 const request = (path:string, method='GET', body?:unknown, headers:Record<string,string>={}) => req(path,method,body,{...headers,origin:'https://sync.example','x-forwarded-proto':'http','x-forwarded-host':'evil.test'},'http://internal');
 expect((await proxy(request('/admin'))).status).toBe(200);
 const login = await proxy(request('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'}));
 expect(login.headers.get('set-cookie')).toContain('; Secure');
 const cap = await (await proxy(req('/v1/capabilities','GET',undefined,{},'http://attacker.test'))).json() as any;
 expect(cap.webAdministration).toEqual({enabled:true,url:'https://sync.example/admin'});
 expect((await (await f.handle(req('/v1/capabilities'))).json() as any).webAdministration).toEqual({enabled:true});
 expect((await (await f.make({})(req('/v1/capabilities'))).json() as any).webAdministration).toEqual({enabled:false});
 expect(() => createServerConfig({externalOrigin:'http://public.test'})).toThrow();
 expect(() => createServerConfig({externalOrigin:'https://public.test/path'})).toThrow();
 expect(() => createServerConfig({externalOrigin:origin,trustedProxyAddresses:['127.0.0.1']})).toThrow();
 expect(() => createServerConfig({externalOrigin:'https://public.test',trustedProxyAddresses:['*']})).toThrow();
 } finally {await f.close();}
});

test('password login and deletion reauthentication are rate limited before expensive verification', async () => {
 const f = await fixture();
 try {
 const headers = await f.login();
 const id = '223e4567-e89b-42d3-a456-426614174000';
 for (let i=0;i<4;i++) expect((await f.handle(req(`/admin/api/vaults/${id}/delete`,'POST',{confirmName:'missing',password:'wrong'},headers))).status).toBe(401);
 const limited = await f.handle(req('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'}));
 expect(limited.status).toBe(429); expect(limited.headers.get('retry-after')).toBe('60');
 f.setNow(60_010);
 expect((await f.handle(req('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'}))).status).toBe(200);
 expect((await f.handle(req('/admin/api/vaults','POST',{plaintextKey:'forbidden'},headers))).status).toBe(400);
 } finally {await f.close();}
});


test('parallel browser password attempts cannot queue unbounded verifier work', async () => {
 let release!: () => void, entered = 0;
 const gate = new Promise<void>(resolve => {release=resolve;});
 const f = await fixture(async () => {entered++; await gate; return false;});
 try {
  const attempt = () => f.handle(req('/admin/api/session','POST',{password:'wrong'},{'x-nanosync-csrf':'login'}));
  const pending = Array.from({length:5}, attempt);
  // Let streaming JSON readers reach the injected async verification boundary.
  while (entered < 2) await Bun.sleep(1);
  expect((await attempt()).status).toBe(429);
  expect(entered).toBe(2);
  release();
  expect((await Promise.all(pending)).map(r => r.status).sort()).toEqual([401,401,429,429,429]);
  // Rejected overload does not count as a failed password. Advance both rolling
  // admission buckets, then establish the persistent lockout with three failures.
  f.setNow(60_010);
  for (let i=0;i<3;i++) expect((await attempt()).status).toBe(i === 2 ? 429 : 401);
  f.setNow(120_010);
  // Persistent account lockout survives a fresh handler and the memory bucket window.
  expect((await f.make()(req('/admin/api/session','POST',{password:'correct'},{'x-nanosync-csrf':'login'}))).status).toBe(429);
  expect(entered).toBe(5);
 } finally {release(); await f.close();}
});
