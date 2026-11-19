import { useEffect, useRef, useState } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import { LocalTools } from './LocalTools';
import { ThemeControl } from '../../../packages/ui-theme/ThemeControl';
import type { ClientSend } from './App';
import type { DesktopCommand, DesktopSnapshot } from './rpc';

type Binding = NonNullable<DesktopSnapshot['status']>['bindings'][number];
const phases: Record<Binding['phase'], string> = {
  'not-started': 'Not started',
  idle: 'Idle',
  syncing: 'Syncing',
  pausing: 'Pausing',
  paused: 'Paused',
  offline: 'Offline — retrying when continuous work is active',
  'credentials-locked': 'Credentials unavailable',
  'folder-unavailable': 'Folder unavailable',
  failed: 'Needs attention',
};
function stateLabel(binding: Binding) {
  return binding.upToDate ? 'Up to date (observed)' : phases[binding.phase];
}
function marker(binding: Binding) {
  return binding.upToDate
    ? '●'
    : binding.phase === 'paused' || binding.phase === 'pausing'
      ? 'Ⅱ'
      : '○';
}
function ownerLabel(binding: Binding) {
  const label = !binding.ownerPresent
    ? 'No active owner observed'
    : binding.owner?.origin === 'cli'
      ? 'Independent CLI owner'
      : binding.owner?.origin === 'desktop'
        ? 'Desktop owner'
        : 'Live owner unavailable';
  return binding.freshness === 'stale-or-unknown' ? `Last observed: ${label}` : label;
}
function time(value: number | null) {
  return value === null ? 'Not observed' : new Date(value).toLocaleString();
}
function folderName(path: string) {
  return path.split('/').filter(Boolean).at(-1) ?? path;
}
function recovery(code: string) {
  if (code === 'FOLDER_UNAVAILABLE')
    return 'Restore the original owned folder and marker, then explicitly retry. The folder will not be recreated.';
  if (code === 'CREDENTIALS_UNAVAILABLE' || code === 'CREDENTIALS_LOCKED')
    return 'Unlock the credential store and ensure Secret Service is available in this login session, then retry. No file fallback is used.';
  if (code === 'VAULT_DELETED')
    return 'The remote vault was deleted. Local files and cached keys are preserved; contact the server owner.';
  if (['UNAUTHORIZED', 'FORBIDDEN'].includes(code))
    return 'Ask the server owner to check device approval and access. Local files are preserved.';
  if (code.startsWith('OWNER_'))
    return 'Stop an unavailable or incompatible owner explicitly and retry. Nanosync will not steal its lock or stop an independent CLI owner on Quit.';
  if (code === 'SYNC_PAUSED')
    return 'Resume the relevant global or folder pause before requesting work.';
  return 'Check access, connectivity and saved state, then explicitly retry. Do not discard local state.';
}
function Attention({ binding, runtime }: { binding: Binding; runtime?: string }) {
  const codes = binding.error ? [binding.error] : [];
  return (
    <>
      {binding.facts === null ? (
        <p>Conflict observation unavailable.</p>
      ) : (
        binding.facts.conflicts > 0 && (
          <p className="attention">
            ◇ {binding.facts.conflicts} unresolved conflict(s). Both versions are preserved; resolve
            files manually and sync. Open Conflicts to inspect preserved copies.
          </p>
        )
      )}
      {codes.map((code) => (
        <p key={code} className={binding.attentionRequired ? 'attention' : undefined}>
          {binding.attentionRequired ? '◇' : '○'} {code}: {recovery(code)}
        </p>
      ))}
      {runtime && runtime !== binding.error && (
        <p>
          Last desktop request issue (historical): {runtime}. {recovery(runtime)}
        </p>
      )}
      {binding.statusIssues.map((issue) => (
        <p key={issue.code}>
          ◇ {issue.message} {issue.recoveryAction}
        </p>
      ))}
    </>
  );
}
function Progress({ binding }: { binding: Binding }) {
  return (
    <div className="folder-progress">
      <p>
        {binding.enginePhase ? `Engine: ${binding.enginePhase}` : 'Engine phase not observed'}.
        Totals unknown.
      </p>
      {binding.progress ? (
        <>
          <p>
            {binding.freshness === 'observed'
              ? 'Observed pass counters'
              : 'Historical pass counters (stale or unknown)'}
            :
          </p>
          <p>
            Uploaded {binding.progress.upload.count} ciphertext frame(s),{' '}
            {binding.progress.upload.bytes} bytes; downloaded {binding.progress.download.count}{' '}
            ciphertext frame(s), {binding.progress.download.bytes} bytes.
          </p>
        </>
      ) : (
        <p>Transfer counters not observed.</p>
      )}
    </div>
  );
}

export function Folders({
  send,
  initial,
  onConnect,
}: {
  send: ClientSend;
  initial?: DesktopSnapshot;
  onConnect(): void;
}) {
  const [snapshot, setSnapshot] = useState(initial);
  const [tools, setTools] = useState<'conflicts' | 'ignores' | 'removal' | 'connections'>();
  const [selectedId, setSelectedId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true),
    epoch = useRef(0),
    reading = useRef(false),
    mutating = useRef(false);
  async function refresh() {
    if (!alive.current || reading.current || mutating.current) return;
    const version = epoch.current;
    reading.current = true;
    try {
      const reply = await send({ type: 'snapshot' });
      if (!alive.current || version !== epoch.current || mutating.current) return;
      if (!reply.ok) {
        setReadError(reply.message);
        return;
      }
      setSnapshot(reply.snapshot);
      setReadError('');
    } catch {
      if (alive.current && version === epoch.current)
        setReadError(
          'Client observation unavailable. Previous data is historical; refresh to retry.',
        );
    } finally {
      reading.current = false;
    }
  }
  useEffect(() => {
    alive.current = true;
    if (!initial) void refresh();
    const timer = setInterval(() => {
      void refresh();
    }, 1500);
    return () => {
      alive.current = false;
      epoch.current++;
      clearInterval(timer);
    };
  }, [send]);
  async function act(command: DesktopCommand, message: string) {
    if (mutating.current) return;
    mutating.current = true;
    const version = ++epoch.current;
    setBusy(true);
    setError('');
    setNotice('');
    let failed = false;
    try {
      const reply = await send(command);
      if (!alive.current || version !== epoch.current) return;
      if (!reply.ok) {
        setError(reply.message);
        failed = true;
        return;
      }
      setSnapshot(reply.snapshot);
      setReadError('');
      setNotice(message);
    } catch {
      if (alive.current) {
        setError(
          'Request outcome unknown. Refresh before retrying; no local takeover was attempted.',
        );
        failed = true;
      }
    } finally {
      mutating.current = false;
      if (alive.current && version === epoch.current) {
        setBusy(false);
        if (failed) void refresh();
      }
    }
  }
  const bindings = (snapshot?.status?.bindings ?? []).map((binding) =>
    readError
      ? {
          ...binding,
          upToDate: false,
          freshness: 'stale-or-unknown' as const,
          enginePhase: null,
        }
      : binding,
  );
  const selected = bindings.find((item) => item.connectionId === selectedId) ?? bindings[0];
  const globalPaused = snapshot?.settings.globalPaused ?? false;
  const server = (binding: Binding) =>
    snapshot?.connections.find((item) => item.serverId === binding.serverId);
  const decision = snapshot?.credentials;
  const secretBlocked =
    !decision ||
    decision.mode !== 'os-store' ||
    decision.migrationPending ||
    decision.cleanupPending;
  if (tools && snapshot)
    return (
      <LocalTools
        send={send}
        initial={snapshot}
        binding={selected?.connectionId}
        mode={tools}
        onBack={() => {
          setTools(undefined);
          void refresh();
        }}
      />
    );
  return (
    <div className="nv-root desktop folders">
      <header>
        <strong>Nanosync</strong>
        <ThemeControl />
      </header>
      <div className="desktop-layout">
        <nav aria-label="Client">
          <strong aria-current="page">Folders</strong>
          <Button
            variant="quiet"
            disabled={busy || !snapshot}
            onClick={() => setTools('conflicts')}
          >
            Conflicts
          </Button>
          <Button
            variant="quiet"
            disabled={busy || !snapshot}
            onClick={() => setTools('connections')}
          >
            Connections / removal
          </Button>
          <Button variant="quiet" disabled={busy} onClick={onConnect}>
            Connections / setup
          </Button>
          <p>Settings integrations — pending</p>
          <Button
            className="quit"
            variant="quiet"
            disabled={busy}
            onClick={() => void act({ type: 'quit' }, 'Quitting safely.')}
          >
            Quit Nanosync
          </Button>
        </nav>
        <main>
          <div className="folders-heading">
            <h1>Folders</h1>
            <Button variant="primary" disabled={busy} onClick={onConnect}>
              Connect folder
            </Button>
          </div>
          <div className="folder-toolbar nv-actions">
            <Button
              disabled={busy || !snapshot}
              onClick={() =>
                snapshot &&
                void act(
                  {
                    type: 'pause-all',
                    paused: !globalPaused,
                    expectedRevision: snapshot.settings.revision,
                  },
                  globalPaused
                    ? 'Global resume saved. Individual folder pauses remain unchanged.'
                    : 'Global pause saved. Active work stops at its next safe boundary.',
                )
              }
            >
              {globalPaused ? 'Resume all' : 'Pause all'}
            </Button>
            <Button disabled={busy} onClick={() => void refresh()}>
              Refresh observed status
            </Button>
          </div>
          {snapshot?.removal && (
            <section className="folder-message">
              <p>
                ◇ Removal incomplete. Original binding identities are preserved; normal work is
                blocked.
              </p>
              <Button disabled={busy} onClick={() => setTools('removal')}>
                Review removal recovery
              </Button>
            </section>
          )}
          {error && <p role="alert">◇ {error}</p>}
          {readError && (
            <p role="alert">◇ {readError} Displayed data is not a current observation.</p>
          )}
          {notice && <p role="status">{notice}</p>}
          {busy && <p role="status">Applying client request…</p>}
          {secretBlocked && (
            <section className="folder-message">
              <p>
                ◇{' '}
                {decision?.migrationPending
                  ? 'Credential migration is incomplete.'
                  : decision?.cleanupPending
                    ? 'Credential cleanup is incomplete.'
                    : decision?.mode === 'protected-file'
                      ? 'This root uses protected-file credentials. Desktop transfers require an explicit whole-root migration; use the CLI unchanged if preferred.'
                      : 'Choose OS credential storage before desktop transfers.'}{' '}
                Non-secret observations and pause intent do not unlock or probe the store.
              </p>
              <Button disabled={busy} onClick={onConnect}>
                Review credential decision
              </Button>
            </section>
          )}
          {!snapshot ? (
            <p>Reading client state…</p>
          ) : (
            <>
              <p className="observation">
                Observed snapshot: {time(snapshot.status?.observedAt ?? null)}. Facts can change
                after observation.
              </p>
              {snapshot.status === null ? (
                <p>
                  Folder inventory unavailable until the credential decision or recovery barrier is
                  resolved. Saved state is not treated as empty.
                </p>
              ) : !bindings.length ? (
                <p>
                  No connected folders. Connect an existing local folder; no transfer starts until
                  you explicitly request work.
                </p>
              ) : (
                <div className="folder-workspace">
                  <section aria-label="Connected folders">
                    <ul className="folder-list">
                      {bindings.map((binding) => (
                        <li key={binding.connectionId}>
                          <button
                            className="folder-row"
                            disabled={busy}
                            aria-pressed={selected?.connectionId === binding.connectionId}
                            onClick={() => setSelectedId(binding.connectionId)}
                          >
                            <strong>{folderName(binding.root)}</strong>
                            <span className="folder-path">{binding.root}</span>
                            <span>
                              {server(binding)?.alias ?? 'Server alias unavailable'} / vault{' '}
                              {binding.vaultId}
                            </span>
                            <span>
                              <span
                                aria-hidden="true"
                                className={binding.upToDate ? 'healthy-marker' : undefined}
                              >
                                {marker(binding)}
                              </span>{' '}
                              {stateLabel(binding)} —{' '}
                              {binding.freshness === 'observed' ? 'observed' : 'stale or unknown'}
                            </span>
                            <span>{ownerLabel(binding)}</span>
                            {binding.pause.effective && (
                              <span>
                                Ⅱ {binding.pause.global ? 'Global pause active' : ''}
                                {binding.pause.global && binding.pause.binding ? '; ' : ''}
                                {binding.pause.binding ? 'Folder pause active' : ''}
                              </span>
                            )}
                            {(binding.facts?.conflicts ?? 0) > 0 && (
                              <span className="attention">
                                ◇ {binding.facts!.conflicts} conflict(s)
                              </span>
                            )}
                            {(binding.error || binding.statusIssues.length > 0) && (
                              <span className={binding.attentionRequired ? 'attention' : undefined}>
                                {binding.attentionRequired ? '◇ Needs attention' : '○ Last issue'}:{' '}
                                {binding.error ?? 'observation unavailable'}
                              </span>
                            )}
                            {snapshot.runtimeErrors[binding.connectionId] &&
                              snapshot.runtimeErrors[binding.connectionId] !== binding.error && (
                                <span>
                                  Last desktop request issue (historical):{' '}
                                  {snapshot.runtimeErrors[binding.connectionId]}
                                </span>
                              )}
                            {binding.progress && (
                              <span>
                                Uploaded {binding.progress.upload.bytes} / downloaded{' '}
                                {binding.progress.download.bytes} ciphertext bytes; totals unknown
                              </span>
                            )}
                            <span>Last success: {time(binding.lastSuccessfulSync)}</span>
                          </button>
                        </li>
                      ))}
                    </ul>
                  </section>
                  {selected && (
                    <aside className="folder-inspector" aria-labelledby="folder-details">
                      <h2 id="folder-details">{folderName(selected.root)}</h2>
                      <p>
                        <span
                          aria-hidden="true"
                          className={selected.upToDate ? 'healthy-marker' : undefined}
                        >
                          {marker(selected)}
                        </span>{' '}
                        {stateLabel(selected)}.{' '}
                        {selected.freshness === 'observed'
                          ? 'Observed facts, not a live guarantee.'
                          : 'Observation stale or unknown.'}
                      </p>
                      <Attention
                        binding={selected}
                        runtime={snapshot.runtimeErrors[selected.connectionId]}
                      />
                      <dl>
                        <dt>Local folder</dt>
                        <dd>{selected.root}</dd>
                        <dt>Server</dt>
                        <dd>
                          {server(selected)?.alias ?? 'Alias unavailable'}
                          <br />
                          {server(selected)?.url ?? 'URL unavailable'}
                        </dd>
                        <dt>Server connection ID</dt>
                        <dd>{selected.serverId}</dd>
                        <dt>Remote vault ID</dt>
                        <dd>{selected.vaultId} (name not cached locally)</dd>
                        <dt>Local copy ID</dt>
                        <dd>{selected.connectionId}</dd>
                        <dt>Device ID</dt>
                        <dd>{selected.deviceId}</dd>
                        <dt>Owner</dt>
                        <dd>
                          {ownerLabel(selected)}
                          {selected.owner && (
                            <>
                              <br />
                              {selected.owner.instanceId}
                            </>
                          )}
                        </dd>
                        <dt>Pause causes</dt>
                        <dd>
                          Global: {selected.pause.global ? 'on' : 'off'}; folder:{' '}
                          {selected.pause.binding ? 'on' : 'off'}. Effective pause:{' '}
                          {selected.pause.effective ? 'on' : 'off'}.
                        </dd>
                        <dt>Last successful sync</dt>
                        <dd>{time(selected.lastSuccessfulSync)}</dd>
                        <dt>Last remote check</dt>
                        <dd>{time(selected.lastRemoteCheck)}</dd>
                        <dt>Binding observation</dt>
                        <dd>{time(selected.observationTime)}</dd>
                      </dl>
                      <Progress binding={selected} />
                      <div className="nv-stack folder-actions">
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              {
                                type: 'pause-folder',
                                binding: selected.connectionId,
                                paused: !selected.pause.binding,
                                expectedRevision: snapshot.settings.revision,
                              },
                              selected.pause.binding
                                ? globalPaused
                                  ? 'Folder resume saved. Global pause remains active; no new work starts.'
                                  : 'Folder resume saved.'
                                : 'Folder pause saved. Active work stops at its next safe boundary.',
                            )
                          }
                        >
                          {selected.pause.binding ? 'Resume folder' : 'Pause folder'}
                        </Button>
                        {globalPaused && (
                          <p>
                            Global pause still blocks both directions. Resuming this folder does not
                            resume all folders.
                          </p>
                        )}
                        <Button
                          disabled={busy || !!secretBlocked}
                          onClick={() =>
                            void act(
                              { type: 'start', binding: selected.connectionId },
                              'Continuous request accepted by the actual owner. Check observed health separately.',
                            )
                          }
                        >
                          Start continuous syncing
                        </Button>
                        <Button
                          disabled={busy || !!secretBlocked}
                          onClick={() =>
                            void act(
                              {
                                type: 'sync-now',
                                binding: selected.connectionId,
                              },
                              'One-shot pass completed. This does not enable continuous intent or prove current health.',
                            )
                          }
                        >
                          Sync now
                        </Button>
                        <Button
                          disabled={busy}
                          onClick={() =>
                            void act(
                              {
                                type: 'open-folder',
                                binding: selected.connectionId,
                              },
                              'Checked folder opened in the system file manager.',
                            )
                          }
                        >
                          Open local folder
                        </Button>
                      </div>
                      <div className="nv-actions">
                        <Button disabled={busy} onClick={() => setTools('ignores')}>
                          Edit ignore rules
                        </Button>
                        <Button disabled={busy} onClick={() => setTools('removal')}>
                          Inspect disconnect
                        </Button>
                      </div>
                      <details>
                        <summary>Saved lifecycle intent</summary>
                        <p>
                          Login: {snapshot.settings.lifecycle.startAtLogin ? 'requested' : 'off'};
                          tray:{' '}
                          {snapshot.settings.lifecycle.trayEnabled === null
                            ? 'not chosen'
                            : snapshot.settings.lifecycle.trayEnabled
                              ? 'requested'
                              : 'off'}
                          ; background after close:{' '}
                          {snapshot.settings.lifecycle.keepSyncingAfterClose ? 'requested' : 'off'}.
                          Startup/tray are not installed; background policy is not applied. Closing
                          currently safely quits.
                        </p>
                      </details>
                    </aside>
                  )}
                </div>
              )}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
