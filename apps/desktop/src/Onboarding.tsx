import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../../packages/admin-ui/src/paper/Button';
import { TextField } from '../../../packages/admin-ui/src/paper/TextField';
import { Dialog } from '../../../packages/admin-ui/src/paper/Dialog';
import { ThemeControl } from '../../../packages/ui-theme/ThemeControl';
import type { RemoteVault, LifecyclePreferences } from '@nanosync/client-service';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from './rpc';

export function Onboarding({
  send,
  onDone,
  onCancel,
}: {
  send(command: DesktopCommand): Promise<DesktopReply>;
  onDone(): void;
  onCancel(): void;
}) {
  const [snapshot, setSnapshot] = useState<DesktopSnapshot>();
  const [step, setStep] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [url, setUrl] = useState('');
  const [alias, setAlias] = useState('');
  const [deviceName, setDeviceName] = useState('');
  const [serverId, setServerId] = useState('');
  const [vaults, setVaults] = useState<RemoteVault[]>([]);
  const [vaultId, setVaultId] = useState('');
  const [keyState, setKeyState] = useState<{
    keyRequired: boolean;
    credentialWritePending: boolean;
  }>();
  const [folder, setFolder] = useState<{ selection: string; path: string; nonempty: boolean }>();
  const [acknowledged, setAcknowledged] = useState(false);
  const [enrollmentRetry, setEnrollmentRetry] = useState(false);
  const [keyRetry, setKeyRetry] = useState(false);
  const [freshConfirmed, setFreshConfirmed] = useState(false);
  const [binding, setBinding] = useState('');
  const [lifecycle, setLifecycle] = useState<LifecyclePreferences>({
    startAtLogin: false,
    trayEnabled: null,
    keepSyncingAfterClose: true,
  });
  const [lifecycleBase, setLifecycleBase] = useState(0);
  const [confirmation, setConfirmation] = useState<
    'migrate' | 'resume-migration' | 'rollback-migration' | 'resume-cleanup'
  >();
  const [migrationConfirmed, setMigrationConfirmed] = useState(false);
  const password = useRef<HTMLInputElement>(null);
  const recovery = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const sequence = useRef(0);
  function clearSecrets() {
    if (password.current) password.current.value = '';
    if (recovery.current) recovery.current.value = '';
  }
  async function request(command: DesktopCommand) {
    const current = ++sequence.current;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const reply = await send(command);
      if (current !== sequence.current) return;
      if (!reply.ok) {
        setError(reply.message);
        return;
      }
      setSnapshot(reply.snapshot);
      return reply;
    } catch {
      if (current === sequence.current)
        setError('The desktop connection was interrupted. Refresh before retrying.');
    } finally {
      if (command.type === 'enroll') command.password = '';
      if (command.type === 'unlock') command.recovery = '';
      if (current === sequence.current) {
        clearSecrets();
        setBusy(false);
      }
    }
  }
  useEffect(() => {
    void request({ type: 'snapshot' }).then((reply) => {
      if (reply) setLifecycle(reply.snapshot.settings.lifecycle);
    });
    return () => {
      sequence.current++;
      clearSecrets();
    };
  }, []);
  useEffect(() => {
    clearSecrets();
    heading.current?.focus();
  }, [step]);
  function move(next: number) {
    clearSecrets();
    setEnrollmentRetry(false);
    setKeyRetry(false);
    setFreshConfirmed(false);
    setError('');
    setStep(next);
  }
  function resetEnrollmentConsent() {
    clearSecrets();
    setEnrollmentRetry(false);
    setFreshConfirmed(false);
  }
  function backgroundChoices() {
    if (!snapshot) return;
    setLifecycle({ ...snapshot.settings.lifecycle });
    setLifecycleBase(snapshot.settings.revision);
    move(4);
  }
  async function refreshClient() {
    const reply = await request({ type: 'snapshot' });
    if (reply && step === 4) {
      setLifecycle({ ...reply.snapshot.settings.lifecycle });
      setLifecycleBase(reply.snapshot.settings.revision);
    }
  }
  async function selectServer(id: string) {
    setServerId(id);
    setVaultId('');
    setKeyState(undefined);
    setAcknowledged(false);
    setBinding('');
    setKeyRetry(false);
    resetEnrollmentConsent();
    const reply = await request({ type: 'vaults', serverId: id });
    if (reply) {
      setVaults(reply.vaults ?? []);
      move(3);
    }
  }
  async function enroll(event?: FormEvent, fresh = false) {
    event?.preventDefault();
    const secret = password.current?.value ?? '';
    clearSecrets();
    setEnrollmentRetry(false);
    setFreshConfirmed(false);
    const reply = await request({
      type: 'enroll',
      url,
      alias,
      deviceName,
      password: secret,
      fresh,
      retryCredentialWrite: enrollmentRetry,
    });
    if (reply) {
      const result = reply.enrollment;
      if (!result) {
        setError('Invalid enrollment result. Refresh client state before retrying.');
        return;
      }
      setUrl(result.url);
      setAlias(result.alias);
      if (result.status !== 'approved') setDeviceName(result.deviceName);
      setServerId(result.status === 'approved' ? result.serverId : '');
      move(2);
    }
  }
  async function chooseVault(id: string) {
    setVaultId(id);
    setKeyState(undefined);
    setAcknowledged(false);
    setBinding('');
    setKeyRetry(false);
    if (!id) return;
    const reply = await request({ type: 'key-status', serverId, vaultId: id });
    if (reply) setKeyState(reply.key);
  }
  async function unlock(event: FormEvent) {
    event.preventDefault();
    const secret = recovery.current?.value ?? '';
    clearSecrets();
    setKeyRetry(false);
    const reply = await request({
      type: 'unlock',
      serverId,
      vaultId,
      recovery: secret,
      retryCredentialWrite: keyRetry,
    });
    if (reply) setKeyState(reply.key);
  }
  async function finish(start: boolean) {
    let connected = binding;
    if (!connected && folder) {
      const reply = await request({
        type: 'connect',
        serverId,
        vaultId,
        selection: folder.selection,
        confirmNonempty: acknowledged,
      });
      if (!reply?.binding) return;
      connected = reply.binding;
      setBinding(connected);
    }
    if (!connected) return;
    if (start) {
      const reply = await request({ type: 'start', binding: connected });
      if (!reply) return;
    }
    setNotice(
      start
        ? 'Continuous sync accepted. Current health is shown below.'
        : 'Connected; no files transferred. Start syncing only when you are ready.',
    );
    onDone();
  }
  const pending = snapshot?.pending.find((item) => item.alias === alias);
  const credentials = snapshot?.credentials;
  const blocked =
    credentials &&
    (credentials.mode !== 'os-store' || credentials.migrationPending || credentials.cleanupPending);
  const canProceed =
    vaultId &&
    keyState &&
    !keyState.keyRequired &&
    !keyState.credentialWritePending &&
    folder &&
    (!folder.nonempty || acknowledged);
  const titles = [
    'Server',
    'Verify device',
    'Vault and folder',
    'Background choices',
    'Ready to sync',
  ];
  return (
    <div className="nv-root desktop">
      <header>
        <strong>Nanosync</strong>
        <ThemeControl />
      </header>
      <div className="desktop-layout">
        <nav aria-label="Client">
          <strong>Connect folder</strong>
          <Button variant="quiet" disabled={busy} onClick={onCancel}>
            Return to folders
          </Button>
          <p>Shared desktop / CLI state</p>
          <Button variant="quiet" disabled={busy} onClick={() => void request({ type: 'quit' })}>
            Quit Nanosync
          </Button>
        </nav>
        <main aria-busy={busy}>
          <h1 ref={heading} tabIndex={-1}>
            {blocked ? 'Credential storage' : titles[step - 1]}
          </h1>
          {error && (
            <>
              <p role="alert">◇ {error}</p>
              <Button disabled={busy} variant="quiet" onClick={() => void refreshClient()}>
                Refresh client state
              </Button>
            </>
          )}
          {notice && <p role="status">{notice}</p>}
          {busy && <p role="status">Working…</p>}
          {busy && (step === 1 || step === 2) && !blocked && (
            <Button
              onClick={() => {
                resetEnrollmentConsent();
                void request({ type: 'cancel-enrollment' });
              }}
            >
              Cancel active enrollment
            </Button>
          )}
          {!snapshot ? (
            <Button disabled={busy} onClick={() => void request({ type: 'snapshot' })}>
              Load client state
            </Button>
          ) : blocked ? (
            <section className="setup nv-stack">
              <p>
                Client state: <code>{snapshot.clientRoot}</code>
              </p>
              {credentials?.mode === 'uninitialized' && (
                <>
                  <p>
                    New desktop connections use your Linux OS credential store. Secret Service must
                    be available in this login session. There is no protected-file fallback.
                  </p>
                  <Button disabled={busy} onClick={() => void request({ type: 'initialize' })}>
                    Use OS credential store
                  </Button>
                </>
              )}
              {credentials?.mode === 'protected-file' && !credentials.migrationPending && (
                <>
                  <p>
                    This entire client root uses protected files, not OS-store encryption. Desktop
                    enrollment and syncing require explicit whole-root migration. Future headless
                    CLI secret access will require the unlocked user session. Stop all owners and
                    older executables first.
                  </p>
                  <p>
                    Migration temporarily stages duplicate secrets for crash recovery; storage
                    remnants and backups cannot be guaranteed erased.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setMigrationConfirmed(false);
                      setConfirmation('migrate');
                    }}
                  >
                    Migrate entire root to OS store…
                  </Button>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      clearSecrets();
                      setNotice(
                        'Client state left unchanged. Continue using the CLI with protected-file credentials.',
                      );
                    }}
                  >
                    Leave unchanged; use CLI
                  </Button>
                </>
              )}
              {credentials?.migrationPending && (
                <>
                  <p>
                    Migration interrupted: {credentials.phase}. Ordinary operations remain blocked.{' '}
                    {credentials.canRollback
                      ? 'Resume or explicitly remove staged target items and keep protected files.'
                      : 'Source cleanup has begun: resume forward only.'}
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setMigrationConfirmed(false);
                      setConfirmation('resume-migration');
                    }}
                  >
                    Resume migration…
                  </Button>
                  {credentials.canRollback && (
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setMigrationConfirmed(false);
                        setConfirmation('rollback-migration');
                      }}
                    >
                      Roll back staged migration…
                    </Button>
                  )}
                </>
              )}
              {credentials?.cleanupPending && (
                <>
                  <p>
                    Previously authorized credential cleanup is incomplete. Resume it without
                    reenrolling or replacing keys.
                  </p>
                  <Button
                    disabled={busy}
                    onClick={() => {
                      setMigrationConfirmed(false);
                      setConfirmation('resume-cleanup');
                    }}
                  >
                    Resume credential cleanup…
                  </Button>
                </>
              )}
              <Button
                disabled={busy}
                variant="quiet"
                onClick={() => void request({ type: 'snapshot' })}
              >
                Refresh credential state
              </Button>
            </section>
          ) : (
            <>
              {step <= 5 && (
                <ol className="steps" aria-label="Setup steps">
                  {titles.map((title, index) => (
                    <li key={title} aria-current={step === index + 1 ? 'step' : undefined}>
                      {index + 1}. {title}
                    </li>
                  ))}
                </ol>
              )}
              <section className="setup nv-stack">
                {step === 1 && (
                  <>
                    {!!snapshot.connections.length && (
                      <div className="nv-stack">
                        <h2>Use an approved connection</h2>
                        {snapshot.connections.map((item) => (
                          <Button
                            disabled={busy}
                            key={item.serverId}
                            onClick={() => void selectServer(item.serverId)}
                          >
                            {item.alias} — {item.url}
                          </Button>
                        ))}
                      </div>
                    )}
                    {!!snapshot.pending.length && (
                      <div className="nv-stack">
                        <h2>Resume enrollment</h2>
                        {snapshot.pending.map((item) => (
                          <Button
                            disabled={busy}
                            key={item.deviceId}
                            onClick={() => {
                              setUrl(item.url);
                              setAlias(item.alias);
                              setDeviceName(item.deviceName);
                              setServerId('');
                              move(2);
                            }}
                          >
                            {item.alias} — {item.status}
                          </Button>
                        ))}
                      </div>
                    )}
                    <form className="nv-stack" onSubmit={(event) => void enroll(event)}>
                      <TextField
                        label="Server URL"
                        disabled={busy}
                        required
                        value={url}
                        onChange={(event) => {
                          setUrl(event.target.value);
                          resetEnrollmentConsent();
                        }}
                        autoComplete="url"
                      />
                      <TextField
                        label="Connection alias"
                        disabled={busy}
                        required
                        maxLength={128}
                        value={alias}
                        onChange={(event) => {
                          setAlias(event.target.value);
                          resetEnrollmentConsent();
                        }}
                      />
                      <TextField
                        label="Device name"
                        disabled={busy}
                        required
                        maxLength={128}
                        value={deviceName}
                        onChange={(event) => {
                          setDeviceName(event.target.value);
                          resetEnrollmentConsent();
                        }}
                      />
                      <TextField
                        label="Owner password"
                        disabled={busy}
                        type="password"
                        ref={password}
                        autoComplete="off"
                        aria-describedby="password-hint"
                      />
                      <small id="password-hint">
                        Used only for this enrollment; never saved as a form draft.
                      </small>
                      <label>
                        <input
                          disabled={busy}
                          type="checkbox"
                          checked={enrollmentRetry}
                          onChange={(event) => setEnrollmentRetry(event.target.checked)}
                        />{' '}
                        Explicitly retry an interrupted initial credential write
                      </label>
                      <Button type="submit" variant="primary" disabled={busy}>
                        Enroll device
                      </Button>
                    </form>
                  </>
                )}
                {step === 2 && (
                  <>
                    <p>
                      Approval happens outside this application. Ask the server owner to verify this
                      device and approve it. Listing pending requests does not refresh approval.
                    </p>
                    {pending && (
                      <>
                        <p>
                          Status: <strong>{pending.status}</strong>
                        </p>
                        <p>
                          Verification code:{' '}
                          <strong className="verification">{pending.verificationCode}</strong>
                        </p>
                        <p>Device: {pending.deviceName}</p>
                      </>
                    )}
                    {!!serverId && <p role="status">Device approved.</p>}
                    {snapshot.administration.includes(url) ? (
                      <Button
                        disabled={busy}
                        onClick={() => void request({ type: 'administration', urlIdentity: url })}
                      >
                        Open advertised administration page
                      </Button>
                    ) : (
                      <p>
                        Administration link unavailable. Approval remains an external server-owner
                        action.
                      </p>
                    )}
                    {!serverId && (
                      <Button disabled={busy} onClick={() => void enroll()}>
                        Check approval / resume
                      </Button>
                    )}
                    {(pending?.status === 'denied' || pending?.status === 'expired') && (
                      <form
                        className="nv-stack"
                        onSubmit={(event) => {
                          event.preventDefault();
                          if (freshConfirmed) void enroll(undefined, true);
                        }}
                      >
                        <p>
                          A fresh request replaces this terminal pending identity only after
                          confirmation.
                        </p>
                        <TextField
                          label="Owner password for fresh request"
                          disabled={busy}
                          type="password"
                          ref={password}
                          autoComplete="off"
                          required
                        />
                        <label>
                          <input
                            disabled={busy}
                            type="checkbox"
                            checked={freshConfirmed}
                            onChange={(event) => setFreshConfirmed(event.target.checked)}
                          />{' '}
                          Replace the denied or expired request
                        </label>
                        <Button type="submit" disabled={busy || !freshConfirmed}>
                          Start fresh enrollment
                        </Button>
                      </form>
                    )}
                    {!!serverId && (
                      <Button
                        variant="primary"
                        disabled={busy}
                        onClick={() => void selectServer(serverId)}
                      >
                        Choose vault and folder
                      </Button>
                    )}
                    <Button
                      onClick={() => {
                        resetEnrollmentConsent();
                        void request({ type: 'cancel-enrollment' });
                      }}
                    >
                      Cancel waiting; retain pending identity
                    </Button>
                    <Button disabled={busy} variant="quiet" onClick={() => move(1)}>
                      Back
                    </Button>
                  </>
                )}
                {step === 3 && (
                  <>
                    <div className="nv-field">
                      <label htmlFor="remote-vault">Remote vault</label>
                      <select
                        id="remote-vault"
                        disabled={busy}
                        value={vaultId}
                        onChange={(event) => void chooseVault(event.target.value)}
                      >
                        <option value="">Choose an approved remote vault</option>
                        {vaults.map((item) => (
                          <option key={item.vaultId} value={item.vaultId}>
                            {item.name} — {item.vaultId}
                          </option>
                        ))}
                      </select>
                    </div>
                    {!vaults.length && (
                      <p>
                        No vaults available. Ask the server owner to grant access to an existing
                        vault.
                      </p>
                    )}
                    {vaultId && !keyState && (
                      <Button disabled={busy} onClick={() => void chooseVault(vaultId)}>
                        Retry vault key check
                      </Button>
                    )}
                    {(keyState?.keyRequired || keyState?.credentialWritePending) && (
                      <form className="nv-stack" onSubmit={(event) => void unlock(event)}>
                        <p>
                          {keyState.credentialWritePending
                            ? 'A key write was interrupted. Explicit retry is required.'
                            : 'This device has no key for the selected vault.'}{' '}
                          This recovery key is not your owner password.
                        </p>
                        <TextField
                          label="Vault recovery key"
                          disabled={busy}
                          type="password"
                          ref={recovery}
                          autoComplete="off"
                          required
                        />
                        {keyState.credentialWritePending && (
                          <label>
                            <input
                              disabled={busy}
                              type="checkbox"
                              checked={keyRetry}
                              onChange={(event) => setKeyRetry(event.target.checked)}
                            />{' '}
                            Retry the interrupted credential write
                          </label>
                        )}
                        <Button
                          type="submit"
                          disabled={busy || (keyState.credentialWritePending && !keyRetry)}
                        >
                          Unlock vault
                        </Button>
                      </form>
                    )}
                    {keyState && !keyState.keyRequired && !keyState.credentialWritePending && (
                      <p>Vault key available in OS credential storage.</p>
                    )}
                    <Button
                      disabled={busy}
                      onClick={() => {
                        setAcknowledged(false);
                        void request({ type: 'pick-folder' }).then((reply) => {
                          if (reply?.folder) setFolder(reply.folder);
                          if (reply?.cancelled)
                            setNotice('Folder selection cancelled; nothing changed.');
                        });
                      }}
                    >
                      Choose existing local folder…
                    </Button>
                    {folder && (
                      <>
                        <p>
                          Local folder: <code>{folder.path}</code>
                        </p>
                        <p>
                          Connecting transfers nothing. The first sync reconciles local and remote
                          contents; existing local files participate.
                        </p>
                        {folder.nonempty && (
                          <label>
                            <input
                              disabled={busy}
                              type="checkbox"
                              checked={acknowledged}
                              onChange={(event) => setAcknowledged(event.target.checked)}
                            />{' '}
                            I understand this folder already contains files and they will
                            participate in synchronization.
                          </label>
                        )}
                      </>
                    )}
                    <Button
                      disabled={busy || !canProceed}
                      variant="primary"
                      onClick={backgroundChoices}
                    >
                      Background choices
                    </Button>
                    <Button disabled={busy} variant="quiet" onClick={() => move(1)}>
                      Back to connections
                    </Button>
                  </>
                )}
                {step === 4 && (
                  <>
                    <label>
                      <input
                        disabled={busy}
                        type="checkbox"
                        checked={lifecycle.startAtLogin}
                        onChange={(event) =>
                          setLifecycle({ ...lifecycle, startAtLogin: event.target.checked })
                        }
                      />{' '}
                      Start at user login (not before login)
                    </label>
                    <fieldset disabled={busy}>
                      <legend>Request a tray icon?</legend>
                      {[true, false].map((choice) => (
                        <label key={String(choice)}>
                          <input
                            type="radio"
                            name="tray"
                            checked={lifecycle.trayEnabled === choice}
                            onChange={() => setLifecycle({ ...lifecycle, trayEnabled: choice })}
                          />{' '}
                          {choice ? 'Yes' : 'No'}
                        </label>
                      ))}
                    </fieldset>
                    <label>
                      <input
                        disabled={busy}
                        type="checkbox"
                        checked={lifecycle.keepSyncingAfterClose}
                        onChange={(event) =>
                          setLifecycle({
                            ...lifecycle,
                            keepSyncingAfterClose: event.target.checked,
                          })
                        }
                      />{' '}
                      Keep syncing after closing the window
                    </label>
                    <p>
                      Saved intent is separate from native availability; see Settings — General for actual effects.
                      With background on, Close hides even without a tray; the launcher reopens it.
                      With it off, Close safely quits. Explicit Quit stops only this desktop's runners,
                      never an independent CLI owner.
                    </p>
                    <Button
                      disabled={busy || lifecycle.trayEnabled === null}
                      variant="primary"
                      onClick={() =>
                        void request({
                          type: 'settings',
                          lifecycle,
                          expectedRevision: lifecycleBase,
                        }).then((reply) => {
                          if (reply) move(5);
                        })
                      }
                    >
                      Save choices and review
                    </Button>
                    <Button disabled={busy} variant="quiet" onClick={() => move(3)}>
                      Back
                    </Button>
                  </>
                )}
                {step === 5 && (
                  <>
                    <dl>
                      <dt>Connection</dt>
                      <dd>
                        {snapshot.connections.find((item) => item.serverId === serverId)?.alias}
                      </dd>
                      <dt>Vault</dt>
                      <dd>{vaults.find((item) => item.vaultId === vaultId)?.name}</dd>
                      <dt>Local folder</dt>
                      <dd>{folder?.path}</dd>
                      <dt>Saved intentions</dt>
                      <dd>
                        Login: {snapshot.settings.lifecycle.startAtLogin ? 'requested' : 'off'};
                        tray: {snapshot.settings.lifecycle.trayEnabled ? 'requested' : 'off'};
                        background after close:{' '}
                        {snapshot.settings.lifecycle.keepSyncingAfterClose ? 'requested' : 'off'}.
                        {snapshot.lifecycle
                          ? ` Startup: ${snapshot.lifecycle.startup.message} Tray: ${snapshot.lifecycle.tray.message} Session: ${snapshot.lifecycle.session.message}`
                          : ' Native effects have not been observed.'}
                      </dd>
                    </dl>
                    <p>
                      No transfer has started. Finish connects only; Start explicitly requests
                      continuous syncing.
                    </p>
                    <div className="nv-actions">
                      <Button disabled={busy} onClick={() => void finish(false)}>
                        Finish without syncing
                      </Button>
                      <Button variant="primary" disabled={busy} onClick={() => void finish(true)}>
                        Start syncing
                      </Button>
                    </div>
                    {binding && (
                      <p>Folder already connected. Retry Start without creating another binding.</p>
                    )}
                    <Button
                      disabled={busy || !!binding}
                      variant="quiet"
                      onClick={backgroundChoices}
                    >
                      Back
                    </Button>
                  </>
                )}
              </section>
            </>
          )}
        </main>
      </div>
      <Dialog
        open={!!confirmation}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmation(undefined);
            setMigrationConfirmed(false);
          }
        }}
        title="Confirm credential operation"
        description="This applies to the entire shared client root. No automatic plaintext fallback is permitted."
      >
        <p>{snapshot?.clientRoot}</p>
        <p>
          {confirmation === 'rollback-migration'
            ? 'Remove staged OS credentials and retain original protected-file mode. This is only possible before source cleanup.'
            : confirmation === 'resume-cleanup'
              ? 'Complete the previously authorized removal of unused credential records. This does not remotely revoke access.'
              : 'Move or resume moving all device, enrollment and vault credentials into the OS store. Temporary staging duplicates are required. Future headless CLI use requires the unlocked login session. Stop all owners and old executables first.'}
        </p>
        <label>
          <input
            disabled={busy}
            type="checkbox"
            checked={migrationConfirmed}
            onChange={(event) => setMigrationConfirmed(event.target.checked)}
          />{' '}
          I understand and authorize this whole-root operation
        </label>
        <div className="nv-actions">
          <Button
            disabled={busy || !migrationConfirmed}
            onClick={() => {
              const action = confirmation;
              setConfirmation(undefined);
              setMigrationConfirmed(false);
              if (action) void request({ type: action, confirmed: true });
            }}
          >
            Confirm
          </Button>
          <Button
            disabled={busy}
            onClick={() => {
              setConfirmation(undefined);
              setMigrationConfirmed(false);
            }}
          >
            Cancel
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
