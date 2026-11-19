import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { createNativeNotifications } from '../../apps/desktop/src/notify-native';
import { notificationText } from '../../packages/client-service/src/notifications';

for (const key of ['NANOSYNC_XVFB', 'NANOSYNC_DBUS', 'NANOSYNC_NOTIFY_PYTHON'])
  assert.ok(process.env[key]?.startsWith('/nix/store/'), 'Use project nix develop');
const root = mkdtempSync('/tmp/ns-native-notifications-');
const children: ChildProcess[] = [],
  exits = new Map<ChildProcess, Promise<unknown>>();
const watchdog = AbortSignal.timeout(120000);
const environment = {
  ...process.env,
  HOME: join(root, 'home'),
  XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'),
  XDG_CACHE_HOME: join(root, 'cache'),
  XDG_RUNTIME_DIR: join(root, 'runtime'),
  XDG_DATA_DIRS: join(root, 'empty'),
  XDG_CONFIG_DIRS: join(root, 'empty'),
  DISPLAY: '',
  WAYLAND_DISPLAY: '',
  DBUS_SESSION_BUS_ADDRESS: '',
  DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${root}/no-system-bus`,
  XDG_SESSION_ID: '',
  GDK_BACKEND: 'x11',
  NO_AT_BRIDGE: '1',
};
for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'empty'])
  mkdirSync(join(root, name), { mode: 0o700 });
function start(executable: string, args: string[], descriptor = false) {
  const child = spawn(executable, args, {
    env: environment,
    detached: true,
    stdio: descriptor ? ['pipe', 'pipe', 'pipe', 'pipe'] : ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  exits.set(child, once(child, 'exit'));
  child.stderr!.on('data', (value) => process.stderr.write(value));
  return child;
}
async function firstLine(child: ChildProcess) {
  const lines = createInterface({ input: child.stdio[3] as Readable });
  try {
    return String((await once(lines, 'line', { signal: watchdog }))[0]);
  } finally {
    lines.close();
  }
}
const previous = { ...process.env };
let native: ReturnType<typeof createNativeNotifications> | undefined;
try {
  const display = start(
    process.env.NANOSYNC_XVFB!,
    ['-displayfd', '3', '-screen', '0', '960x720x24', '-nolisten', 'tcp', '-ac'],
    true,
  );
  environment.DISPLAY = `:${await firstLine(display)}`;
  const config = join(root, 'dbus.conf');
  writeFileSync(
    config,
    `<busconfig><type>session</type><listen>unix:tmpdir=${environment.XDG_RUNTIME_DIR}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
  );
  const bus = start(
    process.env.NANOSYNC_DBUS!,
    ['--nofork', `--config-file=${config}`, '--print-address=3'],
    true,
  );
  environment.DBUS_SESSION_BUS_ADDRESS = await firstLine(bus);
  Object.assign(process.env, environment);
  const broken = createNativeNotifications(
    () => {
      throw Error('Unexpected reopen');
    },
    {
      python: process.env.NANOSYNC_NOTIFY_PYTHON,
      typelibs: '/nix/store/nonexistent-typelib-fixture',
      delivery() {
        throw Error('Unexpected acceptance');
      },
    },
  );
  assert.equal(await broken.probe(), false);
  assert.equal(await broken.probe(), false);
  await broken.close();
  let reopened = Promise.withResolvers<void>(),
    dismissed = Promise.withResolvers<void>();
  const receipts: { id: number; dismissed: boolean }[] = [];
  let reopens = 0;
  native = createNativeNotifications(
    () => {
      reopens++;
      reopened.resolve();
    },
    {
      delivery(_batch, id, wasDismissed) {
        receipts.push({ id, dismissed: wasDismissed });
        if (wasDismissed) dismissed.resolve();
      },
    },
  );
  assert.equal(await native.probe(), false, 'No service is not delivered/available');
  let service = start('python3', [
    resolve('apps/desktop/tests/native/notification-service.py'),
  ]);
  let lines = createInterface({ input: service.stdout! })[Symbol.asyncIterator]();
  async function next() {
    const result = await Promise.race([
      lines.next(),
      exits.get(service)!.then(() => {
        throw Error('Notification fixture stopped');
      }),
      new Promise<never>((_, reject) =>
        watchdog.addEventListener(
          'abort',
          () => reject(Error('Native notification watchdog')),
          { once: true },
        ),
      ),
    ]);
    return JSON.parse(result.value!);
  }
  assert.equal((await next()).event, 'ready');
  assert.equal(await native.probe(), true);
  assert.equal(native.status.actions, true);
  const body = notificationText(
    `--leading <b>private & file</b> ' \" $(touch SENTINEL)\n\u202e`,
  );
  await native.submit({ category: 'conflicts', incidents: [], body });
  const shown = await next();
  assert.equal(shown.event, 'notify');
  assert.equal(shown.id, receipts[0]!.id);
  assert.equal(shown.body, body);
  assert.deepEqual(shown.actions, ['open', 'Open Nanosync']);
  service.stdin!.write(JSON.stringify({ operation: 'open', id: shown.id }) + '\n');
  await next();
  await reopened.promise;
  service.stdin!.write(JSON.stringify({ operation: 'close', id: shown.id, reason: 2 }) + '\n');
  await next();
  await dismissed.promise;
  assert.deepEqual(receipts, [
    { id: shown.id, dismissed: false },
    { id: shown.id, dismissed: true },
  ]);
  await native.submit({
    category: 'persistentFailures',
    incidents: [],
    body: 'Generic private-safe body',
  });
  const expires = await next();
  service.stdin!.write(
    JSON.stringify({ operation: 'close', id: expires.id, reason: 1 }) + '\n',
  );
  await next();
  await native.submit({ category: 'revokedAccess', incidents: [], body: 'Access unavailable' });
  const oldHandle = await next();
  assert.equal(
    receipts.filter((receipt) => receipt.dismissed).length,
    1,
    'Expiry is not explicit dismissal',
  );
  service.stdin!.write(JSON.stringify({ operation: 'no-actions' }) + '\n');
  await next();
  assert.equal(await native.probe(), true);
  assert.equal(native.status.actions, false);
  service.stdin!.write(JSON.stringify({ operation: 'stop' }) + '\n');
  await exits.get(service);
  await lines.return?.();
  assert.equal(await native.probe(), false);
  service = start('python3', [resolve('apps/desktop/tests/native/notification-service.py')]);
  lines = createInterface({ input: service.stdout! })[Symbol.asyncIterator]();
  assert.equal((await next()).event, 'ready');
  assert.equal(await native.probe(), true);
  service.stdin!.write(JSON.stringify({ operation: 'reuse', id: oldHandle.id }) + '\n');
  assert.equal((await next()).event, 'barrier');
  await native.probe();
  assert.equal(
    reopens,
    1,
    'Restarted service reused numeric IDs must not reopen old incidents',
  );
  assert.equal(receipts.filter((receipt) => receipt.dismissed).length, 1);
  await native.submit({ category: 'revokedAccess', incidents: [], body: 'Fresh owner' });
  const freshHandle = await next();
  assert.equal(freshHandle.event, 'notify', 'No CloseNotification for the previous owner ID');
  await native.close();
  const closedFresh = await next();
  assert.deepEqual(closedFresh, { event: 'remote-close', id: freshHandle.id });
  native = undefined;
  service.stdin!.write(JSON.stringify({ operation: 'stop' }) + '\n');
  await exits.get(service);
  await lines.return?.();
  console.log(
    JSON.stringify({
      result: 'PASS',
      acceptedId: shown.id,
      realLibnotifyActions: true,
      explicitDismissal: true,
      expiryNotDismissal: true,
      actionCapabilitySeparate: true,
      serviceRestartIdReuseSafe: true,
    }),
  );
} finally {
  await native?.close();
  for (const child of children.reverse()) {
    try {
      process.kill(-child.pid!, 'SIGKILL');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
    await exits.get(child);
  }
  for (const child of children)
    assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
  Object.assign(process.env, previous);
  rmSync(root, { recursive: true, force: true });
}
