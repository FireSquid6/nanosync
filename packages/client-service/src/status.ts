import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { ClientLocal, parseStatusFacts, StatusReadError, type StatusFacts } from '@nanosync/client-local';
import { parseDeviceId, PROTOCOL_ERROR_CODES } from '@nanosync/protocol';
import { RemoteError } from '@nanosync/sync-core';
import { removalStatus } from './removal-state.ts';
import { records, discoverConnection, assertBindingRoot, type Connection } from './connections.ts';
import { readSettings, pauseCauses, present } from './settings.ts';
import { privateDirectory, secureCreate, secureRead, secureReplace } from './security.ts';
import { observeSyncLock } from './sync-lock.ts';
import { ClientError } from './errors.ts';

export type SyncPhase =
  | 'not-started' | 'idle' | 'syncing' | 'pausing' | 'paused'
  | 'offline' | 'credentials-locked' | 'folder-unavailable' | 'failed';
export type TransferProgress = Record<'upload' | 'download', { count: number; bytes: number }>;
export const PERSISTENT_FAILURE_MS = 300_000;
export interface FailureEpisode {
  id: string;
  firstFailureAt: number;
  lastFailureAt: number;
  confirmation: string;
  code: string;
}
export function confirmFailure(previous: FailureEpisode | null | undefined, code: string, now: number): FailureEpisode {
  return { id: previous?.id ?? randomUUID(), firstFailureAt: previous?.firstFailureAt ?? now,
    lastFailureAt: now, confirmation: randomUUID(), code };
}
export interface SyncObservation {
  version: 1 | 2;
  failureEpisode?: FailureEpisode | null;
  observedAt: number;
  phase: SyncPhase;
  owner: { origin: 'cli' | 'desktop'; instanceId: string } | null;
  lock: NonNullable<ReturnType<typeof observeSyncLock>> | null;
  progress: TransferProgress;
  facts: StatusFacts | null;
  enginePhase: 'checking' | 'scanning' | 'transferring' | null;
  verified: boolean;
  lastRemoteCheck: number | null;
  lastSuccess: number | null;
  error: string | null;
  attentionError: string | null;
  statusIssues: StatusIssueCode[];
}
const phases: SyncPhase[] = [
  'not-started', 'idle', 'syncing', 'pausing', 'paused', 'offline',
  'credentials-locked', 'folder-unavailable', 'failed',
];
const localCodes = [
  'SYNC_PAUSED', 'FOLDER_UNAVAILABLE', 'CREDENTIALS_UNAVAILABLE',
  'CREDENTIALS_LOCKED', 'OPERATION_FAILED', 'REMOVAL_PENDING',
];
const observationKeys = [
  'attentionError', 'enginePhase', 'error', 'facts', 'lastRemoteCheck', 'lastSuccess',
  'lock', 'observedAt', 'owner', 'phase', 'progress', 'statusIssues', 'verified', 'version',
];
const issueDetails = {
  STATUS_RACE: { message: 'Status changed during observation.', retryable: true,
    recoveryAction: 'Refresh status and retry.' },
  JOURNAL_RECOVERY_REQUIRED: { message: 'The journal needs owner recovery.', retryable: false,
    recoveryAction: 'Preserve private state. Ask the current owner to recover, or stop it and start a compatible owner.' },
  JOURNAL_INVALID: { message: 'The journal is unsafe, incompatible or invalid.', retryable: false,
    recoveryAction: 'Stop syncing and inspect or restore private state. Do not reset the journal.' },
  STATUS_INVALID: { message: 'Saved sync status is invalid or unreadable.', retryable: false,
    recoveryAction: 'Inspect or restore status.json, then retry.' },
  OWNER_UNAVAILABLE: { message: 'The sync owner cannot be safely inspected.', retryable: false,
    recoveryAction: 'Stop the owner and retry with a compatible client; do not bypass its lock.' },
} as const;
export type StatusIssueCode = keyof typeof issueDetails;
function issueCode(error: unknown, fallback: StatusIssueCode): StatusIssueCode {
  if (error instanceof StatusReadError) return error.code;
  if ((error as { code?: unknown } | null)?.code === 'ENOENT') return 'STATUS_RACE';
  if (error instanceof ClientError && error.code === 'STATUS_INVALID') return 'STATUS_INVALID';
  return fallback;
}
function observe<T>(
  read: () => T, issues: StatusIssueCode[], fallback: StatusIssueCode = 'STATUS_INVALID',
): T | null {
  try { return read(); }
  catch (error) {
    const code = issueCode(error, fallback);
    if (!issues.includes(code)) issues.push(code);
    return null;
  }
}
function nonnegative(value: number) { return Number.isSafeInteger(value) && value >= 0; }
function knownError(code: string | null) {
  return code === null || [...localCodes, ...PROTOCOL_ERROR_CODES].includes(code);
}
export function statusError(error: unknown): string {
  if (error instanceof RemoteError && (PROTOCOL_ERROR_CODES as readonly string[]).includes(error.code))
    return error.code;
  if (error instanceof ClientError && localCodes.includes(error.code)) return error.code;
  return 'OPERATION_FAILED';
}
export function readObservation(replica: string): SyncObservation | null {
  try { return parseObservation(replica); }
  catch (error) {
    if ((error as { code?: unknown } | null)?.code === 'ENOENT') throw new StatusReadError('STATUS_RACE');
    throw new ClientError('STATUS_INVALID',
      'Saved sync status is invalid or unreadable; inspect or restore status.json and retry.');
  }
}
function recordObject(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...keys].sort().join(','))
    throw new Error('Invalid status record');
  return value as Record<string, unknown>;
}
function parseObservation(replica: string): SyncObservation | null {
  if (!present(replica)) return null;
  privateDirectory(replica);
  const path = join(replica, 'status.json');
  if (!present(path)) return null;
  const value = JSON.parse(secureRead(path, 16384).toString('utf8')) as SyncObservation;
  if (!value || Object.keys(value).sort().join(',') !==
        (value.version === 2 ? [...observationKeys, 'failureEpisode'].sort() : observationKeys).join(',') ||
      ![1, 2].includes(value.version) || !phases.includes(value.phase) || typeof value.verified !== 'boolean' ||
      ![null, 'checking', 'scanning', 'transferring'].includes(value.enginePhase) ||
      !nonnegative(value.observedAt) ||
      [value.lastRemoteCheck, value.lastSuccess].some(time => time !== null && !nonnegative(time)) ||
      !knownError(value.error) || !knownError(value.attentionError) ||
      !Array.isArray(value.statusIssues) || value.statusIssues.length > 3 ||
      value.statusIssues.some(code => typeof code !== 'string' || !Object.hasOwn(issueDetails, code)))
    throw new Error('Invalid sync observation');

  if (value.version === 2 && value.failureEpisode !== null) {
    const episode = recordObject(value.failureEpisode,
      ['id', 'firstFailureAt', 'lastFailureAt', 'confirmation', 'code']);
    parseDeviceId(episode.id as string); parseDeviceId(episode.confirmation as string);
    if (!nonnegative(episode.firstFailureAt as number) || !nonnegative(episode.lastFailureAt as number) ||
        typeof episode.code !== 'string' || !knownError(episode.code)) throw new Error('Invalid failure episode');
  }
  for (const direction of ['upload', 'download'] as const) {
    const counter = value.progress?.[direction];
    if (!counter || Object.keys(counter).sort().join(',') !== 'bytes,count' ||
        !nonnegative(counter.count) || !nonnegative(counter.bytes))
      throw new Error('Invalid sync progress');
  }
  if (Object.keys(value.progress).sort().join(',') !== 'download,upload')
    throw new Error('Invalid sync progress');
  if (value.owner !== null) {
    recordObject(value.owner, ['origin', 'instanceId']);
    if (!['cli', 'desktop'].includes(value.owner.origin)) throw new Error('Invalid sync owner');
    parseDeviceId(value.owner.instanceId);
  }
  if (value.lock !== null) {
    const lock = recordObject(value.lock, ['owner', 'inode', 'live']);
    const owner = recordObject(lock.owner, ['pid', 'starttime']);
    const inode = recordObject(lock.inode, ['dev', 'ino']);
    if (typeof lock.live !== 'boolean' || !nonnegative(owner.pid as number) ||
        (owner.pid as number) < 1 || (owner.pid as number) > 2147483647 ||
        typeof owner.starttime !== 'string' || !/^[1-9]\d*$/.test(owner.starttime) ||
        !nonnegative(inode.dev as number) || !nonnegative(inode.ino as number) || (inode.ino as number) < 1)
      throw new Error('Invalid recorded owner lock');
  }
  if (value.facts !== null) parseStatusFacts(value.facts);
  return value;
}
export function writeObservation(replica: string, value: SyncObservation): void {
  const lock = value.lock ? { owner: value.lock.owner, live: value.lock.live,
    inode: { dev: value.lock.inode.dev, ino: value.lock.inode.ino } } : null;
  const path = join(replica, 'status.json'), text = JSON.stringify({ ...value, lock });
  if (present(path)) secureReplace(path, text); else secureCreate(path, text);
}
export function selectSavedBinding(root: string, from: string): Connection {
  const exact = records(root).find(binding => binding.root === resolve(from));
  return exact ?? discoverConnection(root, from, true);
}
function observedPhase(observation: SyncObservation | null, fresh: boolean, started: boolean): SyncPhase {
  if (fresh && observation) return observation.phase === 'paused' ? 'idle' : observation.phase;
  if (observation && ['failed', 'offline', 'credentials-locked'].includes(observation.phase))
    return observation.phase;
  return started ? 'idle' : 'not-started';
}
export function clientStatus(root: string, from?: string, now: () => number = Date.now) {
  const settings = readSettings(root), removal = removalStatus(root);
  let bindings: Connection[] = [];
  if (from) bindings = [selectSavedBinding(root, from)];
  else if (present(root)) bindings = records(root);

  return {
    settingsRevision: settings.revision, globalPaused: settings.globalPaused, observedAt: now(),
    ...(removal ? { removal } : {}),
    bindings: bindings.map(binding => {
      const replica = join(root, 'replicas', binding.connectionId);
      const causes = pauseCauses(settings, binding.connectionId), paused = causes.global || causes.binding;
      const issues: StatusIssueCode[] = [];
      const removing = removal?.bindings.some(item => item.connection.connectionId === binding.connectionId) ?? false;
      const facts = removing ? null : observe(
        () => ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId), issues, 'JOURNAL_INVALID');
      const observation = removing ? null : observe(() => readObservation(replica), issues);
      const lock = observe(
        () => present(replica) ? observeSyncLock(replica) : null, issues, 'OWNER_UNAVAILABLE');
      for (const code of observation?.statusIssues ?? []) if (!issues.includes(code)) issues.push(code);
      const oldLock = observation?.lock;
      const owned = !!(lock?.live && oldLock &&
        lock.owner.pid === oldLock.owner.pid && lock.owner.starttime === oldLock.owner.starttime &&
        lock.inode.dev === oldLock.inode.dev && lock.inode.ino === oldLock.inode.ino);
      const sameFacts = facts !== null && observation !== null &&
        JSON.stringify(facts) === JSON.stringify(observation.facts);
      let unavailable = false;
      try { if (!removing) assertBindingRoot(root, binding); }
      catch (error) {
        if (error instanceof StatusReadError) {
          if (!issues.includes(error.code)) issues.push(error.code);
        } else unavailable = true;
      }
      const fresh = issues.length === 0 && owned && sameFacts;
      const statusNeedsAttention = issues.some(code => !issueDetails[code].retryable);
      let phase = observedPhase(observation, fresh, facts !== null);
      if (issues.length) {
        if (statusNeedsAttention && phase !== 'credentials-locked') phase = 'failed';
        else if (phase === 'not-started') phase = 'idle';
      }
      if (paused) phase = owned && observation?.phase === 'syncing' ? 'pausing' : 'paused';
      if (unavailable) phase = 'folder-unavailable';
      if (removing) phase = 'failed';
      const upToDate = !unavailable && !paused && fresh && observation?.verified === true && phase === 'idle' &&
        facts !== null && facts.conflicts === 0 && Object.values(facts.pending).every(count => count === 0) &&
        facts.heads.applied.revisionId !== null &&
        JSON.stringify(facts.heads.observed) === JSON.stringify(facts.heads.applied) &&
        JSON.stringify(facts.heads.accepted) === JSON.stringify(facts.heads.applied);
      const owner = owned && observation?.owner
        ? { origin: observation.owner.origin, instanceId: observation.owner.instanceId } : null;
      const progress = observation ? {
        upload: { count: observation.progress.upload.count, bytes: observation.progress.upload.bytes },
        download: { count: observation.progress.download.count, bytes: observation.progress.download.bytes },
      } : null;
      const episode = observation?.failureEpisode;
      const persistentFailure = !!episode && Math.max(0, episode.lastFailureAt - episode.firstFailureAt) >= PERSISTENT_FAILURE_MS;
      const savedError = observation?.attentionError ?? observation?.error;
      const error = removing ? 'REMOVAL_PENDING' : unavailable ? 'FOLDER_UNAVAILABLE' : savedError ?? issues[0] ?? null;
      return {
        ...binding, ...(removing ? { removalPending: true as const } : {}), owner, ownerPresent: !!lock?.live, pause: { ...causes, effective: paused }, phase,
        freshness: fresh ? 'observed' as const : 'stale-or-unknown' as const,
        enginePhase: fresh ? observation?.enginePhase ?? null : null,
        progressUnit: 'completed-ciphertext-frames' as const, progress, facts, upToDate,
        failureEpisode: observation?.failureEpisode ?? null,
        lastRemoteCheck: observation?.lastRemoteCheck ?? null,
        lastSuccessfulSync: observation?.lastSuccess ?? null,
        observationTime: observation?.observedAt ?? null,
        attentionRequired: removing || (facts?.conflicts ?? 0) > 0 || unavailable || persistentFailure || !!observation?.attentionError ||
          statusNeedsAttention,
        statusIssues: issues.map(code => ({ code, ...issueDetails[code] })),
        error,
      };
    }),
  };
}

/** Persist a confirmed blocked start without opening a writable journal or probing a store. */
export function recordStartFailure(
  root: string, binding: Connection, error: unknown, now: () => number = Date.now,
): void {
  if (!(error instanceof ClientError) || !['CREDENTIALS_UNAVAILABLE', 'CREDENTIALS_LOCKED', 'FOLDER_UNAVAILABLE'].includes(error.code))
    return;
  try {
    const replica = join(root, 'replicas', binding.connectionId);
    if (!present(replica) || observeSyncLock(replica)?.live) return;
    const issues: StatusIssueCode[] = [];
    const previous = observe(() => readObservation(replica), issues);
    const facts = observe(
      () => ClientLocal.readStatus(replica, binding.vaultId, binding.deviceId), issues, 'JOURNAL_INVALID');
    writeObservation(replica, {
      version: 2, failureEpisode: confirmFailure(previous?.failureEpisode, error.code, now()),
      observedAt: now(), phase: error.code === 'FOLDER_UNAVAILABLE' ? 'folder-unavailable' : 'credentials-locked',
      enginePhase: null, owner: null, lock: null,
      progress: previous?.progress ?? { upload: { count: 0, bytes: 0 }, download: { count: 0, bytes: 0 } },
      facts, verified: false, statusIssues: issues,
      lastRemoteCheck: previous?.lastRemoteCheck ?? null, lastSuccess: previous?.lastSuccess ?? null,
      error: error.code, attentionError: error.code,
    });
  } catch {
    // Keep the primary recovery guidance even if status cannot be persisted at all.
    error.message += ' Sync status could not be recorded; inspect private state before retrying.';
  }
}

export type ClientStatusSnapshot = ReturnType<typeof clientStatus>;
