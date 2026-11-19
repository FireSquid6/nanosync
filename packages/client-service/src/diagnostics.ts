import * as fs from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { parseDeviceId, parseVaultId, PROTOCOL_ERROR_CODES } from '@nanosync/protocol';
import { isDeepStrictEqual } from 'node:util';
import { credentialDecision } from './credentials.ts';
import { records, type Connection } from './connections.ts';
import { ClientError } from './errors.ts';
import { removalStatus } from './removal-state.ts';
import { present, readSettings } from './settings.ts';
import { privateDirectory, secureRead } from './security.ts';
import { acquireSyncLock } from './sync-lock.ts';
import { clientStatus, readObservation } from './status.ts';

export type DiagnosticAvailability =
  | 'available' | 'unavailable' | 'failed' | 'not-probed' | 'not-applicable';
export interface DiagnosticsRuntime {
  applicationVersion: string;
  toolkitVersion: string | null;
  native: {
    startup: DiagnosticAvailability;
    tray: DiagnosticAvailability;
    session: DiagnosticAvailability;
    notifications: DiagnosticAvailability;
    notificationActions: DiagnosticAvailability;
  };
}
export interface DiagnosticsOptions { includeIdentifiers?: boolean }

const messages = {
  DIAGNOSTICS_INVALID_INPUT: 'Invalid diagnostics request or trusted runtime metadata.',
  DIAGNOSTICS_COLLECTION_FAILED:
    'Diagnostics could not safely read client state. Preserve private state and inspect it.',
  DIAGNOSTICS_DESTINATION_UNSAFE:
    'Choose an owned directory outside client state and sync roots, without symlinks or unsafe permissions.',
  DIAGNOSTICS_DESTINATION_EXISTS: 'Diagnostics destination already exists. Choose a new filename.',
  DIAGNOSTICS_WRITE_FAILED:
    'Export failed. A protected incomplete file may remain; inspect it and retry with a new filename.',
} as const;
function failure(code: keyof typeof messages): ClientError {
  return new ClientError(code, messages[code]);
}
const availability = ['available', 'unavailable', 'failed', 'not-probed', 'not-applicable'];
function version(value: unknown): value is string {
  const semver = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:-[a-zA-Z0-9.-]{1,40})?$/;
  return typeof value === 'string' && semver.test(value);
}
function validate(runtime: DiagnosticsRuntime, options: DiagnosticsOptions) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      !runtime || !version(runtime.applicationVersion) ||
      (runtime.toolkitVersion !== null && !version(runtime.toolkitVersion)) || !runtime.native ||
      Object.keys(options).some(key => key !== 'includeIdentifiers') ||
      (options.includeIdentifiers !== undefined && typeof options.includeIdentifiers !== 'boolean'))
    throw failure('DIAGNOSTICS_INVALID_INPUT');
  for (const key of ['startup', 'tray', 'session', 'notifications', 'notificationActions'] as const) {
    if (!availability.includes(runtime.native[key])) throw failure('DIAGNOSTICS_INVALID_INPUT');
  }
}
const safeErrors = [
  ...PROTOCOL_ERROR_CODES, 'SYNC_PAUSED', 'FOLDER_UNAVAILABLE', 'CREDENTIALS_UNAVAILABLE',
  'CREDENTIALS_LOCKED', 'OPERATION_FAILED', 'REMOVAL_PENDING', 'STATUS_RACE',
  'JOURNAL_RECOVERY_REQUIRED', 'JOURNAL_INVALID', 'STATUS_INVALID', 'OWNER_UNAVAILABLE',
  'CREDENTIAL_MIGRATION_PENDING',
];
function safeCode(value: string | null): string | null {
  if (value === null) return null;
  return safeErrors.includes(value) ? value : 'OPERATION_FAILED';
}
// The operational reader refuses migration; diagnostics reads only checked binding metadata.
function diagnosticRecords(root: string, migrating: boolean): Connection[] {
  if (!migrating) return records(root);
  const directory = join(resolve(root), 'connections');
  const bindings: Connection[] = [];
  if (present(directory)) {
    const stat = fs.lstatSync(directory, { bigint: true });
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid!()) ||
        (stat.mode & 0o077n) !== 0n || fs.realpathSync(directory) !== directory)
      throw failure('DIAGNOSTICS_COLLECTION_FAILED');

    for (const name of fs.readdirSync(directory)) {
      if (!/^[0-9a-f-]{36}\.json$/.test(name)) throw failure('DIAGNOSTICS_COLLECTION_FAILED');

      const binding = JSON.parse(secureRead(join(directory, name), 2048).toString('utf8'));
      if (!binding || Object.keys(binding).sort().join(',') !==
          'connectionId,deviceId,root,serverId,vaultId,version' || binding.version !== 1 ||
          binding.connectionId !== name.slice(0, -5) || typeof binding.root !== 'string' ||
          binding.root.includes('\0') || resolve(binding.root) !== binding.root)
        throw failure('DIAGNOSTICS_COLLECTION_FAILED');

      bindings.push({
        version: 1, connectionId: parseVaultId(binding.connectionId), root: binding.root,
        serverId: parseVaultId(binding.serverId), vaultId: parseVaultId(binding.vaultId),
        deviceId: parseDeviceId(binding.deviceId),
      });
    }
  }

  for (const item of removalStatus(root)?.bindings ?? []) {
    const existing = bindings.find(binding => binding.connectionId === item.connection.connectionId);
    if (existing && !isDeepStrictEqual(existing, item.connection))
      throw failure('DIAGNOSTICS_COLLECTION_FAILED');
    if (!existing) bindings.push(item.connection);
  }
  return bindings;
}
function buildReport(root: string, runtime: DiagnosticsRuntime, options: DiagnosticsOptions) {
  const credentials = credentialDecision(root);
  const settings = readSettings(root);
  const removal = removalStatus(root);
  const source = credentials.migrationPending
    ? diagnosticRecords(root, true).map(binding => ({
      connectionId: binding.connectionId, root: binding.root,
      pause: {
        global: settings.globalPaused, binding: settings.bindingPaused[binding.connectionId] ?? false,
        effective: settings.globalPaused || (settings.bindingPaused[binding.connectionId] ?? false),
      },
      phase: null, freshness: 'stale-or-unknown' as const, owner: null, ownerPresent: null,
      facts: null, error: 'CREDENTIAL_MIGRATION_PENDING',
      statusIssues: [{ code: 'CREDENTIAL_MIGRATION_PENDING' }],
    })) : clientStatus(root).bindings;
  const observations = source.map(binding => {
    if (credentials.migrationPending) return { version: null, failed: false };
    try {
      return { version: readObservation(join(root, 'replicas', binding.connectionId))?.version ?? null,
        failed: false };
    } catch {
      return { version: null, failed: true };
    }
  });
  const bindings = source.map((binding, index) => {
    const facts = binding.facts;
    return {
      ordinal: index + 1, phase: binding.phase, freshness: binding.freshness,
      paused: {
        global: binding.pause.global, binding: binding.pause.binding, effective: binding.pause.effective,
      },
      ownerKind: binding.owner?.origin ?? null, ownerPresent: binding.ownerPresent,
      heads: facts === null ? null : {
        observed: facts.heads.observed.sequence,
        accepted: facts.heads.accepted.sequence,
        applied: facts.heads.applied.sequence,
      },
      pending: facts === null ? null : {
        operations: facts.pending.operations, transfers: facts.pending.transfers,
        applies: facts.pending.applies, hydration: facts.pending.hydration,
        proposal: facts.pending.proposal, restore: facts.pending.restore,
        reconciliation: facts.pending.reconciliation,
      },
      conflicts: facts?.conflicts ?? null, errorCode: safeCode(binding.error),
      issueCodes: observations[index]!.failed
        ? ['STATUS_INVALID', ...binding.statusIssues.map(issue => safeCode(issue.code))]
        : binding.statusIssues.map(issue => safeCode(issue.code)),
    };
  });
  const complete = !credentials.migrationPending && bindings.every(binding =>
    binding.issueCodes.length === 0 && binding.phase !== 'folder-unavailable' &&
    binding.errorCode !== 'REMOVAL_PENDING');
  const knownConflicts = bindings.every(binding => binding.conflicts !== null);
  const pending = bindings.every(binding => binding.pending !== null) ? {
    operations: 0, transfers: 0, applies: 0, hydration: 0,
    proposal: 0, restore: 0, reconciliation: 0,
  } : null;
  if (pending !== null) {
    for (const binding of bindings) {
      for (const key of Object.keys(pending) as (keyof typeof pending)[]) {
        pending[key] += binding.pending![key];
        if (!Number.isSafeInteger(pending[key])) throw failure('DIAGNOSTICS_COLLECTION_FAILED');
      }
    }
  }
  const conflicts = knownConflicts
    ? bindings.reduce((total, binding) => total + binding.conflicts!, 0) : null;
  if (conflicts !== null && !Number.isSafeInteger(conflicts))
    throw failure('DIAGNOSTICS_COLLECTION_FAILED');
  const report = {
    version: 1 as const, complete,
    versions: {
      application: runtime.applicationVersion, bun: Bun.version,
      platform: process.platform, architecture: process.arch, electrobun: runtime.toolkitVersion,
    },
    schemas: {
      settings: present(join(root, 'settings.json')) ? settings.version : null,
      observation: observations.map(item => item.version), journal: null, credentialDescriptor: null,
    },
    supportedSchemas: { journal: 7 },
    credentials: {
      mode: credentials.mode, decisionRequired: credentials.decisionRequired,
      migrationPending: credentials.migrationPending, cleanupPending: credentials.cleanupPending,
      phase: credentials.phase, canRollback: credentials.canRollback,
    },
    recovery: { removalPending: removal !== null, phase: removal?.phase ?? null },
    counts: {
      bindings: bindings.length,
      conflicts,
      pending,
    },
    bindings,
    native: {
      startup: runtime.native.startup, tray: runtime.native.tray, session: runtime.native.session,
      notifications: runtime.native.notifications,
      notificationActions: runtime.native.notificationActions,
    },
  };
  const result: typeof report & { identifiers?: {
    bindings: { ordinal: number; bindingId: string; root: string }[];
  } } = report;
  if (options.includeIdentifiers === true) {
    result.identifiers = {
      bindings: source.map((binding, index) => ({
        ordinal: index + 1, bindingId: binding.connectionId, root: binding.root,
      })),
    };
  }
  return result;
}
export type DiagnosticsReport = ReturnType<typeof buildReport>;

export function collectDiagnostics(
  root: string, trustedRuntime: DiagnosticsRuntime, options: DiagnosticsOptions = {},
): DiagnosticsReport {
  validate(trustedRuntime, options);
  try { return buildReport(root, trustedRuntime, options); }
  catch { throw failure('DIAGNOSTICS_COLLECTION_FAILED'); }
}

function overlaps(first: string, second: string) {
  return first === second || first.startsWith(second + sep) || second.startsWith(first + sep);
}
function identity(first: fs.BigIntStats, second: fs.BigIntStats) {
  return first.dev === second.dev && first.ino === second.ino;
}
function ancestry(parent: string, requireOwnedParent = true) {
  const checked: { path: string; stat: fs.BigIntStats }[] = [];
  let current = parent;
  while (true) {
    const stat = fs.lstatSync(current, { bigint: true });
    const uid = BigInt(process.getuid!());
    const rootSticky = stat.uid === 0n && !!(stat.mode & 0o1000n);
    if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync(current) !== current ||
        ![0n, uid].includes(stat.uid) ||
        ((stat.mode & 0o022n) !== 0n && !rootSticky) ||
        (requireOwnedParent && current === parent &&
          (stat.uid !== uid || (stat.mode & 0o022n) !== 0n)))
      throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
    checked.push({ path: current, stat });
    const next = dirname(current);
    if (next === current) return checked;
    current = next;
  }
}
function checkedBoundRoot(bound: string) {
  let current = bound;
  while (true) {
    try {
      const stat = fs.lstatSync(current, { bigint: true });
      if (current === bound && stat.uid !== BigInt(process.getuid!()))
        throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
      ancestry(current, false);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
      const parent = dirname(current);
      if (parent === current) throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
      current = parent;
    }
  }
}
function unchanged(checked: ReturnType<typeof ancestry>) {
  const fresh = ancestry(checked[0]!.path);
  if (fresh.length !== checked.length || fresh.some((item, index) =>
    item.path !== checked[index]!.path || !identity(item.stat, checked[index]!.stat)))
    throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
}
function protectedFile(stat: fs.BigIntStats) {
  return stat.isFile() && stat.uid === BigInt(process.getuid!()) && stat.nlink === 1n &&
    (stat.mode & 0o777n) === 0o600n;
}
function writeExport(destination: string, text: string) {
  let parentFd: number | undefined;
  let outputFd: number | undefined;
  try {
    const checked = ancestry(dirname(destination));
    parentFd = fs.openSync(dirname(destination), fs.constants.O_RDONLY |
      fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    if (!identity(fs.fstatSync(parentFd, { bigint: true }), checked[0]!.stat))
      throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
    unchanged(checked);
    try {
      outputFd = fs.openSync(destination, fs.constants.O_CREAT | fs.constants.O_EXCL |
        fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        throw failure('DIAGNOSTICS_DESTINATION_EXISTS');
      throw error;
    }
    const created = fs.fstatSync(outputFd, { bigint: true });
    const verify = () => {
      unchanged(checked);
      const named = fs.lstatSync(destination, { bigint: true });
      if (!protectedFile(fs.fstatSync(outputFd!, { bigint: true })) ||
          !identity(created, named) || !protectedFile(named))
        throw failure('DIAGNOSTICS_WRITE_FAILED');
    };
    verify();
    fs.writeFileSync(outputFd, text);
    fs.fsyncSync(outputFd);
    verify();
    fs.fsyncSync(parentFd);
    verify();
  } catch (error) {
    if (error instanceof ClientError && Object.hasOwn(messages, error.code)) throw error;
    throw failure('DIAGNOSTICS_WRITE_FAILED');
  } finally {
    try { if (outputFd !== undefined) fs.closeSync(outputFd); }
    finally { if (parentFd !== undefined) fs.closeSync(parentFd); }
  }
}

// Diagnostics shares the physical mutation lock, not permission to mutate recovery state.
function withDiagnosticRegistry<T>(root: string, action: () => T): T {
  const directory = privateDirectory(join(privateDirectory(root), 'registry-lock'));
  const release = acquireSyncLock(directory);
  try { return action(); }
  finally { release(); }
}

export function exportDiagnostics(
  root: string, destination: string, trustedRuntime: DiagnosticsRuntime,
  options: DiagnosticsOptions = {},
): { version: 1; exported: true; includeIdentifiers: boolean } {
  if (typeof destination !== 'string' || !isAbsolute(destination) ||
      destination.includes('\0') || resolve(destination) !== destination)
    throw failure('DIAGNOSTICS_INVALID_INPUT');
  const report = collectDiagnostics(root, trustedRuntime, options);
  try {
    withDiagnosticRegistry(root, () => {
      let roots: string[];
      try {
        roots = diagnosticRecords(root, credentialDecision(root).migrationPending)
          .map(binding => binding.root);
      }
      catch { throw failure('DIAGNOSTICS_COLLECTION_FAILED'); }
      for (const bound of roots) checkedBoundRoot(bound);
      if (overlaps(destination, resolve(root)) || roots.some(bound => overlaps(destination, bound)))
        throw failure('DIAGNOSTICS_DESTINATION_UNSAFE');
      try { writeExport(destination, JSON.stringify(report, null, 2) + '\n'); }
      catch (error) {
        if (error instanceof ClientError && Object.hasOwn(messages, error.code)) throw error;
        throw failure('DIAGNOSTICS_WRITE_FAILED');
      }
    });
  } catch (error) {
    if (error instanceof ClientError && Object.hasOwn(messages, error.code)) throw error;
    throw failure('DIAGNOSTICS_COLLECTION_FAILED');
  }
  return { version: 1, exported: true, includeIdentifiers: options.includeIdentifiers === true };
}
