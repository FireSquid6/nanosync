import { NotificationSettings, DiagnosticsSettings } from './NotificationSettings';
import { useState } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import type { ClientSend } from './App';
import type { DesktopSnapshot } from './rpc';

export function General({
  send,
  initial,
  observationError,
  onBack,
}: {
  send: ClientSend;
  initial: DesktopSnapshot;
  observationError?: string;
  onBack(): void;
}) {
  const [tab, setTab] = useState<'general' | 'notifications' | 'diagnostics'>('general');
  const lifecycle = observationError ? undefined : initial.lifecycle;
  const [draft, setDraft] = useState(initial.settings.lifecycle);
  const [revision, setRevision] = useState(initial.settings.revision);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function update(save: boolean) {
    setBusy(true);
    setError('');
    try {
      if (save && draft.trayEnabled === null) {
        setError('Choose whether to enable the tray.');
        return;
      }
      const reply = await send(
        save
          ? {
              type: 'settings',
              lifecycle: { ...draft, trayEnabled: draft.trayEnabled! },
              expectedRevision: revision,
            }
          : { type: 'snapshot' },
      );
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setDraft(reply.snapshot.settings.lifecycle);
      setRevision(reply.snapshot.settings.revision);
    } catch {
      setError('Outcome unknown. Refresh saved settings before retrying.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="nv-root desktop folders">
      <header>
        <strong>Nanosync</strong>
      </header>
      <div className="desktop-layout">
        <nav aria-label="Client">
          <Button variant="quiet" onClick={onBack}>
            Back to Folders
          </Button>
          <strong aria-current="page">Settings</strong>
        </nav>
        <main className="setup-content">
          <h1>
            Settings —{' '}
            {tab === 'general'
              ? 'General'
              : tab === 'notifications'
                ? 'Notifications'
                : 'Diagnostics'}
          </h1>
          <nav aria-label="Settings categories" className="settings-subnav nv-actions">
            {(['general', 'notifications', 'diagnostics'] as const).map((name) => (
              <Button
                key={name}
                variant="quiet"
                aria-current={tab === name ? 'page' : undefined}
                onClick={() => setTab(name)}
              >
                {name[0]!.toUpperCase() + name.slice(1)}
              </Button>
            ))}
          </nav>
          <section hidden={tab !== 'general'}>
            <p>
              Login startup is opt-in, for your graphical login only. No pre-login or lingering
              service is installed.
            </p>
            <fieldset disabled={busy}>
              <legend>Saved lifecycle intent</legend>
              <label>
                <input
                  type="checkbox"
                  checked={draft.startAtLogin}
                  onChange={(event) =>
                    setDraft({ ...draft, startAtLogin: event.target.checked })
                  }
                />{' '}
                Start at login
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={draft.trayEnabled === true}
                  onChange={(event) =>
                    setDraft({ ...draft, trayEnabled: event.target.checked })
                  }
                />{' '}
                Enable status tray
              </label>
              {draft.trayEnabled === null && (
                <p>Tray choice unanswered. Toggle it on or off before saving.</p>
              )}
              <label>
                <input
                  type="checkbox"
                  checked={draft.keepSyncingAfterClose}
                  onChange={(event) =>
                    setDraft({ ...draft, keepSyncingAfterClose: event.target.checked })
                  }
                />{' '}
                Keep syncing after closing the window
              </label>
            </fieldset>
            <p>
              With background on, Close hides even without a tray. Reopen with the launcher.
              With it off, Close safely quits. Login launches hidden with background on,
              otherwise visible.
            </p>
            <p>
              Quit stops only this desktop instance, not independent CLI owners or shared pause
              choices.
            </p>
            {error && <p role="alert">{error}</p>}
            <div className="nv-actions">
              <Button disabled={busy} onClick={() => void update(true)}>
                Save preferences
              </Button>
              <Button disabled={busy} onClick={() => void update(false)}>
                Refresh saved settings
              </Button>
            </div>
            <h2>Native effects (not the saved intent)</h2>
            {observationError && (
              <p role="alert">
                Native observation unavailable. Previous effects are historical; refresh to
                retry.
              </p>
            )}
            {lifecycle ? (
              <>
                {(['startup', 'tray', 'session'] as const).map((name) => (
                  <section key={name}>
                    <h3>{name === 'session' ? 'Logout safety' : name}</h3>
                    <p>
                      {lifecycle[name].available === null
                        ? 'Not requested / not probed'
                        : lifecycle[name].available
                          ? 'Available'
                          : 'Unavailable'}{' '}
                      · {lifecycle[name].applied ? 'Applied' : 'Not applied'}.{' '}
                      {lifecycle[name].message}
                    </p>
                  </section>
                ))}
                {lifecycle.closing && (
                  <p role="status">Stopping desktop work; new work is refused.</p>
                )}
                {lifecycle.shutdownError && <p role="alert">{lifecycle.shutdownError}</p>}
              </>
            ) : (
              <p>
                {observationError
                  ? 'Native effects are unknown until a successful refresh.'
                  : 'Native effects have not been observed. Do not infer availability from saved preferences.'}
              </p>
            )}
            <p>
              Installed-session login/logout, host tray presentation and native Wayland are not
              certified by headless tests.
            </p>
          </section>
          <div hidden={tab !== 'notifications'}>
            <NotificationSettings
              send={send}
              initial={initial}
              observationError={observationError}
            />
          </div>
          <div hidden={tab !== 'diagnostics'}>
            <DiagnosticsSettings send={send} />
          </div>
        </main>
      </div>
    </div>
  );
}
