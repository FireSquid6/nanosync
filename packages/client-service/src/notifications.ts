import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { parseDeviceId } from '@nanosync/protocol';
import { ClientError } from './errors.ts';
import { acquireSyncLock } from './sync-lock.ts';
import { privateDirectory, secureCreate, secureRead, secureReplace } from './security.ts';
import { present, readPreferences } from './settings.ts';
import { clientStatus, readObservation, PERSISTENT_FAILURE_MS } from './status.ts';
import { listConflicts } from './local-actions.ts';
import { credentialDecision } from './credentials.ts';
import { removalStatus } from './removal-state.ts';

export const NOTIFICATION_LEDGER = 'notification-delivery.json';
export const NOTIFICATION_LOCK = 'notification-delivery-lock';
export const notificationStage = /^notification-delivery\.json\.[0-9a-f]{32}\.stage$/;
export const FAILURE_THRESHOLD_MS = PERSISTENT_FAILURE_MS;
export type NotificationCategory = 'conflicts' | 'revokedAccess' | 'persistentFailures';
export type NotificationBatch = {
  category: NotificationCategory;
  incidents: string[];
  body: string;
  attemptId?: string;
};

type Delivery = {
  disposition: 'attempted' | 'accepted' | 'dismissed';
  nativeId: number | null;
  attemptId: string;
};
type Ledger = { version: 1; entries: Record<string, Delivery> };
const categories: NotificationCategory[] = ['conflicts', 'revokedAccess', 'persistentFailures'];
function checkKey(key: string) {
  const [binding, category, incident, lineage, extra] = key.split('/');
  parseDeviceId(binding!);
  parseDeviceId(incident!);
  if (
    !categories.includes(category as NotificationCategory) ||
    extra !== undefined ||
    (category === 'conflicts' ? !lineage : lineage !== undefined)
  )
    throw Error('Invalid incident');
  if (lineage) parseDeviceId(lineage);
}
function readLedger(root: string): Ledger {
  const path = join(root, NOTIFICATION_LEDGER);
  if (!present(path)) return { version: 1, entries: {} };
  const ledger = JSON.parse(secureRead(path, 1_000_000).toString()) as Ledger;
  if (
    !ledger ||
    Object.keys(ledger).sort().join(',') !== 'entries,version' ||
    ledger.version !== 1 ||
    !ledger.entries ||
    typeof ledger.entries !== 'object' ||
    Array.isArray(ledger.entries)
  )
    throw Error('Invalid ledger');
  for (const [key, item] of Object.entries(ledger.entries)) {
    checkKey(key);
    parseDeviceId(item?.attemptId);
    if (
      !item ||
      Object.keys(item).sort().join(',') !== 'attemptId,disposition,nativeId' ||
      !['attempted', 'accepted', 'dismissed'].includes(item.disposition) ||
      !(item.nativeId === null || (Number.isSafeInteger(item.nativeId) && item.nativeId > 0))
    )
      throw Error('Invalid delivery');
  }
  return ledger;
}
function changeLedger<T>(root: string, change: (ledger: Ledger) => T): T {
  const directory = privateDirectory(root);
  const release = acquireSyncLock(privateDirectory(join(directory, NOTIFICATION_LOCK)));
  try {
    const ledger = readLedger(directory),
      before = JSON.stringify(ledger),
      result = change(ledger),
      text = JSON.stringify(ledger);
    if (Buffer.byteLength(text) > 1_000_000) throw Error('Delivery ledger full');
    if (text === before) return result;
    const path = join(directory, NOTIFICATION_LEDGER);
    if (present(path)) secureReplace(path, text);
    else secureCreate(path, text);
    return result;
  } catch {
    throw new ClientError(
      'NOTIFICATIONS_STATE_INVALID',
      'Notification delivery state is unsafe, unreadable or full. Preserve it for inspection.',
    );
  } finally {
    release();
  }
}
/** Claim is durable before native submission: a crash may lose one alert, never replay it. */
export function claimNotifications(
  root: string,
  batches: NotificationBatch[],
): NotificationBatch[] {
  return changeLedger(root, (ledger) =>
    batches.flatMap((batch) => {
      const incidents = batch.incidents.filter((key) => {
        checkKey(key);
        return !Object.hasOwn(ledger.entries, key);
      });
      const attemptId = randomUUID();
      for (const key of incidents)
        ledger.entries[key] = { disposition: 'attempted', nativeId: null, attemptId };
      return incidents.length ? [{ ...batch, incidents, attemptId }] : [];
    }),
  );
}
/** Refresh intent/body after every awaited native call; withdrawn privacy is never queued. */
export async function deliverNotifications(
  root: string,
  select: () => NotificationBatch[],
  native: {
    admit(): boolean;
    submit(batch: NotificationBatch): Promise<void>;
  },
) {
  const categories = select().map((batch) => batch.category);
  for (const category of categories) {
    if (!native.admit()) return;
    const current = select().find((batch) => batch.category === category);
    if (!current) continue;
    const claimed = claimNotifications(root, [current])[0];
    if (claimed) await native.submit(claimed);
  }
}
export function recordNotificationDelivery(
  root: string,
  batch: NotificationBatch,
  nativeId: number,
  dismissed = false,
) {
  if (!Number.isSafeInteger(nativeId) || nativeId < 1)
    throw new ClientError('INVALID_INPUT', 'Invalid native notification handle.');
  parseDeviceId(batch.attemptId!);
  changeLedger(root, (ledger) => {
    for (const key of batch.incidents) {
      checkKey(key);
      const previous = ledger.entries[key];
      // A resolved/removed incident may be pruned while its native popup is still open.
      if (!previous || previous.attemptId !== batch.attemptId) continue;
      ledger.entries[key] = {
        disposition:
          previous.disposition === 'dismissed' || dismissed ? 'dismissed' : 'accepted',
        nativeId,
        attemptId: previous.attemptId,
      };
    }
  });
}
export function notificationText(text: string): string {
  const plain = text.replace(
    /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
    ' ',
  );
  return [...plain]
    .slice(0, 512)
    .join('')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}
function pruneNotifications(
  root: string,
  bindings: Set<string>,
  known: Map<string, Set<string>>,
) {
  if (!present(join(root, NOTIFICATION_LEDGER))) return;
  changeLedger(root, (ledger) => {
    for (const key of Object.keys(ledger.entries)) {
      const [binding, category] = key.split('/');
      const current = known.get(`${binding}/${category}`);
      if (!bindings.has(binding!) || (current && !current.has(key))) delete ledger.entries[key];
    }
  });
}
/** One batch per category, not per filename. First observation cannot age a stale failure. */
export function createNotificationSelection(root: string) {
  const baseline = new Map<string, string>();
  return () => {
    const preferences = readPreferences(root).notifications,
      decision = credentialDecision(root);
    if (
      !preferences.enabled ||
      decision.migrationPending ||
      decision.cleanupPending ||
      removalStatus(root)
    )
      return [];
    const snapshot = clientStatus(root),
      conflicts = preferences.conflicts ? listConflicts(root) : null;
    if (snapshot.removal) return [];
    const known = new Map<string, Set<string>>();
    const groups = new Map<NotificationCategory, { incidents: string[]; roots: string[] }>();
    function add(category: NotificationCategory, key: string, path: string) {
      const group = groups.get(category) ?? { incidents: [], roots: [] };
      group.incidents.push(key);
      if (group.roots.length < 2 && !group.roots.includes(path)) group.roots.push(path);
      groups.set(category, group);
    }
    for (const binding of snapshot.bindings) {
      const id = binding.connectionId;
      const listing = conflicts?.bindings.find((item) => item.connectionId === id);
      if (listing && !listing.issue && binding.facts !== null) {
        known.set(
          `${id}/conflicts`,
          new Set(
            listing.conflicts.map(
              (conflict) => `${id}/conflicts/${conflict.id}/${conflict.sourceRevisionId}`,
            ),
          ),
        );
      }
      if (listing && !listing.issue)
        for (const conflict of listing.conflicts)
          add(
            'conflicts',
            `${id}/conflicts/${conflict.id}/${conflict.sourceRevisionId}`,
            binding.root,
          );
      const episode = binding.failureEpisode;
      if (!episode) {
        baseline.delete(id);
        // Only a checked new-format successful pass proves failure resolution.
        try {
          const saved = readObservation(join(root, 'replicas', id));
          if (
            saved?.version === 2 &&
            saved.failureEpisode === null &&
            saved.lastSuccess !== null
          ) {
            if (preferences.revokedAccess) known.set(`${id}/revokedAccess`, new Set());
            if (preferences.persistentFailures)
              known.set(`${id}/persistentFailures`, new Set());
          }
        } catch {
          // Failed observations are unknown, never proof that a delivered incident resolved.
          continue;
        }
        continue;
      }
      if (preferences.revokedAccess)
        known.set(`${id}/revokedAccess`, new Set([`${id}/revokedAccess/${episode.id}`]));
      if (preferences.persistentFailures)
        known.set(
          `${id}/persistentFailures`,
          new Set([`${id}/persistentFailures/${episode.id}`]),
        );
      const previous = baseline.get(id);
      if (previous === undefined) baseline.set(id, episode.confirmation);
      const access = ['UNAUTHORIZED', 'FORBIDDEN'].includes(episode.code);
      if (access && preferences.revokedAccess)
        add('revokedAccess', `${id}/revokedAccess/${episode.id}`, binding.root);
      else if (
        !access &&
        preferences.persistentFailures &&
        previous !== undefined &&
        previous !== episode.confirmation &&
        Math.max(0, episode.lastFailureAt - episode.firstFailureAt) >= FAILURE_THRESHOLD_MS
      )
        add('persistentFailures', `${id}/persistentFailures/${episode.id}`, binding.root);
    }
    pruneNotifications(
      root,
      new Set(snapshot.bindings.map((binding) => binding.connectionId)),
      known,
    );
    const bodies: Record<NotificationCategory, string> = {
      conflicts: 'Conflicts need manual review. Both versions are preserved. Open Nanosync.',
      revokedAccess:
        'Access is unavailable. Check approval and authorization in Nanosync. Local files are preserved.',
      persistentFailures:
        'Sync still needs attention. Open Nanosync for recovery guidance. Local files are preserved.',
    };
    return [...groups].map(([category, group]) => ({
      category,
      incidents: group.incidents,
      body:
        bodies[category] +
        (preferences.includeNamesAndPaths
          ? ` ${notificationText(group.roots.join('; '))}`
          : ''),
    }));
  };
}
