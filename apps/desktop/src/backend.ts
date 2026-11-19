import { randomUUID } from 'node:crypto';
import { lstatSync, existsSync } from 'node:fs';
import {
  ClientError,
  onboardingSnapshot,
  requireDesktopCredentials,
  initializeCredentials,
  migrateCredentials,
  resumeCredentialMigration,
  rollbackCredentialMigration,
  resumeCredentialCleanup,
  enrollServer,
  baseUrl,
  server,
  listRemoteVaults,
  vaultKeyStatus,
  unlockVault,
  inspectDestination,
  connectRegisteredVault,
  setLifecycle,
  setPaused,
  checkedBindingRoot,
  listConflicts,
  checkedConflictFolder,
  viewIgnores,
  validateIgnoreText,
  setIgnores,
  inspectRemoval,
  resumeRemoval,
  disconnectConnections,
  removeServerConnection,
  stopBoundSyncForRemoval,
  withCredentialRegistry,
  openBoundSync,
  records,
  readPreferences,
  stopOwnedSync,
  type CredentialOptions,
  type BoundSyncSession,
} from '@nanosync/client-service';
import { PROTOCOL_ERROR_CODES } from '@nanosync/protocol';
import type { DesktopCommand, DesktopReply, DesktopSnapshot } from './rpc';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const fields: Record<DesktopCommand['type'], string[]> = {
  snapshot: [],
  initialize: [],
  'cancel-enrollment': [],
  'pick-folder': [],
  quit: [],
  migrate: ['confirmed'],
  'resume-migration': ['confirmed'],
  'rollback-migration': ['confirmed'],
  'resume-cleanup': ['confirmed'],
  enroll: ['url', 'alias', 'deviceName', 'password', 'fresh', 'retryCredentialWrite'],
  vaults: ['serverId'],
  'key-status': ['serverId', 'vaultId'],
  unlock: ['serverId', 'vaultId', 'recovery', 'retryCredentialWrite'],
  connect: ['serverId', 'vaultId', 'selection', 'confirmNonempty'],
  settings: ['lifecycle', 'expectedRevision'],
  start: ['binding'],
  'sync-now': ['binding'],
  'open-folder': ['binding'],
  'pause-all': ['paused', 'expectedRevision'],
  'pause-folder': ['binding', 'paused', 'expectedRevision'],
  conflicts: [],
  'open-conflict': ['binding', 'conflict'],
  'ignores-view': ['binding'],
  'ignores-validate': ['text'],
  'ignores-set': ['binding', 'text', 'expectedFileSignature'],
  'inspect-disconnect': ['binding'],
  'inspect-server-removal': ['serverId'],
  remove: ['selection', 'force', 'stopOwner', 'confirmed'],
  'resume-removal': ['requestId', 'confirmed'],
  administration: ['urlIdentity'],
};
export function validateCommand(value: unknown): DesktopCommand {
  const invalid = () => {
    throw new ClientError('INVALID_INPUT', 'Invalid client request.');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return invalid();
  const object = value as Record<string, unknown>;
  if (typeof object.type !== 'string' || !Object.hasOwn(fields, object.type)) return invalid();
  const keys = ['type', ...fields[object.type as DesktopCommand['type']]];
  if (Object.keys(object).sort().join(',') !== keys.sort().join(',')) return invalid();
  for (const [name, item] of Object.entries(object)) {
    if (name === 'text') {
      if (typeof item !== 'string' || Buffer.byteLength(item) > 65536) return invalid();
    } else if (name === 'expectedFileSignature') {
      if (typeof item !== 'string' || !/^(absent|[0-9a-f]{64})$/.test(item)) return invalid();
    } else if (
      ['serverId', 'vaultId', 'selection', 'binding', 'conflict', 'requestId'].includes(name)
    ) {
      if (typeof item !== 'string' || !UUID.test(item)) return invalid();
    } else if (
      ['fresh', 'retryCredentialWrite', 'confirmNonempty', 'paused', 'force', 'stopOwner'].includes(
        name,
      )
    ) {
      if (typeof item !== 'boolean') return invalid();
    } else if (name === 'confirmed') {
      if (item !== true) return invalid();
    } else if (name === 'expectedRevision') {
      if (!Number.isSafeInteger(item) || (item as number) < 0) return invalid();
    } else if (name === 'lifecycle') {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        Object.keys(item).sort().join(',') !== 'keepSyncingAfterClose,startAtLogin,trayEnabled' ||
        Object.values(item).some((choice) => typeof choice !== 'boolean')
      )
        return invalid();
    } else if (
      typeof item !== 'string' ||
      Buffer.byteLength(item) > (name === 'password' || name === 'recovery' ? 16384 : 2048) ||
      /[\u0000-\u001f\u007f]/u.test(item)
    )
      return invalid();
  }
  return value as DesktopCommand;
}
const messages: Record<string, string> = {
  REMOVAL_PENDING:
    'Removal is incomplete. Inspect its preserved original identities and explicitly resume; normal work is blocked.',
  REMOVAL_INVALID:
    'Removal state is unsafe or changed. Preserve private state and inspect it; do not reset it.',
  UNSYNCED_WORK:
    'Possible unsynced work remains. Explicit abandonment is required; local files and remote data are preserved.',
  CONNECTION_IN_USE:
    'Folders remain attached. Disconnect them or explicitly acknowledge abandonment.',
  IGNORE_INVALID:
    'Invalid exclusions-only ignore rules. Validate for a safe line number before saving.',
  IGNORE_RECOVERY_REQUIRED:
    'Finish interrupted synchronization with its original ignore rules before saving new rules.',
  INVALID_INPUT: 'Invalid input. Check your entries and retry.',
  INPUT_REQUIRED: 'Complete the required fields.',
  CONFLICT: 'Saved state changed or this choice is already in use. Refresh and retry.',
  CREDENTIALS_UNAVAILABLE:
    'Unlock your credential store and ensure Secret Service is running in this login session, then retry. No state was discarded.',
  CREDENTIAL_STATE_INVALID: 'Credential state needs inspection or recovery. Do not reset it.',
  CREDENTIAL_DECISION_REQUIRED:
    'Choose OS credential storage or leave this root unchanged and use the CLI.',
  CREDENTIAL_MIGRATION_PENDING:
    'Resume migration or roll back before cleanup; normal operations are blocked.',
  CREDENTIAL_CLEANUP_PENDING: 'Explicitly resume authorized credential cleanup before continuing.',
  CREDENTIAL_ROLL_FORWARD_REQUIRED:
    'Source cleanup has begun. Resume migration; rollback is no longer safe.',
  CREDENTIAL_MODE_CONFLICT: 'The credential mode changed. Refresh before proceeding.',
  CONFIRMATION_REQUIRED: 'Explicit confirmation is required.',
  INVALID_RESPONSE: 'The server returned an unsupported response. Local state is preserved.',
  INTERRUPTED: 'Enrollment cancelled; resume the same pending request when ready.',
  REQUEST_TIMEOUT: 'The server request timed out. Resume the same pending request.',
  OWNER_TEMPORARY:
    'A temporary CLI sync owns this folder. Wait for it to finish or start continuous sync in its owner.',
  OWNER_UNAVAILABLE:
    'The live sync owner cannot be reached safely. Stop it and retry with a compatible client; its lock was not bypassed.',
  OWNER_INCOMPATIBLE:
    'Stop older or unadvertised sync owners before upgrading shared settings. No lock was bypassed.',
  OWNER_BUSY: 'Sync is already starting. Refresh and retry.',
  OWNER_STOPPED: 'The owner stopped. Explicitly start again.',
  DESKTOP_INSTANCE_UNAVAILABLE: 'The desktop profile or private instance identity changed. Desktop work is stopping; preserve state and relaunch after the old instance has safely stopped.',
  DESKTOP_SESSION_UNAVAILABLE: 'Graphical-session association or monitoring is unavailable. Desktop synchronization is blocked; relaunch from a supported associated X11/XWayland graphical session. Independent CLI work is unaffected.',
  SYNC_PAUSED:
    'Sync is paused. Resume the global or folder pause through the client before retrying.',
  FOLDER_UNAVAILABLE:
    'Folder unavailable or changed. Restore the original folder and marker before retrying.',
  DESTINATION_INVALID:
    'Choose an owned existing real folder, without symlinks, markers or overlapping sync/private roots.',
  NONEMPTY_CONFIRMATION:
    'This folder contains files. Return to folder selection, choose it again, and explicitly acknowledge reconciliation before connecting.',
  SELECTION_CHANGED: 'Folder selection changed. Choose the folder again and review its contents.',
  KEY_REQUIRED: 'Unlock this vault with its recovery key before connecting.',
  OPEN_FAILED:
    'The system application could not open the checked folder or advertised administration page.',
  NATIVE_INTEGRATION_UNAVAILABLE:
    'Folder opening is unavailable in this session. Use a desktop session with xdg-open installed; syncing does not require it.',
  SETTINGS_INVALID:
    'Saved settings are invalid or incompatible. Stop older clients and inspect settings before retrying.',
  NOT_FOUND:
    'The selected connection, vault or folder is no longer available. Refresh and select again.',
  OPERATION_FAILED:
    'The operation failed safely. Check your inputs, connection and current owner, then retry.',
};
export function safeDesktopError(error: unknown): Extract<DesktopReply, { ok: false }> {
  const candidate = error instanceof Error && 'code' in error ? error.code : null;
  const known =
    typeof candidate === 'string' &&
    (Object.hasOwn(messages, candidate) ||
      (PROTOCOL_ERROR_CODES as readonly string[]).includes(candidate));
  const code = known ? candidate : 'OPERATION_FAILED';
  return {
    ok: false,
    code,
    message:
      messages[code] ?? 'The server refused this operation. Check approval and access, then retry.',
  };
}
export interface DesktopNative {
  pickFolder(): Promise<string[]>;
  openAdministration(url: string): Promise<{ ok: boolean }>;
  openFolder?(checkedRoot: string): Promise<{ ok: boolean }>;
  quit(): void;
  lifecycleStatus?(): import('./lifecycle').LifecycleStatus;
  canSync?(): boolean;
  preferencesChanged?(): Promise<void>;
  requestQuit?(): void;
  authorize?(): void;
}
export function createDesktopBackend(
  root: string,
  native: DesktopNative,
  credentials: CredentialOptions = {},
) {
  const instanceId = randomUUID();
  const administration = new Map<string, string>();
  const removalSelections = new Map<
    string,
    { target: { binding: string } | { serverId: string }; bindings: string }
  >();
  const runtimeErrors: Record<string, string> = {};
  type Running = {
    session?: BoundSyncSession;
    controller: AbortController;
    accepted: Promise<void>;
    done?: Promise<void>;
  };
  const running = new Map<string, Running>();
  const active = new Set<Promise<DesktopReply>>();
  const once = new Map<string, Promise<void>>();
  const temporarySessions = new Set<BoundSyncSession>();
  let shutdownWork: Promise<void> | undefined;
  let enrollment: AbortController | undefined;
  let selected:
    | {
        token: string;
        path: string;
        dev: string;
        ino: string;
        binding?: string;
        serverId?: string;
        vaultId?: string;
      }
    | undefined;
  let closing = false;
  const snapshot = (): DesktopSnapshot => {
    const lifecycle = native.lifecycleStatus?.();
    return {
      ...onboardingSnapshot(root),
      clientRoot: root,
      administration: [...administration.keys()],
      runtimeErrors: { ...runtimeErrors },
      ...(lifecycle ? {
        lifecycle,
        nativeEffects: {
          startup: lifecycle.startup.applied ? 'applied' : lifecycle.startup.available === false ? 'unavailable' : 'not-installed',
          tray: lifecycle.tray.applied ? 'applied' : lifecycle.tray.available === false ? 'unavailable' : 'not-installed',
          backgroundPolicy: 'applied',
        } as DesktopSnapshot['nativeEffects'],
      } : {}),
    };
  };
  async function start(bindingId: string): Promise<void> {
    if (closing) throw new ClientError('OWNER_STOPPED', 'Closing');
    if (native.canSync && !native.canSync()) throw new ClientError('DESKTOP_SESSION_UNAVAILABLE', 'Session unproven');
    const current = running.get(bindingId);
    if (current) return current.accepted;
    const binding = records(root).find((item) => item.connectionId === bindingId);
    if (!binding) throw new ClientError('NOT_FOUND', 'Binding not found');
    const ready = Promise.withResolvers<void>();
    const entry: Running = {
      controller: new AbortController(),
      accepted: ready.promise,
    };
    running.set(bindingId, entry);
    entry.done = (async () => {
      try {
        entry.session = await openBoundSync(root, binding.root, {
          ...credentials,
          origin: 'desktop',
          instanceId,
        });
        if (closing) {
          await entry.session.close();
          throw new ClientError('OWNER_STOPPED', 'Closing');
        }
        await entry.session.watch(
          entry.controller.signal,
          () => {
            delete runtimeErrors[bindingId];
          },
          (error) => {
            runtimeErrors[bindingId] = safeDesktopError(error).code;
          },
          () => {
            delete runtimeErrors[bindingId];
            ready.resolve();
          },
        );
      } catch (error) {
        runtimeErrors[bindingId] = safeDesktopError(error).code;
        ready.reject(error);
      } finally {
        await entry.session?.close();
        running.delete(bindingId);
      }
    })();
    return entry.accepted;
  }
  function syncNow(bindingId: string): Promise<void> {
    if (native.canSync && !native.canSync()) return Promise.reject(new ClientError('DESKTOP_SESSION_UNAVAILABLE', 'Session unproven'));
    const current = once.get(bindingId);
    if (current) return current;
    const work = (async () => {
      const binding = records(root).find((item) => item.connectionId === bindingId);
      if (!binding) throw new ClientError('NOT_FOUND', 'Binding not found');
      const session = await openBoundSync(root, binding.root, {
        ...credentials,
        origin: 'desktop',
        instanceId,
      });
      temporarySessions.add(session);
      try {
        if (closing) throw new ClientError('OWNER_STOPPED', 'Closing');
        await session.syncOnce();
        delete runtimeErrors[bindingId];
      } catch (error) {
        runtimeErrors[bindingId] = safeDesktopError(error).code;
        throw error;
      } finally {
        try {
          await session.close();
        } finally {
          temporarySessions.delete(session);
        }
      }
    })();
    once.set(bindingId, work);
    void work.then(
      () => once.delete(bindingId),
      () => once.delete(bindingId),
    );
    return work;
  }
  function shutdown(): Promise<void> {
    return (shutdownWork ??= (async () => {
      closing = true;
      enrollment?.abort();
      for (const entry of running.values()) entry.controller.abort();
      await Promise.all([...temporarySessions].map((session) => session.close()));
      // Native store calls are not cancellable: finish their crash-safe operation before exit.
      await Promise.all([...active]);
      await stopOwnedSync(instanceId);
      await Promise.all([...running.values()].map((entry) => entry.done));
    })().catch(error => { shutdownWork = undefined; throw error; }));
  }
  function execute(value: unknown): Promise<DesktopReply> {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'quit')
      return handle(value);
    const work = handle(value);
    active.add(work);
    void work.then(
      () => active.delete(work),
      () => active.delete(work),
    );
    return work;
  }
  async function handle(value: unknown): Promise<DesktopReply> {
    let command: DesktopCommand | undefined;
    try {
      command = validateCommand(value);
      if (command.type !== 'quit') native.authorize?.();
      if (closing && command.type !== 'quit' && command.type !== 'snapshot') throw new ClientError('OWNER_STOPPED', 'Closing');
      const data: Omit<Extract<DesktopReply, { ok: true }>, 'ok' | 'snapshot'> = {};
      switch (command.type) {
        case 'snapshot':
          break;
        case 'conflicts':
          data.conflicts = listConflicts(root);
          break;
        case 'open-conflict': {
          const path = checkedConflictFolder(root, command.binding, command.conflict);
          if (!native.openFolder)
            throw new ClientError('NATIVE_INTEGRATION_UNAVAILABLE', 'Folder opener unavailable');
          if (!(await native.openFolder(path)).ok)
            throw new ClientError('OPEN_FAILED', 'Folder opening failed');
          break;
        }
        case 'ignores-view':
          data.ignores = viewIgnores(root, checkedBindingRoot(root, command.binding));
          break;
        case 'ignores-validate':
          data.validation = validateIgnoreText(command.text);
          break;
        case 'ignores-set':
          await setIgnores(root, { binding: command.binding }, {
            text: command.text,
            expectedFileSignature: command.expectedFileSignature,
          });
          data.ignores = viewIgnores(root, checkedBindingRoot(root, command.binding));
          break;
        case 'inspect-disconnect':
        case 'inspect-server-removal': {
          const target =
            command.type === 'inspect-disconnect'
              ? { binding: command.binding }
              : { serverId: command.serverId };
          const inspection = await inspectRemoval(root, target),
            selection = randomUUID();
          removalSelections.clear();
          removalSelections.set(selection, {
            target,
            bindings: JSON.stringify(
              inspection.bindings
                .map((item) => item.connection)
                .sort((left, right) => left.connectionId.localeCompare(right.connectionId)),
            ),
          });
          data.removalPreview = { ...inspection, selection };
          break;
        }
        case 'remove': {
          const choice = removalSelections.get(command.selection);
          if (!choice) throw new ClientError('SELECTION_CHANGED', 'Inspect removal again.');
          const target = choice.target,
            force = command.force;
          const selectedBindings = () =>
            records(root)
              .filter((item) =>
                'binding' in target
                  ? item.connectionId === target.binding
                  : item.serverId === target.serverId,
              )
              .sort((left, right) => left.connectionId.localeCompare(right.connectionId));
          if (JSON.stringify(selectedBindings()) !== choice.bindings)
            throw new ClientError('SELECTION_CHANGED', 'Attached folders changed; inspect again.');
          if (command.stopOwner)
            for (const binding of selectedBindings())
              await stopBoundSyncForRemoval(root, binding.root);
          await withCredentialRegistry(root, async () => {
            const bindings = selectedBindings();
            if (JSON.stringify(bindings) !== choice.bindings)
              throw new ClientError(
                'SELECTION_CHANGED',
                'Attached folders changed; inspect again.',
              );
            if ('binding' in target)
              await disconnectConnections(root, bindings, force, credentials);
            else await removeServerConnection(root, target.serverId, force, credentials);
          });
          removalSelections.delete(command.selection);
          break;
        }
        case 'resume-removal':
          await resumeRemoval(root, command.requestId, command.confirmed, credentials);
          break;
        case 'cancel-enrollment':
          enrollment?.abort();
          break;
        case 'quit':
          if (native.requestQuit) native.requestQuit();
          else { await shutdown(); native.quit(); }
          break;
        case 'pause-all':
          setPaused(root, { all: true }, command.paused, command.expectedRevision);
          break;
        case 'pause-folder': {
          const bindingId = command.binding;
          if (!existsSync(root) || !records(root).some((item) => item.connectionId === bindingId))
            throw new ClientError('NOT_FOUND', 'Binding not found');
          setPaused(root, { binding: command.binding }, command.paused, command.expectedRevision);
          break;
        }
        case 'settings':
          setLifecycle(root, command.lifecycle, command.expectedRevision);
          await native.preferencesChanged?.();
          break;
        case 'open-folder': {
          const path = checkedBindingRoot(root, command.binding);
          if (!native.openFolder)
            throw new ClientError('NATIVE_INTEGRATION_UNAVAILABLE', 'Folder opener unavailable');
          if (!(await native.openFolder(path)).ok)
            throw new ClientError('OPEN_FAILED', 'Folder opening failed');
          break;
        }
        case 'initialize':
          initializeCredentials(root, 'os-store');
          break;
        case 'migrate':
          await migrateCredentials(root, command.confirmed, credentials);
          break;
        case 'resume-migration':
          await resumeCredentialMigration(root, command.confirmed, credentials);
          break;
        case 'rollback-migration':
          await rollbackCredentialMigration(root, command.confirmed, credentials);
          break;
        case 'resume-cleanup':
          await resumeCredentialCleanup(root, command.confirmed, credentials);
          break;
        default: {
          requireDesktopCredentials(root);
          switch (command.type) {
            case 'enroll': {
              if (enrollment) throw new ClientError('CONFLICT', 'Enrollment already active');
              command.url = baseUrl(command.url);
              enrollment = new AbortController();
              const urlIdentity = command.url;
              administration.delete(urlIdentity);
              try {
                data.enrollment = await enrollServer(
                  root,
                  command.url,
                  command.password || undefined,
                  command.deviceName,
                  0,
                  {
                    ...credentials,
                    alias: command.alias,
                    fresh: command.fresh,
                    retryCredentialWrite: command.retryCredentialWrite,
                    signal: enrollment.signal,
                    onEvent(event) {
                      if (event.type === 'administration')
                        administration.set(urlIdentity, event.url);
                    },
                  },
                );
              } finally {
                enrollment = undefined;
                command.password = '';
              }
              break;
            }
            case 'vaults':
              data.vaults = await listRemoteVaults(
                root,
                server(root, command.serverId),
                credentials,
              );
              break;
            case 'key-status':
              data.key = await vaultKeyStatus(root, command.serverId, command.vaultId, credentials);
              break;
            case 'unlock':
              try {
                const existing = await vaultKeyStatus(
                  root,
                  command.serverId,
                  command.vaultId,
                  credentials,
                );
                if (closing) throw new ClientError('OWNER_STOPPED', 'Closing');
                if (!existing.keyRequired && !existing.credentialWritePending) {
                  data.key = existing;
                  break;
                }
                if (existing.credentialWritePending && !command.retryCredentialWrite)
                  throw new ClientError(
                    'CONFIRMATION_REQUIRED',
                    'Explicit credential retry required',
                  );
                await unlockVault(
                  root,
                  server(root, command.serverId),
                  command.vaultId,
                  command.recovery,
                  {
                    ...credentials,
                    retryCredentialWrite: command.retryCredentialWrite,
                  },
                );
              } finally {
                command.recovery = '';
              }
              data.key = await vaultKeyStatus(root, command.serverId, command.vaultId, credentials);
              break;
            case 'pick-folder': {
              const paths = await native.pickFolder();
              if (!paths.length) {
                data.cancelled = true;
                break;
              }
              if (paths.length !== 1)
                throw new ClientError('DESTINATION_INVALID', 'Invalid picker selection');
              let folder;
              try {
                folder = inspectDestination(root, paths[0]!);
              } catch {
                throw new ClientError('DESTINATION_INVALID', 'Unsafe destination');
              }
              const stat = lstatSync(folder.path, { bigint: true });
              selected = {
                token: randomUUID(),
                path: folder.path,
                dev: String(stat.dev),
                ino: String(stat.ino),
              };
              data.folder = { selection: selected.token, ...folder };
              break;
            }
            case 'connect': {
              const selection = selected;
              if (!selection || selection.token !== command.selection)
                throw new ClientError('SELECTION_CHANGED', 'Select again');
              if (selection.binding) {
                if (
                  selection.serverId !== command.serverId ||
                  selection.vaultId !== command.vaultId
                )
                  throw new ClientError('SELECTION_CHANGED', 'Selection changed');
                data.binding = selection.binding;
                break;
              }
              const stat = lstatSync(selection.path, { bigint: true });
              if (String(stat.dev) !== selection.dev || String(stat.ino) !== selection.ino)
                throw new ClientError('SELECTION_CHANGED', 'Selection changed');
              const state = await vaultKeyStatus(
                root,
                command.serverId,
                command.vaultId,
                credentials,
              );
              if (closing) throw new ClientError('OWNER_STOPPED', 'Closing');
              if (selected !== selection)
                throw new ClientError('SELECTION_CHANGED', 'Selection changed');
              if (selection.binding) {
                if (
                  selection.serverId !== command.serverId ||
                  selection.vaultId !== command.vaultId
                )
                  throw new ClientError('SELECTION_CHANGED', 'Selection changed');
                data.binding = selection.binding;
                break;
              }
              if (state.keyRequired || state.credentialWritePending)
                throw new ClientError('KEY_REQUIRED', 'Missing vault key');
              const info = server(root, command.serverId);
              try {
                const folder = inspectDestination(root, selection.path);
                if (folder.nonempty && !command.confirmNonempty)
                  throw new ClientError('NONEMPTY_CONFIRMATION', 'Confirm nonempty');
                const binding = connectRegisteredVault(
                  root,
                  selection.path,
                  info.serverId,
                  command.vaultId,
                  info.deviceId,
                  command.confirmNonempty,
                  selection,
                );
                selection.binding = binding.connectionId;
                selection.serverId = info.serverId;
                selection.vaultId = command.vaultId;
                data.binding = binding.connectionId;
              } catch (error) {
                if (error instanceof ClientError) throw error;
                throw new ClientError('DESTINATION_INVALID', 'Unsafe destination');
              }
              break;
            }
            case 'sync-now':
              await syncNow(command.binding);
              break;
            case 'start':
              await start(command.binding);
              data.started = true;
              break;
            case 'administration': {
              const advertised = administration.get(command.urlIdentity);
              if (!advertised || !(await native.openAdministration(advertised)).ok)
                throw new ClientError('OPEN_FAILED', 'Administration unavailable');
              break;
            }
          }
        }
      }
      return { ok: true, snapshot: snapshot(), ...data };
    } catch (error) {
      return safeDesktopError(error);
    } finally {
      if (command?.type === 'enroll') command.password = '';
      if (command?.type === 'unlock') command.recovery = '';
    }
  }
  async function resumeDesktopWork() {
    const state = snapshot();
    if (
      state.removal ||
      state.credentials.mode !== 'os-store' ||
      state.credentials.migrationPending ||
      state.credentials.cleanupPending
    )
      return;
    for (const binding of state.status?.bindings ?? []) {
      if (
        readPreferences(root).continuousRequested[binding.connectionId] !== 'desktop' ||
        binding.ownerPresent
      )
        continue;
      try {
        await start(binding.connectionId);
      } catch (error) {
        runtimeErrors[binding.connectionId] = safeDesktopError(error).code;
      }
    }
  }
  return { execute, shutdown, resumeDesktopWork };
}
