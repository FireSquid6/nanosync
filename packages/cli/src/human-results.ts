import { stripVTControlCharacters } from 'node:util';

const headings: Record<string, string> = {
  'server init': 'Server initialized.',
  'server run': 'Server stopped.',
  'server devices view': 'Server devices',
  'server devices approve': 'Device approved.',
  'server devices deny': 'Device denied.',
  'server devices revoke': 'Device revoked.',
  'server vaults view': 'Server vaults',
  'server vaults create': 'Vault created.',
  'server vaults rename': 'Vault renamed.',
  'server vaults delete': 'Vault deleted.',
  'server admin storage': 'Storage report',
  'server admin retention-dry-run': 'Retention dry run (no changes made)',
  'server admin gc-dry-run': 'Garbage collection dry run (no changes made)',
  'server admin scan': 'Integrity scan batch',
  'server admin diagnostics': 'Server diagnostics',
  'client connections view': 'Server connections',
  'client connections add': 'Server enrollment result',
  'client connections remove': 'Local server connection removed.',
  'client vaults view': 'Local vault bindings',
  'client vaults connect': 'Vault connected; no files transferred.',
  'client vaults disconnect': 'Vault disconnected.',
  'client sync': 'Sync complete.',
};

const emptyStates: Record<string, Record<string, string>> = {
  'server devices view': {
    devices: 'No devices enrolled. Run nanosync client connections add on a client.',
    pending: 'No pending requests. Run nanosync client connections add on a client to enroll.',
  },
  'server vaults view': {
    vaults: 'No vaults. Create one with nanosync server vaults create.',
  },
  'client connections view': {
    connections: 'No server connections. Run nanosync client connections add.',
    pending: 'No pending enrollments. Run nanosync client connections add to enroll.',
  },
  'client vaults view': {
    bindings: 'No vault bindings. Run nanosync client vaults connect.',
  },
};

function safeText(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, ' ');
}

function label(key: string): string {
  const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').toLowerCase();
  const readable = words.replace(/\b(id|url|gc)\b/gi, word => word.toUpperCase());
  return safeText(readable.charAt(0).toUpperCase() + readable.slice(1));
}

function fields(data: unknown, indent: string, empty: Record<string, string>): string[] {
  if (data === null) return [`${indent}None`];
  if (typeof data !== 'object') return [`${indent}${safeText(String(data))}`];
  if (Array.isArray(data)) {
    return data.flatMap((record, index) => [
      `${indent}Record ${index + 1}:`, ...fields(record, `${indent}  `, {}),
    ]);
  }
  return Object.entries(data).flatMap(([key, value]) => {
    if (/^(token|password|recoverySecret|masterKey|privateKey|credentialDigest)$/i.test(key)) return [];
    const title = `${indent}${label(key)}:`;
    if (value === null) return [`${title} None`];
    if (typeof value !== 'object') return [`${title} ${safeText(String(value))}`];
    if (Array.isArray(value) && value.length === 0) {
      return [`${title} ${empty[key] ?? 'None'}`];
    }
    return [title, ...fields(value, `${indent}  `, {})];
  });
}

/** Plain text only; callers own terminal styling and output routing. */
export function formatHumanResult(commandPath: string, data: unknown): string {
  let heading = headings[commandPath] ?? label(commandPath);
  if (commandPath === 'client sync' && data && typeof data === 'object' && 'stopped' in data) {
    heading = 'Sync watch stopped.';
  }
  const lines = [heading, ...fields(data, '', emptyStates[commandPath] ?? {})];
  if (commandPath === 'client vaults connect') lines.push('', 'Next: nanosync client sync');
  return lines.join('\n');
}
