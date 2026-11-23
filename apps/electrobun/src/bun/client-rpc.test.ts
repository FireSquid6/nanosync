import { expect, mock, test } from 'bun:test';
import { createClientRequests, setupError } from './client-rpc.ts';
import type { ClientSnapshot } from '../shared/rpc.ts';
import type { EnrollmentSummary } from '../../../../packages/client-service/src/connection-setup.ts';

const id = '12345678-1234-4234-8234-123456789abc';
function fixture() {
  const enrollment: EnrollmentSummary = { id, url: 'https://sync.example', alias: 'home', deviceName: 'desktop', status: 'pending', verificationCode: '1234-ABCD', adminUrl: 'https://sync.example/admin', error: null };
  const snapshot: ClientSnapshot = { servers: [{ id, name: 'home', url: enrollment.url, credentialMode: 'os' }], folders: [{ id, name: 'Documents', path: '/home/user/Documents', serverId: id, serverName: 'home', vaultId: id, status: 'Not checked', owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 }] };
  const service = { snapshot: mock(async () => snapshot), sync: mock(async () => ({ revisionId: id, sequence: 1 })), migrate: mock(async () => {}) };
  const setup = { pending: mock(() => [enrollment]), enroll: mock(async () => enrollment), check: mock(async () => enrollment), vaults: mock(async () => [{ id, name: 'documents', needsRecoveryKey: true }]), connect: mock(async () => ({ id })) };
  const chooseFolder = mock(async (): Promise<string | null> => '/home/user/Documents');
  const openExternal = mock((_url: string) => true);
  const quit = mock(async () => ({ ok: true as const, value: null }));
  const publish = mock((_snapshot: ClientSnapshot) => {});
  const deps = { service, setup, chooseFolder, openExternal, quit, publish, stopping: () => false };
  return { ...deps, enrollment, handler: createClientRequests(deps) };
}

test('native connection RPC validates exact bounded parameters before touching backend or native actions', async () => {
  const f = fixture();
  const valid = { url: 'https://sync.example', alias: 'home', deviceName: 'desktop' };
  for (const params of [null, [], {}, { ...valid, root: '/tmp/other-state' }, { ...valid, password: 'x'.repeat(4097) }, { ...valid, fresh: 'yes' }, { ...valid, alias: 123 }, { ...valid, deviceName: '\0' }]) {
    expect(await f.handler('enroll', params)).toEqual({ ok: false, error: 'Invalid request.' });
  }
  for (const method of ['checkEnrollment', 'listVaults', 'openAdministration', 'sync', 'migrate']) {
    expect(await f.handler(method, { id, url: 'file:///private' })).toEqual({ ok: false, error: 'Invalid request.' });
    expect(await f.handler(method, { id: '../../private' })).toEqual({ ok: false, error: 'Invalid request.' });
  }
  for (const method of ['listEnrollments', 'chooseFolder', 'snapshot', 'quit']) {
    expect(await f.handler(method, {})).toEqual({ ok: false, error: 'Invalid request.' });
  }
  for (const params of [{ serverId: id, vaultId: id, path: '/tmp/data', confirmNonempty: 'yes' }, { serverId: id, vaultId: id, path: '/tmp/data', confirmNonempty: true, command: 'rm' }]) {
    expect(await f.handler('connectFolder', params)).toEqual({ ok: false, error: 'Invalid request.' });
  }
  expect(await f.handler('constructor', undefined)).toEqual({ ok: false, error: 'Unsupported request.' });
  expect(f.setup.enroll).not.toHaveBeenCalled();
  expect(f.setup.connect).not.toHaveBeenCalled();
  expect(f.chooseFolder).not.toHaveBeenCalled();
  expect(f.openExternal).not.toHaveBeenCalled();
});

test('connecting a folder returns the shared binding without implicitly starting sync', async () => {
  const f = fixture();
  const params = { serverId: id, vaultId: id, path: '/home/user/Documents', confirmNonempty: true, recoveryKey: 'private-recovery' };
  expect(await f.handler('connectFolder', params)).toEqual({ ok: true, value: { id } });
  expect(f.setup.connect).toHaveBeenCalledWith(params);
  expect(f.publish).toHaveBeenCalledTimes(1);
  expect(f.service.sync).not.toHaveBeenCalled();
  expect(await f.handler('sync', { id })).toEqual({ ok: true, value: null });
  expect(f.service.sync).toHaveBeenCalledWith(id);
});

test('native admin action uses only the selected advertised safe URL', async () => {
  const f = fixture();
  expect(await f.handler('openAdministration', { id })).toEqual({ ok: true, value: null });
  expect(f.openExternal).toHaveBeenCalledWith('https://sync.example/admin');
  f.openExternal.mockClear();
  for (const url of ['file:///etc/passwd', 'https://user:secret@example/admin', 'javascript:alert(1)', 'http://remote.example/admin', 'https://sync.example/admin?token=secret']) {
    f.enrollment.adminUrl = url;
    expect((await f.handler('openAdministration', { id })).ok).toBe(false);
  }
  f.enrollment.adminUrl = null;
  expect((await f.handler('openAdministration', { id })).ok).toBe(false);
  expect(f.openExternal).not.toHaveBeenCalled();
});

test('native onboarding returns metadata only and maps failures without exception text', async () => {
  const f = fixture();
  expect(await f.handler('listEnrollments', undefined)).toEqual({ ok: true, value: [f.enrollment] });
  expect(await f.handler('checkEnrollment', { id })).toEqual({ ok: true, value: f.enrollment });
  expect(await f.handler('listVaults', { id })).toEqual({ ok: true, value: [{ id, name: 'documents', needsRecoveryKey: true }] });
  expect(await f.handler('chooseFolder', undefined)).toEqual({ ok: true, value: '/home/user/Documents' });
  f.setup.enroll.mockImplementation(async () => { throw Object.assign(new Error('PASSWORD SECRET TOKEN /private/path'), { code: 'AUTHENTICATION_FAILED' }); });
  const result = await f.handler('enroll', { url: 'https://sync.example', alias: 'home', deviceName: 'desktop', password: 'PASSWORD' });
  expect(result).toEqual({ ok: false, error: 'The server rejected the password. Check it and retry.' });
  expect(JSON.stringify(result)).not.toContain('SECRET');
  expect(setupError(Object.assign(new Error('SECRET'), { code: 'constructor' }))).not.toContain('SECRET');
  expect(setupError({ code: 'PASSWORD_REQUIRED' })).toContain('account password');
  expect(setupError({ code: 'CREDENTIALS_REQUIRED' })).toContain('migration');
  const stopping = createClientRequests({ ...f, stopping: () => true });
  expect((await stopping('enroll', {})).ok).toBe(false);
  expect(await stopping('quit', undefined)).toEqual({ ok: true, value: null });
});
