import { useState } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import type { ClientSend } from './App';
import type { DesktopSnapshot } from './rpc';

export function NotificationSettings({
  send,
  initial,
  observationError,
}: {
  send: ClientSend;
  initial: DesktopSnapshot;
  observationError?: string;
}) {
  const [draft, setDraft] = useState(initial.settings.notifications);
  const [revision, setRevision] = useState(initial.settings.revision);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  async function update(save: boolean) {
    setBusy(true);
    setError('');
    try {
      const reply = await send(
        save
          ? { type: 'notifications-settings', notifications: draft, expectedRevision: revision }
          : { type: 'snapshot' },
      );
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setDraft(reply.snapshot.settings.notifications);
      setRevision(reply.snapshot.settings.revision);
    } catch {
      setError('Outcome unknown. Refresh saved settings before retrying.');
    } finally {
      setBusy(false);
    }
  }
  const status = observationError ? undefined : initial.notifications;
  return (
    <section aria-label="Notification preferences">
      <h2>Only when something needs you</h2>
      <fieldset disabled={busy}>
        <legend>Shared notification intent</legend>
        {(
          [
            ['enabled', 'Enable notifications'],
            ['conflicts', 'Conflicts'],
            ['revokedAccess', 'Revoked or unavailable access'],
            ['persistentFailures', 'Persistent failures'],
            ['includeNamesAndPaths', 'Include local names and paths in notifications'],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            <input
              type="checkbox"
              checked={draft[key]}
              onChange={(event) => setDraft({ ...draft, [key]: event.target.checked })}
            />{' '}
            {label}
          </label>
        ))}
      </fieldset>
      <p>
        Global disable retains independent category choices and visible attention. Names and
        paths are off by default. Secrets and file contents are never included.
      </p>
      <p>
        No successful-sync or brief-outage alerts. Persistent failures require confirmed
        failures spanning five minutes. Repeated incidents are deduplicated across restarts;
        many conflicts share one alert.
      </p>
      <p>
        Native availability:{' '}
        {status?.available === true
          ? 'Available'
          : status?.available === false
            ? 'Unavailable'
            : 'Not observed'}
        . Open Nanosync action:{' '}
        {status?.actions === true
          ? 'Supported'
          : status?.actions === false
            ? 'Unavailable — reopen with launcher'
            : 'Not observed'}
        .
        {status?.code &&
          ` ${status.code}. Saved intent is retained; attention remains in the app.`}
      </p>
      {observationError && (
        <p role="alert">Native observations are historical until a successful refresh.</p>
      )}
      {error && <p role="alert">{error}</p>}
      <div className="nv-actions">
        <Button disabled={busy} onClick={() => void update(true)}>
          Save notification preferences
        </Button>
        <Button disabled={busy} onClick={() => void update(false)}>
          Refresh notification settings
        </Button>
      </div>
    </section>
  );
}

export function DiagnosticsSettings({ send }: { send: ClientSend }) {
  const [includeIdentifiers, setIncludeIdentifiers] = useState(false);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function exportReport() {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const reply = await send({ type: 'diagnostics-export', includeIdentifiers });
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setNotice(
        reply.cancelled
          ? 'Export cancelled. Nothing was written.'
          : reply.diagnostics?.exported
            ? 'Diagnostics exported locally. Unknown observations are marked; nothing was uploaded.'
            : 'Export outcome unavailable. No completed export was reported.',
      );
      setIncludeIdentifiers(false);
    } catch {
      setError('Export outcome unknown. Inspect the selected directory before retrying.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Diagnostic export">
      <h2>Review diagnostic report contents</h2>
      <p>
        Included: actual app/runtime/platform and schema versions, counts, phases, head
        sequences, safe error codes, credential mode and observed native availability. Missing
        facts remain unknown; partial reports are marked incomplete.
      </p>
      <p>
        Excluded by default: names, filenames, paths, URLs, credentials, keys, passwords,
        recovery material, credential hashes, HTTP bodies, raw logs, environment and file
        contents. Credentials are never included, even with identifying information enabled.
      </p>
      <label>
        <input
          type="checkbox"
          disabled={busy}
          checked={includeIdentifiers}
          onChange={(event) => setIncludeIdentifiers(event.target.checked)}
        />{' '}
        Include identifying binding IDs and local folder paths for this export only
      </label>
      {includeIdentifiers && (
        <p role="status">
          Privacy warning: this report will identify your local folder paths. Review it before
          sharing.
        </p>
      )}
      <p>
        Choose an existing owned directory in the native picker. A fresh protected file is
        created outside synced/private state; no existing file is overwritten. Nothing is
        uploaded.
      </p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <Button disabled={busy} onClick={() => void exportReport()}>
        Choose directory and export diagnostics
      </Button>
    </section>
  );
}
