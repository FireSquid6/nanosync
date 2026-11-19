import { randomBytes, randomUUID } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { discoverConnection } from './connections.ts';
import { withCredentialRegistry, type CredentialOptions } from './credentials.ts';
import { startBoundSync } from './bound-sync.ts';
import { privateDirectory, secureCreate, secureRead, secureReplace } from './security.ts';
import { observeSyncLock, type FileIdentity } from './sync-lock.ts';
import type { SyncEvent } from './events.ts';
import {
  authorized, boundedJson, failure, MAX_BODY, NONCE, object, outcome, request, result,
  safeError, progressResponse, streamedOutcome, UUID,
  type ControlRequest, type Head, type Operation, type Outcome,
} from './sync-control-protocol.ts';

export type SyncOwner = { origin: 'cli' | 'desktop'; instanceId: string };
export type BoundSyncOptions = SyncOwner & CredentialOptions & { onEvent?: (event: SyncEvent) => void };
export interface BoundSyncSession {
  readonly owner: SyncOwner;
  syncOnce(): Promise<Head>;
  watch(signal: AbortSignal, onSuccess: (head: Head) => void, onError: (error: unknown) => void): Promise<void>;
  close(): Promise<void>;
}
type Lock = NonNullable<ReturnType<typeof observeSyncLock>>;
type Metadata = {
  version: 1; root: string; rootDev: number; rootIno: number; binding: string;
  origin: 'cli' | 'desktop'; instanceId: string; nonce: string;
  pid: number; starttime: string; lockDev: number; lockIno: number; socketDev: number; socketIno: number;
  runtime: 'session' | 'private-tmp'; runtimeDev: number; runtimeIno: number;
  directoryDev: number; directoryIno: number;
};
type Target = { replica: string; metadata: Metadata; lock: Lock };
const hosts = new Set<BoundSyncSession>();
const DISCOVERY = '.sync-control';
function same(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}
function controlDirectory(path: string, create = false): string {
  if (!create) lstatSync(path);
  const directory = privateDirectory(path);
  if ((lstatSync(directory).mode & 0o7777) !== 0o700) throw failure('OWNER_UNAVAILABLE');
  return directory;
}
function runtime(kind: Metadata['runtime'], create = false): string {
  const base = kind === 'session' ? join(controlDirectory(`/run/user/${process.getuid!()}`), 'nanosync')
    : `/tmp/nanosync-${process.getuid!()}`;
  return controlDirectory(base, create);
}
function runtimeKind(): Metadata['runtime'] {
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) controlDirectory(xdg);
  return xdg === `/run/user/${process.getuid!()}` ? 'session' : 'private-tmp';
}
function endpoint(metadata: Metadata): { directory: string; socket: string } {
  if (!NONCE.test(metadata.nonce)) throw failure('OWNER_UNAVAILABLE');
  const base = runtime(metadata.runtime);
  if (!same(lstatSync(base), { dev: metadata.runtimeDev, ino: metadata.runtimeIno }))
    throw failure('OWNER_UNAVAILABLE');
  const directory = controlDirectory(join(base, metadata.nonce));
  if (!same(lstatSync(directory), { dev: metadata.directoryDev, ino: metadata.directoryIno }))
    throw failure('OWNER_UNAVAILABLE');
  return { directory, socket: join(directory, 's') };
}
function socketIdentity(path: string): FileIdentity {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.isSymbolicLink() || stat.uid !== process.getuid!() ||
      (stat.mode & 0o7777) !== 0o600 || stat.nlink !== 1) throw failure('OWNER_UNAVAILABLE');
  return stat;
}
function readMetadata(replica: string, root: string, binding: string, lock: Lock): Metadata {
  const value = object(JSON.parse(secureRead(join(replica, DISCOVERY), 8192).toString('utf8')), [
    'version', 'root', 'rootDev', 'rootIno', 'binding', 'origin', 'instanceId', 'nonce',
    'pid', 'starttime', 'lockDev', 'lockIno', 'socketDev', 'socketIno',
    'runtime', 'runtimeDev', 'runtimeIno', 'directoryDev', 'directoryIno',
  ]);
  const rootStat = lstatSync(root);
  if (value.version !== 1 || value.root !== root || value.rootDev !== rootStat.dev || value.rootIno !== rootStat.ino ||
      value.binding !== binding || !['cli', 'desktop'].includes(value.origin as string) ||
      typeof value.instanceId !== 'string' || !UUID.test(value.instanceId) ||
      typeof value.nonce !== 'string' || !NONCE.test(value.nonce) ||
      value.pid !== lock.owner.pid || value.starttime !== lock.owner.starttime ||
      value.lockDev !== lock.inode.dev || value.lockIno !== lock.inode.ino ||
      !['session', 'private-tmp'].includes(value.runtime as string) ||
      !Number.isSafeInteger(value.runtimeDev) || !Number.isSafeInteger(value.runtimeIno) ||
      !Number.isSafeInteger(value.directoryDev) || !Number.isSafeInteger(value.directoryIno) ||
      !Number.isSafeInteger(value.socketDev) || !Number.isSafeInteger(value.socketIno))
    throw failure('OWNER_UNAVAILABLE');
  return value as Metadata;
}
function validate(target: Target): { socket: string; capability: string } {
  const { metadata, replica, lock } = target;
  privateDirectory(replica);
  const current = observeSyncLock(replica);
  if (!current?.live || !same(current.inode, lock.inode) || current.owner.pid !== metadata.pid ||
      current.owner.starttime !== metadata.starttime) throw failure('OWNER_UNAVAILABLE');
  const checked = readMetadata(replica, metadata.root, metadata.binding, current);
  if (JSON.stringify(checked) !== JSON.stringify(metadata)) throw failure('OWNER_UNAVAILABLE');
  const { directory, socket } = endpoint(metadata);
  if (!same(socketIdentity(socket), { dev: metadata.socketDev, ino: metadata.socketIno }))
    throw failure('OWNER_UNAVAILABLE');
  const capabilityPath = join(directory, 'capability'), capabilityStat = lstatSync(capabilityPath);
  if ((capabilityStat.mode & 0o7777) !== 0o600) throw failure('OWNER_UNAVAILABLE');
  const capability = secureRead(capabilityPath, 64).toString('utf8');
  if (!same(lstatSync(capabilityPath), capabilityStat) || !/^[0-9a-f]{64}$/.test(capability))
    throw failure('OWNER_UNAVAILABLE');
  return { socket, capability };
}
function checkConnectedEndpoint(metadata: Metadata): void {
  const base = runtime(metadata.runtime);
  if (!same(lstatSync(base), { dev: metadata.runtimeDev, ino: metadata.runtimeIno }))
    throw failure('OWNER_UNAVAILABLE');
  try {
    const { socket } = endpoint(metadata);
    if (!same(socketIdentity(socket), { dev: metadata.socketDev, ino: metadata.socketIno }))
      throw failure('OWNER_UNAVAILABLE');
  } catch (error) {
    // A successful connected host may have unlinked its own endpoint on normal close.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
async function send(
  target: Target, operation: Operation, signal?: AbortSignal, onEvent?: (event: SyncEvent) => void,
): Promise<unknown> {
  try {
    const { socket, capability } = validate(target);
    const payload: ControlRequest = { version: 1, id: randomUUID(), root: target.metadata.root,
      binding: target.metadata.binding, instance: target.metadata.instanceId, operation };
    const response = await fetch('http://localhost/control', {
      unix: socket, method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', 'x-nanosync-capability': capability },
      body: JSON.stringify(payload),
    });
    if (response.status !== 200) throw failure('OWNER_UNAVAILABLE');
    checkConnectedEndpoint(target.metadata);
    const contentType = response.headers.get('content-type');
    let value: unknown;
    if (contentType === 'application/x-ndjson' && operation !== 'stop-for-removal')
      value = await streamedOutcome(response.body, onEvent);
    else if (['application/json', 'application/json;charset=utf-8'].includes(contentType ?? ''))
      value = await boundedJson(response.body);
    else throw failure('OWNER_UNAVAILABLE');
    // Recheck connection identity, not continued ownership, after a completed reply.
    checkConnectedEndpoint(target.metadata);
    return value;
  } catch (error) {
    if (signal?.aborted) throw error;
    throw failure('OWNER_UNAVAILABLE');
  }
}
function attached(target: Target, options: BoundSyncOptions): BoundSyncSession {
  const detached = new AbortController();
  return {
    owner: Object.freeze({ origin: target.metadata.origin, instanceId: target.metadata.instanceId }),
    async syncOnce() {
      if (detached.signal.aborted) throw failure('OWNER_STOPPED');
      return result(outcome(await send(target, 'sync', detached.signal, options.onEvent)), options.onEvent);
    },
    async watch(signal, onSuccess, onError) {
      const combined = AbortSignal.any([signal, detached.signal]);
      while (!combined.aborted) {
        try {
          const value = outcome(await send(target, 'watch', combined, options.onEvent));
          onSuccess(result(value, options.onEvent));
        } catch (error) {
          if (combined.aborted) break;
          // Never promote on stop, disconnect or an unknown outcome.
          if (!(error instanceof Error) || !('exitCode' in error) ||
              error.exitCode !== 5 && !('code' in error && error.code === 'SYNC_PAUSED')) throw error;
          if (!('code' in error && error.code === 'SYNC_PAUSED')) onError(error);
          if ('code' in error && error.code === 'VAULT_DELETED') throw error;
        }
        try { await delay(5000, undefined, { signal: combined }); }
        catch (error) { if (!combined.aborted) throw error; }
      }
    },
    async close() { detached.abort(); },
  };
}

/** Acquires under the credential registry; live-owner attachment never loads credentials. */
export async function openBoundSync(
  root: string, from: string, options: BoundSyncOptions,
): Promise<BoundSyncSession> {
  options = { ...options };
  if (!['cli', 'desktop'].includes(options.origin) || !UUID.test(options.instanceId))
    throw failure('OWNER_UNAVAILABLE');
  const selected = await withCredentialRegistry(root, async () => {
    root = privateDirectory(root);
    const binding = discoverConnection(root, from, true);
    const replica = privateDirectory(join(privateDirectory(join(root, 'replicas')), binding.connectionId));
    const lock = observeSyncLock(replica);
    if (lock?.live) {
      try { return { target: { replica, lock, metadata: readMetadata(replica, root, binding.connectionId, lock) } }; }
      catch { throw failure('OWNER_UNAVAILABLE'); }
    }
    const events = new Set<(event: SyncEvent) => void>();
    let lastEvent: SyncEvent | undefined;
    const runner = await startBoundSync(root, from, { ...options, owner: { origin: options.origin, instanceId: options.instanceId }, onEvent(event) {
      lastEvent = event;
      options.onEvent?.(event);
      for (const listener of events) listener(event);
    } });
    let directory: string | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
      const ownLock = observeSyncLock(replica);
      if (!ownLock?.live || ownLock.owner.pid !== process.pid) throw failure('OWNER_UNAVAILABLE');
      const nonce = randomBytes(16).toString('hex');
      const kind = runtimeKind(), base = runtime(kind, true), runtimeStat = lstatSync(base);
      directory = controlDirectory(join(base, nonce), true);
      const socket = join(directory, 's'), capability = randomBytes(32).toString('hex');
      secureCreate(join(directory, 'capability'), capability);
      let closing: Promise<void> | undefined;
      let transportStopped: Promise<void> | undefined;
      let continuous = false;
      let active = 0;
      type Replay = { operation: Operation; done: boolean; value: Promise<Outcome | { stopped: true }> };
      const replay = new Map<string, Replay>();
      const lifetime = new AbortController();
      let metadata: Metadata;
      let discoveryInode: FileIdentity | undefined;
      const close = (): Promise<void> => closing ??= (async () => {
        lifetime.abort();
        await runner.stop();
        // No endpoint/discovery/ownership cleanup before awaited DB close and key cleanup.
        try {
          const discovery = join(replica, DISCOVERY);
          if (discoveryInode && same(lstatSync(discovery), discoveryInode) &&
              secureRead(discovery, 8192).toString('utf8') === JSON.stringify(metadata) &&
              same(lstatSync(discovery), discoveryInode)) unlinkSync(discovery);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        } finally {
          transportStopped = server?.stop(false);
          hosts.delete(session);
          if (directory) rmSync(directory, { recursive: true, force: true });
        }
      })();
      const dispatch = async (operation: Operation): Promise<Outcome | { stopped: true }> => {
        if (closing) return { head: null, events: [], error: safeError(failure('OWNER_STOPPED')) };
        if (operation === 'stop-for-removal') { await close(); return { stopped: true }; }
        if (operation === 'watch' && !continuous)
          return { head: null, events: [], error: safeError(failure('OWNER_TEMPORARY')) };
        try { return outcome({ head: await runner.syncOnce(), events: [], error: null }); }
        catch (error) { return { head: null, events: [], error: safeError(error) }; }
      };
      server = Bun.serve({ unix: socket, maxRequestBodySize: MAX_BODY,
        async fetch(incoming, listener) {
          if (!authorized(incoming.headers.get('x-nanosync-capability'), capability))
            return new Response(null, { status: 403 });
          if (incoming.method !== 'POST' || incoming.url !== 'http://localhost/control' ||
              incoming.headers.get('content-type') !== 'application/json')
            return new Response(null, { status: 400 });
          if (active >= 16) return new Response(null, { status: 429 });
          active++;
          let streaming = false;
          let stream: ReturnType<typeof progressResponse> | undefined;
          try {
            const payload = request(await boundedJson(incoming.body, lifetime.signal));
            if (payload.root !== root || payload.binding !== binding.connectionId || payload.instance !== options.instanceId)
              return new Response(null, { status: 400 });
            if (!closing) validate({ replica, metadata, lock: ownLock });
            listener.timeout(incoming, 0);
            let cached = replay.get(payload.id);
            if (cached && cached.operation !== payload.operation) return new Response(null, { status: 400 });
            if (!cached && replay.size >= 128) {
              const oldest = [...replay].find(([, entry]) => entry.done);
              if (!oldest) return new Response(null, { status: 429 });
              replay.delete(oldest[0]);
            }
            const wantsStream = payload.operation !== 'stop-for-removal' &&
              !(payload.operation === 'watch' && !continuous);
            if (wantsStream) {
              stream = progressResponse(() => { events.delete(stream!.publish); active--; });
              streaming = true;
              events.add(stream.publish);
              if (lastEvent && lastEvent.type !== 'complete') stream.publish(lastEvent);
            }
            if (!cached) {
              cached = { operation: payload.operation, done: false, value: dispatch(payload.operation) };
              replay.set(payload.id, cached);
              const entry = cached;
              const markDone = () => { entry.done = true; };
              void entry.value.then(markDone, markDone);
            }
            if (!stream) return Response.json(await cached.value);
            const response = stream;
            void cached.value.then(value => response.complete(value)).catch(() => response.fail());
            return new Response(response.body, { headers: { 'content-type': 'application/x-ndjson' } });
          } catch {
            stream?.fail();
            return new Response(null, { status: 400 });
          }
          finally { if (!streaming) active--; }
        },
        error() { return new Response(null, { status: 400 }); },
      });
      chmodSync(socket, 0o600);
      const socketStat = socketIdentity(socket), rootStat = lstatSync(root);
      metadata = { version: 1, root, rootDev: rootStat.dev, rootIno: rootStat.ino, binding: binding.connectionId,
        origin: options.origin, instanceId: options.instanceId, nonce,
        pid: ownLock.owner.pid, starttime: ownLock.owner.starttime, lockDev: ownLock.inode.dev, lockIno: ownLock.inode.ino,
        socketDev: socketStat.dev, socketIno: socketStat.ino,
        runtime: kind, runtimeDev: runtimeStat.dev, runtimeIno: runtimeStat.ino,
        directoryDev: lstatSync(directory).dev, directoryIno: lstatSync(directory).ino };
      const discovery = join(replica, DISCOVERY);
      // shortcut: retain crash-orphaned private endpoints; add checked dead-owner GC if accumulation matters.
      if (existsSync(discovery)) secureReplace(discovery, JSON.stringify(metadata));
      else secureCreate(discovery, JSON.stringify(metadata));
      discoveryInode = lstatSync(discovery);
      const session: BoundSyncSession = {
        owner: Object.freeze({ origin: options.origin, instanceId: options.instanceId }),
        syncOnce() {
          if (closing) return Promise.reject(failure('OWNER_STOPPED'));
          return runner.syncOnce();
        },
        async watch(signal, onSuccess, onError) {
          if (closing) throw failure('OWNER_STOPPED');
          if (continuous) throw failure('OWNER_BUSY');
          continuous = true;
          try { await runner.watch(AbortSignal.any([signal, lifetime.signal]), onSuccess, onError); }
          finally { await session.close(); }
        },
        async close() { await close(); await transportStopped; },
      };
      Object.freeze(session);
      hosts.add(session);
      return { session };
    } catch (error) {
      await runner.stop();
      void server?.stop(true);
      if (directory) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  });
  if (selected.session) return selected.session;
  validate(selected.target);
  return attached(selected.target, options);
}

/** Desktop Quit only: never stop independent CLI hosts or another process's owners. */
export async function stopOwnedSync(instanceId: string): Promise<void> {
  if (!UUID.test(instanceId)) throw failure('OWNER_UNAVAILABLE');
  await Promise.all([...hosts].filter(host => host.owner.origin === 'desktop' && host.owner.instanceId === instanceId)
    .map(host => host.close()));
}

/** Explicit consent hook only; caller must reacquire locks and revalidate before removal. */
export async function stopBoundSyncForRemoval(root: string, from: string): Promise<void> {
  const target = await withCredentialRegistry(root, async () => {
    root = privateDirectory(root);
    const binding = discoverConnection(root, from, true);
    const replica = privateDirectory(join(privateDirectory(join(root, 'replicas')), binding.connectionId));
    const lock = observeSyncLock(replica);
    if (!lock?.live) return null;
    return { replica, lock, metadata: readMetadata(replica, root, binding.connectionId, lock) };
  });
  if (target) {
    const value = object(await send(target, 'stop-for-removal'), ['stopped']);
    if (value.stopped !== true) throw failure('OWNER_UNAVAILABLE');
    await withCredentialRegistry(root, async () => {
      const binding = discoverConnection(root, from, true), identity = lstatSync(root);
      if (binding.connectionId !== target.metadata.binding ||
          identity.dev !== target.metadata.rootDev || identity.ino !== target.metadata.rootIno)
        throw failure('OWNER_UNAVAILABLE');
      if (observeSyncLock(target.replica)?.live) throw failure('OWNER_BUSY');
    });
  }
}
