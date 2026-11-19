import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  watch,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Readable } from 'node:stream';
import { desktopSingleton } from '../../apps/desktop/src/singleton';
import { desktopExec } from '../../apps/desktop/src/linux-effects';
import { extractPackage, repository, verifyPackage, verifySdk } from './security';

verifySdk();
for (const tool of ['NANOSYNC_XVFB', 'NANOSYNC_DBUS'])
  assert.ok(process.env[tool]?.startsWith('/nix/store/'), 'Use project nix develop');
const build = Bun.spawnSync(['bash', 'tooling.sh', 'build', '--env=stable'], {
  cwd: join(repository, 'apps/desktop'),
  env: { ...process.env, NANOSYNC_DESKTOP_LIFECYCLE_FIXTURE: '1' },
  stdout: 'inherit',
  stderr: 'inherit',
});
assert.equal(build.exitCode, 0);
const bundle = join(repository, 'apps/desktop/build/stable-linux-x64/NanosyncLifecycleFixture');
verifyPackage(bundle);
const results: unknown[] = [];
for (const mode of ['quit', 'close-off']) {
  const root = mkdtempSync('/tmp/nanosync-native-lifecycle-');
  const deadline = AbortSignal.timeout(120000);
  const children: ChildProcess[] = [],
    exits = new Map<ChildProcess, Promise<unknown>>();
  const logs: string[] = [];
  function guard<T>(work: Promise<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      const abort = () => reject(Error('LIFECYCLE_WATCHDOG'));
      deadline.addEventListener('abort', abort, { once: true });
      void work
        .then(resolve, reject)
        .finally(() => deadline.removeEventListener('abort', abort));
      if (deadline.aborted) abort();
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: join(root, 'home'),
    XDG_CONFIG_HOME: join(root, 'config'),
    XDG_DATA_HOME: join(root, 'data'),
    XDG_CACHE_HOME: join(root, 'cache'),
    XDG_RUNTIME_DIR: join(root, 'runtime'),
    XDG_CONFIG_DIRS: join(root, 'empty'),
    XDG_DATA_DIRS: join(root, 'empty'),
    DISPLAY: '',
    WAYLAND_DISPLAY: '',
    DBUS_SESSION_BUS_ADDRESS: '',
    DBUS_SYSTEM_BUS_ADDRESS: `unix:path=${root}/no-system-bus`,
    XDG_SESSION_ID: '',
    XDG_CURRENT_DESKTOP: 'DisposableLifecycleFixture',
    HYPRLAND_INSTANCE_SIGNATURE: '',
    XAUTHORITY: join(root, 'authority'),
    GDK_BACKEND: 'x11',
    NO_AT_BRIDGE: '1',
    LIBGL_ALWAYS_SOFTWARE: '1',
    ELECTROBUN_CONSOLE: '1',
    NANOSYNC_LIFECYCLE_FIXTURE: root,
  };
  for (const name of ['home', 'config', 'data', 'cache', 'runtime', 'empty'])
    mkdirSync(join(root, name), { mode: 0o700 });
  function start(executable: string, args: string[], extra = false, input = false) {
    const child = spawn(executable, args, {
      env,
      cwd: root,
      detached: true,
      stdio: extra
        ? ['ignore', 'pipe', 'pipe', 'pipe']
        : [input ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    exits.set(child, once(child, 'exit'));
    child.stdout!.on('data', (value) => logs.push(String(value)));
    child.stderr!.on('data', (value) => logs.push(String(value)));
    return child;
  }
  async function firstLine(child: ChildProcess) {
    const lines = createInterface({ input: child.stdio[3] as Readable });
    try {
      return String((await once(lines, 'line', { signal: deadline }))[0]);
    } finally {
      lines.close();
    }
  }
  async function waitFile(path: string): Promise<any> {
    if (existsSync(path)) return JSON.parse(readFileSync(path, 'utf8'));
    return new Promise((resolve, reject) => {
      const watcher = watch(dirname(path), () => {
        if (existsSync(path)) finish();
      });
      const abort = () => {
        watcher.close();
        reject(Error('LIFECYCLE_WATCHDOG'));
      };
      function finish() {
        watcher.close();
        deadline.removeEventListener('abort', abort);
        resolve(JSON.parse(readFileSync(path, 'utf8')));
      }
      deadline.addEventListener('abort', abort, { once: true });
      if (existsSync(path)) finish();
      if (deadline.aborted) abort();
    });
  }
  let sequence = 0;
  async function command(operation: string) {
    const id = ++sequence;
    writeFileSync(join(root, 'command.part'), JSON.stringify({ id, operation }), {
      mode: 0o600,
    });
    renameSync(join(root, 'command.part'), join(root, 'command.json'));
    return waitFile(join(root, `response-${id}.json`));
  }
  async function barrier(predicate: (state: any) => boolean) {
    while (!deadline.aborted) {
      const state = await command('snapshot');
      if (predicate(state)) return state;
    }
    throw Error('LIFECYCLE_WATCHDOG');
  }
  try {
    const display = start(
      process.env.NANOSYNC_XVFB!,
      ['-displayfd', '3', '-screen', '0', '960x720x24', '-nolisten', 'tcp', '-ac'],
      true,
    );
    env.DISPLAY = `:${await firstLine(display)}`;
    const config = join(root, 'dbus.conf');
    writeFileSync(
      config,
      `<busconfig><type>session</type><listen>unix:tmpdir=${env.XDG_RUNTIME_DIR}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
    );
    const bus = start(
      process.env.NANOSYNC_DBUS!,
      ['--nofork', `--config-file=${config}`, '--print-address=3'],
      true,
    );
    env.DBUS_SESSION_BUS_ADDRESS = await firstLine(bus);
    const argvScript = join(root, 'argv.ts'),
      entry = join(root, 'argv.desktop');
    const specialRoot = join(root, 'profile % $ ` " \\ data');
    writeFileSync(
      argvScript,
      'await Bun.write(process.env.NANOSYNC_LIFECYCLE_FIXTURE + "/argv.json", JSON.stringify(process.argv.slice(2)));',
    );
    writeFileSync(
      entry,
      `[Desktop Entry]\nType=Application\nName=Private argv fixture\nExec=${desktopExec([process.execPath, argvScript, '--startup', '--client-dir', specialRoot])}\n`,
    );
    const gio = Bun.which('gio');
    assert.ok(gio?.startsWith('/nix/store/'));
    const argvProcess = start(gio!, ['launch', entry]);
    assert.deepEqual(await guard(exits.get(argvProcess)!), [0, null]);
    assert.deepEqual(await waitFile(join(root, 'argv.json')), [
      '--startup',
      '--client-dir',
      specialRoot,
    ]);
    const extracted = extractPackage(bundle, join(root, 'package'));
    const app = start(join(extracted, 'bin/launcher'), []);
    const ready = await Promise.race([
      waitFile(join(root, 'ready.json')),
      exits.get(app)!.then(() => {
        throw Error('LIFECYCLE_EXIT_BEFORE_READY');
      }),
    ]);
    assert.equal(ready.visible, false);
    assert.equal(ready.trays, 0);
    assert.equal((await command('show')).visible, true);
    await command('request-close');
    const hidden = await barrier((state) => state.id === ready.id && !state.visible);
    assert.equal(hidden.trays, 0);
    async function activate() {
      const result = await desktopSingleton(
        join(root, 'client'),
        'private-fixture',
        () => false,
        join(root, 'instances'),
      );
      assert.equal(result.primary, false);
      return barrier((state) => state.visible);
    }
    await activate();
    await command('destroy');
    await barrier((state) => state.id === null && state.views === 0);
    const recreated = await activate();
    assert.notEqual(recreated.id, ready.id);
    assert.equal((await command('tray-normal')).result.applied, false);
    assert.equal((await command('snapshot')).trays, 0);
    const watcher = start(
      'python3',
      [join(repository, 'apps/desktop/tests/native/tray-watcher.py')],
      false,
      true,
    );
    const lines = createInterface({ input: watcher.stdout! })[Symbol.asyncIterator]();
    assert.equal(JSON.parse((await guard(lines.next())).value!).ready, true);
    async function watcherCommand(operation: string) {
      watcher.stdin!.write(JSON.stringify({ operation }) + '\n');
      const answer = await guard(
        Promise.race([
          lines.next(),
          exits.get(watcher)!.then(() => {
            throw Error('WATCHER_EXIT');
          }),
        ]),
      );
      return JSON.parse(answer.value!);
    }
    await watcherCommand('host-off');
    assert.equal((await command('tray-normal')).result.available, false);
    assert.equal((await command('snapshot')).trays, 0);
    await watcherCommand('host-on');
    assert.equal((await command('tray-normal')).result.available, true);
    let registered: any;
    do {
      registered = await watcherCommand('inspect');
      await command('snapshot');
    } while (!registered.registered && !deadline.aborted);
    assert.equal((await command('tray-normal')).result.applied, true);
    assert.deepEqual(registered.labels, ['Open Nanosync']);
    assert.equal(registered.title, 'Nanosync — ● No intervention needed');
    await command('request-close');
    await barrier((state) => !state.visible);
    await watcherCommand('open');
    await barrier((state) => state.visible);
    await command('tray-attention');
    let attention: any;
    do {
      attention = await watcherCommand('inspect');
      await command('snapshot');
    } while (attention.title !== 'Nanosync — ◆ Needs attention' && !deadline.aborted);
    assert.equal(attention.title, 'Nanosync — ◆ Needs attention');
    assert.notEqual(attention.icon, registered.icon);
    watcher.kill('SIGTERM');
    await exits.get(watcher);
    await lines.return?.();
    assert.equal((await command('tray-normal')).result.applied, false);
    assert.equal((await command('snapshot')).trays, 0);
    await command('request-close');
    await barrier((state) => !state.visible);
    await activate();
    if (mode === 'close-off') {
      await command('keep-off');
      await command('request-close');
    } else assert.equal((await command('quit')).result, false);
    const pending = await barrier((state) => state.stopped && state.closing);
    assert.equal(pending.cleanupReady, false);
    await assert.rejects(activate());
    await command('release');
    assert.deepEqual(await guard(exits.get(app)!), [0, null]);
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'quit.json'), 'utf8')), {
      quits: mode === 'quit' ? 2 : 1,
      cleanupReady: true,
      stopped: true,
    });
    assert.equal(existsSync(join(root, 'failure.json')), false);
    results.push({
      mode,
      authenticatedRecreation: true,
      privateWatcher: registered,
      attention,
      safeQuit: true,
    });
  } catch (error) {
    console.error(logs.join(''));
    throw error;
  } finally {
    writeFileSync(`/tmp/nanosync-step10-native-${mode}.log`, logs.join(''));
    for (const child of children.reverse()) {
      try {
        process.kill(-child.pid!, 'SIGKILL');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
      await exits.get(child);
    }
    const watchdog = AbortSignal.timeout(10000);
    while (!watchdog.aborted) {
      const live = children.some((child) => {
        try {
          process.kill(-child.pid!, 0);
          return true;
        } catch {
          return false;
        }
      });
      if (!live) break;
      await new Promise((resolve) => setImmediate(resolve));
    }
    for (const child of children)
      assert.throws(() => process.kill(-child.pid!, 0), { code: 'ESRCH' });
    rmSync(root, { recursive: true, force: true });
  }
}
console.log(JSON.stringify({ result: 'PASS', fixtureProcessGroupsRemaining: 0, results }));
