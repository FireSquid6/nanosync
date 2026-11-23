import { expect, test } from 'bun:test';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionSetup } from '../../../../packages/client-service/src/connection-setup.ts';
import { ClientService } from '../../../../packages/client-service/src/service.ts';
import { records } from '../../../../packages/client-service/src/connections.ts';
import { initializeServerOwner, runServer } from '../../../../packages/cli/src/server.ts';
import { provisionLocalVault } from '../../../../packages/cli/src/local-provision.ts';
import { main } from '../../../../packages/cli/src/main.ts';
import { createClientRequests } from './client-rpc.ts';

async function port() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, '127.0.0.1', resolve));
  const address = listener.address();
  if (!address || typeof address === 'string') throw new Error('No port');
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}

test('native onboarding connects a real server and vault, shares CLI state, and transfers only after explicit sync', async () => {
  const paths = Array.from({ length: 3 }, () => mkdtempSync(join(tmpdir(), 'nanosync-native-onboarding-')));
  const [serverRoot, clientRoot, folder] = paths as [string, string, string];
  writeFileSync(join(serverRoot, 'pepper.hex'), 'a'.repeat(64), { mode: 0o600 });
  writeFileSync(join(folder, 'local.txt'), 'preserved local document');
  const password = 'native-onboarding-owner-password';
  let recoveryKey = '';
  await initializeServerOwner(serverRoot, password);
  await provisionLocalVault(serverRoot, 'documents', async key => { recoveryKey = key; });
  const server = await runServer({ directory: serverRoot, port: await port(), scanIntervalMs: 3_600_000 });
  const secrets = new Map<string, string>();
  const credentialStore = { get: (id: string) => secrets.get(id) ?? null, set: (id: string, value: string) => { secrets.set(id, value); }, delete: (id: string) => { secrets.delete(id); } };
  const service = new ClientService(clientRoot, { owner: 'Desktop', credentialStore });
  try {
    let setup = new ConnectionSetup(clientRoot, { credentialStore });
    const actions = () => createClientRequests({ service, setup, chooseFolder: async () => folder, openExternal: () => { throw new Error('No advertised administration link'); }, quit: async () => { await service.stop(); return { ok: true, value: null }; }, stopping: () => false, publish: () => {} });
    let request = actions();
    const submitted = await request('enroll', { url: server.url, alias: 'home', deviceName: 'desktop', password });
    expect(submitted.ok).toBe(true);
    if (!submitted.ok || !submitted.value || typeof submitted.value !== 'object' || !('id' in submitted.value)) throw new Error('Enrollment not returned');
    const enrollmentId = (submitted.value as { id: string }).id;
    const pending = setup.pending().find(item => item.id === enrollmentId)!;
    expect(pending.status).toBe('pending');
    expect(pending.verificationCode).not.toBe('');
    expect(JSON.stringify(pending)).not.toContain(password);
    expect(records(clientRoot)).toEqual([]);
    const metadata = JSON.parse(readFileSync(join(clientRoot, 'desktop-pending', `${enrollmentId}.json`), 'utf8'));
    expect(metadata.token).toBeUndefined();
    expect(await request('openAdministration', { id: enrollmentId })).toMatchObject({ ok: false });
    // A new backend instance resumes the exact durable identity; no password is supplied.
    setup = new ConnectionSetup(clientRoot, { credentialStore });
    request = actions();
    expect(setup.pending()[0]?.id).toBe(enrollmentId);
    expect(await main(['server', 'devices', 'approve', '--device-id', metadata.deviceId, '--server-dir', serverRoot])).toBe(0);
    expect(await request('checkEnrollment', { id: enrollmentId })).toMatchObject({ ok: true, value: { id: enrollmentId, status: 'approved' } });
    const listed = await request('listVaults', { id: enrollmentId });
    if (!listed.ok || !Array.isArray(listed.value)) throw new Error('Vaults unavailable');
    const vault = listed.value[0] as { id: string; needsRecoveryKey: boolean };
    expect(vault.needsRecoveryKey).toBe(true);
    expect(await request('chooseFolder', undefined)).toEqual({ ok: true, value: folder });
    const input = { serverId: enrollmentId, vaultId: vault.id, path: folder, recoveryKey, confirmNonempty: false };
    expect(await request('connectFolder', input)).toMatchObject({ ok: false });
    expect(records(clientRoot)).toEqual([]);
    const connected = await request('connectFolder', { ...input, confirmNonempty: true });
    if (!connected.ok || !connected.value || typeof connected.value !== 'object' || !('id' in connected.value)) throw new Error('Binding unavailable');
    const bindingId = (connected.value as { id: string }).id;
    expect(records(clientRoot).map(binding => binding.connectionId)).toEqual([bindingId]);
    expect(existsSync(join(clientRoot, 'replicas', bindingId, 'local.sqlite'))).toBe(false);
    expect(readFileSync(join(folder, 'local.txt'), 'utf8')).toBe('preserved local document');
    expect((await service.snapshot()).folders[0]?.status).toBe('Not checked');
    expect(await request('sync', { id: bindingId })).toEqual({ ok: true, value: null });
    expect((await service.snapshot()).folders[0]).toMatchObject({ status: 'Up to date', owner: 'Desktop' });
    expect(readFileSync(join(folder, 'local.txt'), 'utf8')).toBe('preserved local document');
    for (const directory of ['servers', 'desktop-pending', 'keys']) {
      const root = join(clientRoot, directory);
      if (!existsSync(root)) continue;
      for (const file of readdirSync(root)) {
        const text = readFileSync(join(root, file), 'utf8');
        expect(text).not.toContain(password);
        expect(text).not.toContain(recoveryKey);
        expect(text).not.toContain('"token"');
        expect(text).not.toContain('"masterKey"');
      }
    }
  } finally {
    await service.stop(); await server.stop();
    for (const path of paths) rmSync(path, { recursive: true, force: true });
  }
});
