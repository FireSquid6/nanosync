import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import { ThemeControl } from '../../../packages/ui-theme/ThemeControl';
import type { ClientSend } from './App';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from './rpc';

type Success = Extract<DesktopReply, { ok: true }>;
export function LocalTools({
  send,
  initial,
  binding,
  mode,
  onBack,
}: {
  send: ClientSend;
  initial: DesktopSnapshot;
  binding?: string;
  mode: 'conflicts' | 'ignores' | 'removal' | 'connections';
  onBack(): void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [conflicts, setConflicts] = useState<Success['conflicts']>();
  const [rules, setRules] = useState<Success['ignores']>();
  const [text, setText] = useState(''),
    [validation, setValidation] = useState<Success['validation']>();
  const [preview, setPreview] = useState<Success['removalPreview']>();
  const [force, setForce] = useState(false),
    [stopOwner, setStopOwner] = useState(false),
    [confirmed, setConfirmed] = useState(false);
  const active = useRef(false),
    alive = useRef(true);
  async function request(command: DesktopCommand) {
    if (active.current) return;
    active.current = true;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const reply = await send(command);
      if (!alive.current) return;
      if (!reply.ok) {
        setError(reply.message);
        const refreshed = await send({ type: 'snapshot' });
        if (alive.current && refreshed.ok) setSnapshot(refreshed.snapshot);
        return;
      }
      setSnapshot(reply.snapshot);
      if (reply.conflicts) setConflicts(reply.conflicts);
      if (reply.ignores) {
        setRules(reply.ignores);
        setText(reply.ignores.text);
        setValidation(undefined);
      }
      if (reply.validation) setValidation(reply.validation);
      if (reply.removalPreview) {
        setPreview(reply.removalPreview);
        setForce(false);
        setStopOwner(false);
        setConfirmed(false);
      }
      if (command.type === 'remove' || command.type === 'resume-removal') {
        setPreview(undefined);
        setNotice(
          'Local state removed. Local files and remote data are preserved. Remote access was not revoked.',
        );
      }
      if (command.type === 'ignores-set')
        setNotice(
          'Ignore rules saved durably. Existing pause and start intent is unchanged; no work was started.',
        );
    } catch {
      if (alive.current)
        setError(
          'Request outcome unknown. Refresh state before retrying; no ownership was bypassed.',
        );
    } finally {
      active.current = false;
      if (alive.current) setBusy(false);
    }
  }
  useEffect(() => {
    alive.current = true;
    if (mode === 'conflicts') void request({ type: 'conflicts' });
    if (mode === 'ignores' && binding) void request({ type: 'ignores-view', binding });
    if (mode === 'removal' && binding && !initial.removal)
      void request({ type: 'inspect-disconnect', binding });
    return () => {
      alive.current = false;
    };
  }, []);
  const title =
    mode === 'conflicts'
      ? 'Conflicts'
      : mode === 'ignores'
        ? 'Ignore rules'
        : mode === 'connections'
          ? 'Connections'
          : 'Disconnect folder';
  return (
    <div className="nv-root desktop local-tools">
      <header>
        <strong>Nanosync</strong>
        <ThemeControl />
      </header>
      <main>
        <Button disabled={busy} onClick={onBack}>
          Back to folders
        </Button>
        <h1>{title}</h1>
        {error && <p role="alert">◇ {error}</p>}
        {notice && <p role="status">{notice}</p>}
        {busy && <p role="status">Working at a safe boundary…</p>}
        {snapshot.removal && (
          <section aria-labelledby="pending-removal">
            <h2 id="pending-removal">Incomplete removal — original identities preserved</h2>
            <p>
              Normal work is blocked. Resume this authorized removal; missing markers or records are
              not an empty folder. No rollback is available after cleanup starts.
            </p>
            <p>
              Request {snapshot.removal.requestId}; phase {snapshot.removal.phase}; server{' '}
              {snapshot.removal.serverId ?? 'not removed'}.
            </p>
            <ul>
              {snapshot.removal.bindings.map((item) => (
                <li key={item.connection.connectionId}>
                  {item.connection.root} — local copy {item.connection.connectionId}
                </li>
              ))}
            </ul>
            <Button
              disabled={busy}
              onClick={() =>
                void request({
                  type: 'resume-removal',
                  requestId: snapshot.removal!.requestId,
                  confirmed: true,
                })
              }
            >
              Explicitly resume authorized removal
            </Button>
          </section>
        )}
        {mode === 'conflicts' && (
          <section aria-label="Persistent manual conflicts">
            <p>
              Both versions are preserved. Edit the files you want to keep, deliberately remove or
              rename unwanted copies, then sync. Only applied manifest reconciliation clears a
              conflict. Opening or reading this list never acknowledges resolution.
            </p>
            <Button disabled={busy} onClick={() => void request({ type: 'conflicts' })}>
              Refresh conflicts
            </Button>
            {conflicts?.bindings.map((item) => (
              <section key={item.connectionId}>
                <h2>{item.root}</h2>
                <p>Local copy {item.connectionId}</p>
                {item.issue ? (
                  <p role="alert">
                    ◇ {item.issue}: journal observation unavailable; preserve state and recover with
                    a compatible owner.
                  </p>
                ) : !item.conflicts.length ? (
                  <p>No open conflicts observed.</p>
                ) : (
                  <ul>
                    {item.conflicts.map((conflict) => (
                      <li key={conflict.id}>
                        <strong>{conflict.path}</strong>
                        <p>
                          Conflict {conflict.id}; source revision {conflict.sourceRevisionId}
                        </p>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void request({
                              type: 'open-conflict',
                              binding: item.connectionId,
                              conflict: conflict.id,
                            })
                          }
                        >
                          Open containing folder
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            ))}
          </section>
        )}
        {mode === 'ignores' && binding && (
          <section aria-label="Local exclusions-only rules">
            <p>
              Root-local exclusions only: comments, *, **, ?, slash anchors and directory suffixes.
              No negation, backslashes or character classes. Rules do not delete files or resolve
              conflicts. Interrupted synchronization must recover with its original rules first.
            </p>
            <label htmlFor="ignore-text">.nanosyncignore (maximum 64 KiB UTF-8)</label>
            <textarea
              id="ignore-text"
              rows={14}
              disabled={busy || !rules || !!snapshot.removal}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setValidation(undefined);
              }}
              spellCheck={false}
            />
            <p>Loaded signature: {rules?.fileSignature ?? 'not loaded'}</p>
            <div className="nv-actions">
              <Button
                disabled={busy || !!snapshot.removal}
                onClick={() => void request({ type: 'ignores-view', binding })}
              >
                Reload saved rules (discard draft)
              </Button>
              <Button
                disabled={busy || !rules}
                onClick={() => void request({ type: 'ignores-validate', text })}
              >
                Validate rules
              </Button>
              <Button
                variant="primary"
                disabled={busy || !rules || !validation?.valid || !!snapshot.removal}
                onClick={() =>
                  rules &&
                  void request({
                    type: 'ignores-set',
                    binding,
                    text,
                    expectedFileSignature: rules.fileSignature,
                  })
                }
              >
                Save validated rules
              </Button>
            </div>
            {validation && (
              <p role={validation.valid ? 'status' : 'alert'}>
                {validation.valid
                  ? 'Rules are valid. Save rechecks their current file signature.'
                  : `Invalid rules at line ${validation.line}. Use exclusions-only syntax; patterns are not echoed in errors.`}
              </p>
            )}
          </section>
        )}
        {mode === 'connections' && (
          <section aria-label="Saved server connections">
            <p>
              Removal is local only, not remote revocation. Inspect attached folders before
              confirming.
            </p>
            {snapshot.connections.map((connection) => (
              <article key={connection.serverId}>
                <h2>{connection.alias}</h2>
                <p>{connection.url}</p>
                <p>Server connection {connection.serverId}</p>
                <Button
                  disabled={busy || !!snapshot.removal}
                  onClick={() =>
                    void request({
                      type: 'inspect-server-removal',
                      serverId: connection.serverId,
                    })
                  }
                >
                  Inspect removal
                </Button>
              </article>
            ))}
          </section>
        )}
        {preview && (
          <section aria-labelledby="removal-preview">
            <h2 id="removal-preview">Review local removal</h2>
            <p>
              Full content inventory is rechecked after handoff, under all replica locks. Local
              files, conflict copies, .nanosyncignore and remote data are always preserved.
              Journal/cache and, for server removal, its credentials will be discarded. This does
              not revoke remote device access.
            </p>
            <ul>
              {preview.bindings.map((item) => (
                <li key={item.connection.connectionId}>
                  <strong>{item.connection.root}</strong>
                  <p>
                    Local copy {item.connection.connectionId};{' '}
                    {item.rootAvailable ? 'original root available' : 'root unavailable'};{' '}
                    {item.ownerPresent
                      ? 'live owner — inspection deferred until explicit stop'
                      : item.dirty === null
                        ? 'dirty state unknown'
                        : item.dirty
                          ? 'unsynced work detected'
                          : 'no unsynced content observed'}
                    .
                  </p>
                </li>
              ))}
            </ul>
            <label>
              <input
                type="checkbox"
                checked={force}
                disabled={busy}
                onChange={(event) => setForce(event.target.checked)}
              />{' '}
              Explicitly abandon pending synchronization state (--force). Files remain.
            </label>
            <label>
              <input
                type="checkbox"
                checked={stopOwner}
                disabled={busy}
                onChange={(event) => setStopOwner(event.target.checked)}
              />{' '}
              Explicitly stop affected live owners, including independent CLI work, at a safe
              boundary. Quit never does this.
            </label>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={(event) => setConfirmed(event.target.checked)}
              />{' '}
              I confirm this local removal. It cannot be rolled back after cleanup begins.
            </label>
            <Button
              variant="primary"
              disabled={busy || !confirmed || !!snapshot.removal}
              onClick={() =>
                void request({
                  type: 'remove',
                  selection: preview.selection,
                  force,
                  stopOwner,
                  confirmed: true,
                })
              }
            >
              Confirm local removal
            </Button>
          </section>
        )}
      </main>
    </div>
  );
}
