import { describe, expect, test } from 'bun:test';
import { escapeHTML, folderCard } from './live.ts';
import { validIdRequest } from '../shared/rpc.ts';
import type { DesktopRPC, EnrollmentSummary, VaultSummary } from '../shared/rpc.ts';

describe('desktop boundary', () => {
  test('onboarding contract exposes public summaries and connection-only parameters', () => {
    type Requests = DesktopRPC['bun']['requests'];
    const enrollment: EnrollmentSummary = { id: 'request', url: 'https://example.test', alias: 'Home', deviceName: 'Laptop', status: 'pending', verificationCode: '123-456', adminUrl: null, error: null };
    const vault: VaultSummary = { id: 'vault', name: 'Documents', needsRecoveryKey: true };
    const response: Requests['enroll']['response'] = { ok: true, value: enrollment };
    const params: Requests['connectFolder']['params'] = { serverId: enrollment.id, vaultId: vault.id, path: '/home/user/Documents', confirmNonempty: true };
    const administration: Requests['openAdministration']['params'] = { id: enrollment.id };
    expect(response.ok && response.value.status).toBe('pending');
    expect(params).not.toHaveProperty('sync');
    expect(params).not.toHaveProperty('recoveryKey');
    expect(administration).toEqual({ id: 'request' });
  });
  test('accepts only a bounded UUID and no extra request fields', () => {
    expect(validIdRequest({ id: '12345678-1234-1234-1234-123456789abc' })).toBe(true);
    for (const value of [null, {}, { id: '../secret' }, { id: 'a'.repeat(10000) }, { id: '12345678-1234-1234-1234-123456789abc', root: '/tmp' }]) {
      expect(validIdRequest(value)).toBe(false);
    }
  });
  test('escapes text and attributes in folder cards', () => {
    expect(escapeHTML('<img src="x">&\'')).toBe('&lt;img src=&quot;x&quot;&gt;&amp;&#39;');
    const html = folderCard({ id: 'id', name: '<script>alert(1)</script>', path: '/<img>', serverId: 's', serverName: '<server>', vaultId: 'v', status: 'Not checked', owner: null, progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 }, 'id');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('data-folder="id"');
  });
});
