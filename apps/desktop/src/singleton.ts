import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import {
  acquireSyncLock,
  observeSyncLock,
  privateDirectory,
  secureCreate,
  secureRead,
  secureReplace,
} from '@nanosync/client-service';

export function canonicalClientRoot(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  return join(realpathSync(dirname(absolute)), basename(absolute));
}
const identity = (path: string) => {
  const stat = lstatSync(path, { bigint: true });
  return `${stat.dev}:${stat.ino}`;
};
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function lockIdentity(directory: string) {
  const lock = observeSyncLock(directory);
  return lock
    ? {
        owner: lock.owner,
        inode: { dev: lock.inode.dev, ino: lock.inode.ino },
        live: lock.live,
      }
    : null;
}
function socketIdentity(path: string) {
  const stat = lstatSync(path);
  if (!stat.isSocket() || stat.uid !== process.getuid!() || (stat.mode & 0o777) !== 0o600)
    throw Error('DESKTOP_ENDPOINT_UNSAFE');
  return identity(path);
}
function put(path: string, text: string) {
  if (existsSync(path)) secureReplace(path, text);
  else secureCreate(path, text);
}
type Endpoint = {
  version: 1;
  root: string;
  rootIdentity: string;
  session: string;
  lock: NonNullable<ReturnType<typeof observeSyncLock>>;
  directory: string;
  socket: string;
};

/** The shared PID/starttime lock is authority. A failed activation never permits takeover. */
export async function desktopSingleton(
  rootPath: string,
  session: string,
  activate: (reopen: boolean) => boolean,
  runtime?: string,
  reopen = true,
) {
  const root = privateDirectory(canonicalClientRoot(rootPath));
  const base = privateDirectory(runtime ?? `/tmp/nanosync-desktop-${process.getuid!()}`);
  const directory = privateDirectory(
    join(base, createHash('sha256').update(root).digest('hex').slice(0, 32)),
  );
  const socket = join(directory, 's');
  if (Buffer.byteLength(socket) > 103) throw Error('DESKTOP_ENDPOINT_PATH');
  const record = join(directory, 'endpoint');
  const capability = join(directory, 'capability');
  function readEndpoint(): Endpoint {
    privateDirectory(base);
    privateDirectory(directory);
    const endpoint = JSON.parse(secureRead(record, 4096).toString()) as Endpoint;
    const lock = lockIdentity(directory);
    if (
      !endpoint ||
      Object.keys(endpoint).sort().join(',') !==
        'directory,lock,root,rootIdentity,session,socket,version' ||
      endpoint.version !== 1 ||
      endpoint.root !== root ||
      !lock?.live ||
      !same(endpoint.lock, lock) ||
      endpoint.directory !== identity(directory) ||
      endpoint.socket !== socketIdentity(socket) ||
      typeof endpoint.session !== 'string' ||
      typeof endpoint.rootIdentity !== 'string' ||
      endpoint.rootIdentity !== identity(root)
    )
      throw Error('DESKTOP_OWNER_UNAVAILABLE');
    return endpoint;
  }
  let release: () => void;
  try {
    release = acquireSyncLock(directory);
  } catch (error) {
    // Includes publication-in-progress, malformed and uncertain live ownership: fail closed.
    const endpoint = readEndpoint();
    if (endpoint.session !== session) throw Error('DESKTOP_OTHER_SESSION');
    const secret = secureRead(capability, 64).toString();
    if (!/^[0-9a-f]{64}$/.test(secret)) throw Error('DESKTOP_ENDPOINT_UNSAFE');
    if (!same(readEndpoint(), endpoint)) throw Error('DESKTOP_OWNER_CHANGED');
    const response = await fetch('http://localhost/activate', {
      unix: socket,
      method: 'POST',
      headers: { authorization: `Bearer ${secret}` },
      body: reopen ? 'reopen' : 'ping',
      redirect: 'error',
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok || (await response.text()) !== 'opened' || !same(readEndpoint(), endpoint))
      throw Error('DESKTOP_ACTIVATION_UNCERTAIN', { cause: error });
    // The reply cannot authorize a second owner, even if the incumbent stopped in the meantime.
    return { primary: false as const, root, close: async () => {} };
  }
  let server: ReturnType<typeof Bun.serve> | undefined;
  let ownSocket: string | undefined;
  let endpoint: Endpoint | undefined;
  try {
    // Only a successful authoritative acquisition permits stale endpoint cleanup.
    if (existsSync(socket)) {
      socketIdentity(socket);
      unlinkSync(socket);
    }
    const secret = randomBytes(32).toString('hex');
    put(capability, secret);
    let requests = 0;
    server = Bun.serve({
      unix: socket,
      maxRequestBodySize: 32,
      async fetch(request) {
        const received = request.headers.get('authorization') ?? '';
        const expected = `Bearer ${secret}`;
        if (
          !/^Bearer [0-9a-f]{64}$/.test(received) ||
          !timingSafeEqual(Buffer.from(received), Buffer.from(expected))
        )
          return new Response('denied', { status: 403 });
        if (requests >= 8) return new Response('busy', { status: 503 });
        requests++;
        try {
          if (
            !endpoint ||
            secureRead(capability, 64).toString() !== secret ||
            !same(readEndpoint(), endpoint) ||
            request.method !== 'POST' ||
            new URL(request.url).pathname !== '/activate' ||
            new URL(request.url).search ||
            request.headers.has('origin')
          )
            return new Response('unavailable', { status: 409 });
          const action = await request.text();
          if (action !== 'reopen' && action !== 'ping')
            return new Response('unavailable', { status: 409 });
          return activate(action === 'reopen')
            ? new Response('opened')
            : new Response('closing', { status: 409 });
        } catch {
          return new Response('unavailable', { status: 409 });
        } finally {
          requests--;
        }
      },
    });
    chmodSync(socket, 0o600);
    ownSocket = socketIdentity(socket);
    endpoint = {
      version: 1,
      root,
      rootIdentity: identity(root),
      session,
      lock: lockIdentity(directory)!,
      directory: identity(directory),
      socket: ownSocket,
    };
    put(record, JSON.stringify(endpoint));
    return {
      primary: true as const,
      root,
      assertCurrent() {
        if (!same(readEndpoint(), endpoint) || secureRead(capability, 64).toString() !== secret)
          throw Error('DESKTOP_INSTANCE_CHANGED');
      },
      async close() {
        await server!.stop(true);
        if (existsSync(socket)) {
          if (socketIdentity(socket) !== ownSocket) throw Error('DESKTOP_ENDPOINT_CHANGED');
          unlinkSync(socket);
        }
        release();
      },
    };
  } catch (error) {
    await server?.stop(true);
    release();
    throw error;
  }
}
