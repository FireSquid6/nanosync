import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, renameSync, rmSync, watch, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { extractPackage, repository, verifyPackage, verifySdk } from './security';

const sentinel = 'SYNTH_PASSWORD_71_SYNTH_RECOVERY_83';
const root = mkdtempSync('/tmp/nanosync-native-security-');
const deadline = AbortSignal.timeout(120_000);
const children: ChildProcess[] = [];
const exits = new Map<ChildProcess, Promise<[number | null, NodeJS.Signals | null]>>();
const logs: string[] = [];
const sockets: WebSocket[] = [];
const normalQuit = process.argv.includes('--quit');
let result: Record<string, unknown> | undefined;
let remoteRequests = 0;
const remote = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch() {
  remoteRequests++;
  return new Response('<!doctype html><title>Forbidden remote fixture</title>');
} });
const env: NodeJS.ProcessEnv = {
  ...process.env, HOME: join(root, 'home'), XDG_CONFIG_HOME: join(root, 'config'),
  XDG_DATA_HOME: join(root, 'data'), XDG_CACHE_HOME: join(root, 'cache'),
  XDG_RUNTIME_DIR: join(root, 'runtime'), XDG_CONFIG_DIRS: join(root, 'empty'),
  XDG_DATA_DIRS: join(root, 'empty'), XAUTHORITY: join(root, 'authority'),
  DISPLAY: '', DBUS_SESSION_BUS_ADDRESS: '', NANOSYNC_FIXTURE_ROOT: root, ELECTROBUN_CONSOLE: '1',
  GDK_BACKEND: 'x11', NO_AT_BRIDGE: '1', LIBGL_ALWAYS_SOFTWARE: '1',
};
for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'empty']) mkdirSync(join(root, name), { mode: 0o700 });
function start(executable: string, args: string[], extraPipe = false, argv0?: string) {
  const child = spawn(executable, args, { env, cwd: argv0 ? dirname(executable) : root, detached: true, argv0,
    stdio: extraPipe ? ['ignore', 'pipe', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  exits.set(child, once(child, 'exit').then(([code, signal]) => [code, signal]));
  child.stdout!.on('data', data => logs.push(String(data)));
  child.stderr!.on('data', data => logs.push(String(data)));
  child.on('error', () => { console.error('NATIVE_FIXTURE_PROCESS_FAILED'); });
  return child;
}
async function firstLine(child: ChildProcess) {
  const lines = createInterface({ input: child.stdio[3] as Readable });
  try { return String((await once(lines, 'line', { signal: deadline }))[0]); }
  finally { lines.close(); }
}
async function waitFile(path: string): Promise<unknown> {
  if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
  return new Promise((resolve, reject) => {
    const watcher = watch(dirname(path), () => { if (existsSync(path)) finish(); });
    const abort = () => { watcher.close(); reject(Error('NATIVE_FIXTURE_DEADLINE')); };
    const finish = () => {
      watcher.close(); deadline.removeEventListener('abort', abort);
      try { resolve(JSON.parse(readFileSync(path, 'utf8'))); } catch { reject(Error('NATIVE_FIXTURE_RESPONSE')); }
    };
    deadline.addEventListener('abort', abort, { once: true });
    if (existsSync(path)) finish();
    if (deadline.aborted) abort();
  });
}
let sequence = 0;
async function command(operation: string, url?: string): Promise<any> {
  const id = ++sequence;
  writeFileSync(join(root, 'command.part'), JSON.stringify({ id, operation, url }), { mode: 0o600 });
  renameSync(join(root, 'command.part'), join(root, 'command.json'));
  return waitFile(join(root, `response-${id}.json`));
}
async function barrier(predicate: (snapshot: any) => boolean) {
  while (!deadline.aborted) {
    const snapshot = await command('snapshot');
    if (predicate(snapshot)) return snapshot;
  }
  throw Error('NATIVE_FIXTURE_DEADLINE');
}
function encrypt(value: unknown, key: Uint8Array) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return JSON.stringify({ encryptedData: data.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64') });
}
function decrypt(value: string, key: Uint8Array) {
  const packet = JSON.parse(value);
  const cipher = createDecipheriv('aes-256-gcm', key, Buffer.from(packet.iv, 'base64'));
  cipher.setAuthTag(Buffer.from(packet.tag, 'base64'));
  return JSON.parse(Buffer.concat([cipher.update(Buffer.from(packet.encryptedData, 'base64')), cipher.final()]).toString());
}
async function connect(port: number, id: number) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/socket?webviewId=${id}`);
  sockets.push(socket);
  const packets: string[] = [];
  socket.addEventListener('message', event => packets.push(String(event.data)));
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve(), { once: true });
    socket.addEventListener('error', () => reject(Error('FIXTURE_SOCKET_FAILED')), { once: true });
    deadline.addEventListener('abort', () => reject(Error('FIXTURE_SOCKET_DEADLINE')), { once: true });
  });
  return { socket, packets };
}
function assertLoopbackListener(pid: number, port: number) {
  const inodes = new Set<string>();
  for (const descriptor of readdirSync(`/proc/${pid}/fd`)) {
    try {
      const target = readlinkSync(`/proc/${pid}/fd/${descriptor}`);
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match) inodes.add(match[1]!);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  const listeners: string[] = [];
  for (const protocol of ['tcp', 'tcp6']) {
    const rows = readFileSync(`/proc/${pid}/net/${protocol}`, 'utf8').trim().split('\n').slice(1);
    for (const row of rows) {
      // Linux /proc/net/tcp: local address, state and socket inode identify this process's listener.
      const [, local, , state, , , , , , inode] = row.trim().split(/\s+/);
      if (state === '0A' && inodes.has(inode!) && Number.parseInt(local!.split(':')[1]!, 16) === port) {
        listeners.push(local!.split(':')[0]!);
      }
    }
  }
  assert.deepEqual(listeners, ['0100007F'], 'FRAMEWORK_LISTENER_MUST_BIND_IPV4_LOOPBACK_ONLY');
}

async function waitPackets(packets: string[], count: number) {
  while (packets.length < count && !deadline.aborted) await command('snapshot');
  assert.ok(packets.length >= count, 'FIXTURE_PACKET_DEADLINE');
}
try {
  for (const tool of ['NANOSYNC_XVFB', 'NANOSYNC_DBUS']) {
    assert.ok(process.env[tool]?.startsWith('/nix/store/'), 'Run security:gate through the locked nix develop shell');
  }
  verifySdk();
  const sourceTests = Bun.spawnSync([process.execPath, 'test', './apps/desktop/tests/sdk-listeners.native.ts', './apps/desktop/tests/sdk-shutdown.native.ts', './apps/desktop/tests/sdk-patches.integration.ts'], { cwd: repository, stdout: 'inherit', stderr: 'inherit' });
  assert.equal(sourceTests.exitCode, 0, 'SDK_SOURCE_REGRESSION');
  const build = Bun.spawnSync(['bash', 'tooling.sh', 'build', '--env=stable'], {
    cwd: join(repository, 'apps/desktop'), env: { ...process.env, NANOSYNC_DESKTOP_SECURITY_FIXTURE: '1' },
    stdout: 'inherit', stderr: 'inherit',
  });
  assert.equal(build.exitCode, 0, 'SECURITY_FIXTURE_BUILD_FAILED');
  const bundle = join(repository, 'apps/desktop/build/stable-linux-x64/NanosyncSDKSecurity');
  verifyPackage(bundle);
  const display = start(process.env.NANOSYNC_XVFB!, ['-displayfd', '3', '-screen', '0', '1280x900x24', '-nolisten', 'tcp', '-ac'], true);
  env.DISPLAY = `:${await firstLine(display)}`;
  const config = join(root, 'dbus.conf');
  writeFileSync(config, `<busconfig><type>session</type><listen>unix:tmpdir=${env.XDG_RUNTIME_DIR}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`);
  const bus = start(process.env.NANOSYNC_DBUS!, ['--nofork', `--config-file=${config}`, '--print-address=3'], true);
  env.DBUS_SESSION_BUS_ADDRESS = await firstLine(bus);
  const extracted = extractPackage(bundle, join(root, 'package'));
  const directRuntime = process.argv.includes('--inner-runtime');
  const launcher = join(extracted, 'bin/launcher');
  if (directRuntime) {
    env.LD_LIBRARY_PATH = `${dirname(launcher)}:${env.LD_LIBRARY_PATH ?? ''}`;
    env.ICU_DATA = dirname(launcher);
  }
  console.log(directRuntime ? 'SECURITY_GATE_INNER_RUNTIME' : 'SECURITY_GATE_LAUNCHER');
  const application = directRuntime
    ? start(join(extracted, 'bin/bun'), [join(extracted, 'Resources/main.js')], false, launcher)
    : start(launcher, []);
  const ready = await Promise.race([
    waitFile(join(root, 'ready.json')),
    exits.get(application)!.then(() => { throw Error('FIXTURE_EXIT_BEFORE_READY'); }),
  ]) as any;
  assertLoopbackListener(ready.pid, ready.port);
  const key = new Uint8Array(ready.key), wrongKey = randomBytes(32);
  assert.ok(ready.runtime.loadedCore.startsWith(root));
  assert.ok(ready.snapshot.debug.decryptOk >= 2, 'RENDERER_MUST_USE_REAL_ENCRYPTED_SOCKET');
  const authorized = await connect(ready.port, ready.id);
  const request = (id: number, method = 'echo') => ({ type: 'request', id, method, params: null });
  const baseline = await command('snapshot');
  authorized.socket.send(encrypt(request(100), key));
  await barrier(state => state.echoes === baseline.echoes + 1);
  await waitPackets(authorized.packets, 1);
  assert.equal(decrypt(authorized.packets[0]!, key).payload.value, 'PROTECTED_SYNTHETIC_RESULT');
  assert.throws(() => decrypt(authorized.packets[0]!, wrongKey));
  assert.ok(!authorized.packets[0]!.includes('PROTECTED_SYNTHETIC_RESULT'));
  const attacker = await connect(ready.port, ready.id);
  attacker.socket.send(JSON.stringify(request(101)));
  attacker.socket.send(encrypt(request(102), wrongKey));
  attacker.socket.send(JSON.stringify({ encryptedData: 'invalid', iv: 'invalid', tag: 'invalid' }));
  attacker.socket.send(JSON.stringify({ ...request(103), __electrobunPlaintextHostSocket: true }));
  await barrier(state => state.debug.decryptErrors >= baseline.debug.decryptErrors + 4);
  const untouched = await command('push');
  assert.equal(untouched.echoes, baseline.echoes + 1);
  await waitPackets(authorized.packets, 2);
  assert.equal(decrypt(authorized.packets[1]!, key).payload.value, 'PROTECTED_SYNTHETIC_RESULT');
  assert.equal(attacker.packets.length, 0);
  for (const [index, method] of ['syncFailure', 'asyncFailure', 'nonError'].entries()) {
    authorized.socket.send(encrypt(request(110 + index, method), key));
  }
  authorized.socket.send(encrypt({ type: sentinel, params: { password: sentinel, recovery: sentinel } }, key));
  authorized.socket.send(encrypt(request(120), key));
  await barrier(state => state.echoes === baseline.echoes + 2);
  await waitPackets(authorized.packets, 6);
  const failures = authorized.packets.slice(2, 5).map(packet => decrypt(packet, key));
  assert.ok(failures.every(packet => packet.success === false && packet.error === 'RPC_HANDLER_FAILED'));
  assert.ok(!JSON.stringify(failures).includes(sentinel));
  assert.deepEqual(await command('serializer-failure'), { completed: true });
  await command('message-failures');
  console.log('SECURITY_GATE_RENDERER_DISPATCH');
  await command('malformed-renderer');
  await barrier(state => state.rendererMalformed);
  console.log('SECURITY_GATE_NAVIGATION');
  await command('navigation', remote.url.href);
  await barrier(state => state.navigationDenied);
  const report = await command('report');
  assert.equal(report.href, 'views://main/index.html');
  assert.ok(!JSON.stringify(report.logs).includes(sentinel));
  assert.ok(report.logs.some((log: string) => log.includes('SDK_RPC_DISPATCH_FAILED')));
  const popup = await command('popup', remote.url.href);
  assert.equal(popup.denied, true);
  assert.equal(remoteRequests, 0);
  console.log('SECURITY_GATE_PRELOAD_FAILURE');
  await command('preload-failure');
  await barrier(state => state.preloadObserved);
  const finalSnapshot = await command('snapshot');
  await command(normalQuit ? 'quit' : 'fatal');
  const [exitCode] = await Promise.race([
    exits.get(application)!,
    new Promise<never>((_resolve, reject) => deadline.addEventListener('abort', () => reject(Error('FIXTURE_FATAL_DEADLINE')), { once: true })),
  ]);
  assert.equal(exitCode, normalQuit ? 0 : 1, normalQuit ? 'NATIVE_NORMAL_QUIT_MUST_EXIT_ZERO' : 'NATIVE_FATAL_EXIT_MUST_BE_PRESERVED');
  if (normalQuit) assert.deepEqual(await waitFile(join(root, 'quit-approval.json')), { observed: true });
  const output = logs.join('');
  assert.ok(!output.includes(sentinel), 'SYNTHETIC_SECRET_LEAKED');
  assert.ok(finalSnapshot.preloadLogs.some((log: string) => log.includes('SDK_PRELOAD_INDEX_TS_34')), 'NATIVE_PRELOAD_FAILURE_NOT_OBSERVED');
  assert.ok(!JSON.stringify(finalSnapshot.preloadLogs).includes(sentinel));
  assert.ok(output.includes('SDK_RPC_DISPATCH_FAILED'), 'NATIVE_DISPATCH_FAILURE_NOT_OBSERVED');
  assert.ok(output.includes('SDK_BROWSER_VIEW_ERROR'), 'NATIVE_SERIALIZER_FAILURE_NOT_OBSERVED');
  assert.ok(report.logs.filter((log: string) => log.includes('RPC_MESSAGE_HANDLER_FAILED')).length >= 2, 'NATIVE_MESSAGE_FAILURE_NOT_OBSERVED');
  assert.ok(output.includes('[stopEventLoop] Initiating clean event loop exit'), 'NATIVE_CLEAN_SHUTDOWN_NOT_OBSERVED');
  if (!normalQuit) assert.ok(output.includes('SDK_SDKS_MAIN_PROC_NATIVE_TS_2650'), 'NATIVE_FATAL_HANDLER_NOT_OBSERVED');
  result = { result: 'PASS', runtime: 'Bun 1.4.4 / Electrobun 2.0.6',
    process: directRuntime ? 'inner-runtime' : 'launcher', shutdown: normalQuit ? 'normal' : 'fatal',
    loopbackListener: '127.0.0.1',
    coreHash: ready.runtime.coreHash, preloadHash: ready.runtime.preloadHash,
    loadedPackagedCore: true, unauthorizedCalls: 0, attackerResults: 0, channelDisplaced: false,
    defaultPlaintextDisabled: true, nativePreloadFailureSanitized: true, nativeExit: exitCode,
    deniedRemoteNavigation: true, deniedPopup: true, snapshot: finalSnapshot };
} catch (error) {
  console.error(logs.join('').replaceAll(sentinel, '[SYNTHETIC_SECRET_REDACTED]'));
  throw error;
} finally {
  remote.stop(true);
  for (const socket of sockets) socket.close();
  for (const child of children.reverse()) {
    if (child.pid) {
      try { process.kill(-child.pid, 'SIGKILL'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    await exits.get(child);
  }
  while (!deadline.aborted) {
    const surviving = children.some(child => {
      if (!child.pid) return false;
      try { process.kill(-child.pid, 0); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; return false; }
    });
    if (!surviving) break;
    await new Promise(resolve => setImmediate(resolve));
  }
  for (const child of children) {
    if (child.pid) assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' }, 'FIXTURE_PROCESS_GROUP_SURVIVED');
  }
  rmSync(root, { recursive: true, force: true });
}
console.log(JSON.stringify({ ...result, fixtureProcessGroupsRemaining: 0 }));
