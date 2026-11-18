import { expect, test } from 'bun:test';
import { formatHumanResult } from '../src/human-results.ts';

const vaultId = '12345678-1234-4234-9234-123456789abc';
const deviceId = '22345678-1234-4234-9234-123456789abc';

test('mutation confirmation keeps full identifiers and cleanup status', () => {
  expect(formatHumanResult('server vaults delete', {
    vaultId, status: 'deleted', cleanup: 'pending',
  })).toBe(`Vault deleted.\nVault ID: ${vaultId}\nStatus: deleted\nCleanup: pending`);
});

test('lists labeled records without truncating names, IDs, or metadata', () => {
  expect(formatHumanResult('server devices view', {
    devices: [{ deviceId, name: 'Office laptop', state: 'active', platform: 'linux' }],
    pending: [{ deviceId: vaultId, verificationCode: '123-456', requestedAtMs: 1000 }],
  })).toBe(`Server devices
Devices:
  Record 1:
    Device ID: ${deviceId}
    Name: Office laptop
    State: active
    Platform: linux
Pending:
  Record 1:
    Device ID: ${vaultId}
    Verification code: 123-456
    Requested at ms: 1000`);
});

test.each([
  ['server devices view', { devices: [], pending: [] }, 'No devices enrolled.', 'No pending requests.'],
  ['server vaults view', { vaults: [] }, 'No vaults.', 'nanosync server vaults create'],
  [
    'client connections view', { connections: [], pending: [] },
    'No server connections.', 'No pending enrollments.',
  ],
  ['client vaults view', { bindings: [] }, 'No vault bindings.', 'nanosync client vaults connect'],
])('provides actionable empty states for %s', (command, data, first, second) => {
  const output = formatHumanResult(command, data);
  expect(output).toContain(first);
  expect(output).toContain(second);
  expect(output).toContain('nanosync ');
  expect(output).not.toContain('[]');
});

test('groups all nested diagnostics without a JSON fallback', () => {
  expect(formatHumanResult('server admin diagnostics', {
    storage: { total: 10, unchecked: 1, verified: 7, missing: 1, corrupt: 1, ciphertextBytes: 4096 },
    retention: { selected: 2, protected: 1, notSelected: 3, deletableRevisions: 0 },
    gc: { potential: 3, eligible: 1, pending: 2, graceMs: 1000 },
  })).toBe(`Server diagnostics
Storage:
  Total: 10
  Unchecked: 1
  Verified: 7
  Missing: 1
  Corrupt: 1
  Ciphertext bytes: 4096
Retention:
  Selected: 2
  Protected: 1
  Not selected: 3
  Deletable revisions: 0
GC:
  Potential: 3
  Eligible: 1
  Pending: 2
  Grace ms: 1000`);
});

test('retains scan batch cursor, completion flag, and counts', () => {
  expect(formatHumanResult('server admin scan', {
    cursor: `${vaultId}:abcdef`, done: false, counts: { verified: 2, missing: 1, corrupt: 0 },
  })).toBe(`Integrity scan batch
Cursor: ${vaultId}:abcdef
Done: false
Counts:
  Verified: 2
  Missing: 1
  Corrupt: 0`);
});

test('sync reports only the supplied head and handles watch shutdown', () => {
  expect(formatHumanResult('client sync', { revisionId: vaultId, sequence: 5 }))
    .toBe(`Sync complete.\nRevision ID: ${vaultId}\nSequence: 5`);
  expect(formatHumanResult('client sync', { stopped: true }))
    .toBe('Sync watch stopped.\nStopped: true');
});

test('bindings preserve all identifiers, path, version, and missing alias', () => {
  const output = formatHumanResult('client vaults view', {
    bindings: [{ version: 1, connectionId: vaultId, root: '/home/me/notes',
      serverId: 'server-full-identifier', vaultId, deviceId, serverAlias: null }],
  });
  for (const field of [
    'Version: 1', `Connection ID: ${vaultId}`, 'Root: /home/me/notes',
    'Server ID: server-full-identifier', `Vault ID: ${vaultId}`, `Device ID: ${deviceId}`,
    'Server alias: None',
  ]) expect(output).toContain(field);
});

test.each(['approved', 'pending', 'denied', 'expired'])('enrollment status %s remains explicit', status => {
  const output = formatHumanResult('client connections add', {
    alias: 'Home', url: 'https://example.test', deviceId, deviceName: 'Laptop', status,
  });
  expect(output).toContain(`Status: ${status}`);
  expect(output).toContain(`Device ID: ${deviceId}`);
  expect(output).toContain('URL: https://example.test');
});

test('untrusted text cannot inject ANSI, OSC, controls, or extra lines', () => {
  const output = formatHumanResult('server vaults rename', {
    vaultId,
    name: '\x1b[31mred\x1b[0m\x1b]8;;https://evil.test\x07link\x1b]8;;\x07'
      + '\n\r\t\x00\x7f\x85\u2028\u2029\u202eend',
  });
  expect(output.split('\n')).toHaveLength(3);
  expect(output).toContain('Name: redlink');
  expect(output).toContain('end');
  expect(output).not.toContain('evil.test');
  expect(output).not.toMatch(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202e]/u);
});

test('does not print accidentally supplied secrets', () => {
  const output = formatHumanResult('client connections add', {
    status: 'approved', token: 'bearer-secret', password: 'password-secret',
    recoverySecret: 'recovery-secret', masterKey: 'key-secret',
  });
  expect(output).toContain('Status: approved');
  expect(output).not.toContain('secret');
});
