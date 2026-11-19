import { expect, test, spyOn } from 'bun:test';
import * as filesystem from 'node:fs';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:os';
import {
  privateDirectory,
  secureCreate,
  secureRead,
  setLifecycle,
  setPaused,
  readPreferences,
} from '@nanosync/client-service';
import {
  createWindowLifecycle,
  startupHidden,
  trayHealth,
  reconcileTick,
} from '../src/lifecycle';
import { desktopSingleton } from '../src/singleton';
import {
  desktopExec,
  reconcileStartup,
  trayHostAvailable,
  launcherEvidenceValid,
} from '../src/linux-effects';
import { associatedSession, sessionMonitor, validateSession } from '../src/linux-session';
import { createTrayEffect, type TrayHandle } from '../src/tray';
import { createDesktopBackend } from '../src/backend';

const preferences = { startAtLogin: false, trayEnabled: false, keepSyncingAfterClose: true };
const veto = () => ({ response: { allow: true } });

test('close hides without a tray; safe Quit vetoes synchronously, coalesces, waits cleanup, and reapproves', async () => {
  const gate = Promise.withResolvers<void>();
  let hidden = 0,
    shown = 0,
    stopped = 0,
    quits = 0;
  const saved = { ...preferences };
  const lifecycle = createWindowLifecycle({
    preferences: () => saved,
    hide: () => {
      hidden++;
    },
    show: () => {
      shown++;
    },
    shutdown: () => {
      stopped++;
      return gate.promise;
    },
    quit: () => {
      quits++;
    },
    failed: () => {
      throw Error('unexpected');
    },
  });
  const close = veto();
  lifecycle.close(close);
  expect(close.response.allow).toBe(false);
  expect([hidden, stopped, quits]).toEqual([1, 0, 0]);
  lifecycle.reopen();
  expect(shown).toBe(1);
  saved.keepSyncingAfterClose = false;
  const quit = veto();
  lifecycle.close(quit);
  lifecycle.beforeQuit(veto());
  lifecycle.quit();
  expect([stopped, quits]).toEqual([1, 0]);
  expect(lifecycle.closing).toBe(true);
  gate.resolve();
  await gate.promise;
  await Promise.resolve();
  expect(quits).toBe(1);
  const approved = veto();
  lifecycle.beforeQuit(approved);
  expect(approved.response.allow).toBe(true);
  for (const startup of [false, true])
    for (const keep of [false, true])
      expect(startupHidden(startup, { ...preferences, keepSyncingAfterClose: keep })).toBe(
        startup && keep,
      );
});

test('periodic reconciliation skips deferred probes without accumulating follow-up passes', async () => {
  const gate = Promise.withResolvers<void>();
  let pending: Promise<void> | undefined,
    calls = 0;
  const reconcile = () => {
    calls++;
    return (pending = gate.promise.finally(() => {
      pending = undefined;
    }));
  };
  reconcileTick(pending, reconcile);
  for (let tick = 0; tick < 10000; tick++) reconcileTick(pending, reconcile);
  expect(calls).toBe(1);
  const first = pending!;
  gate.resolve();
  await first;
  expect(calls).toBe(1);
  reconcileTick(pending, reconcile);
  await pending;
  expect(calls).toBe(2);
});

test('failed safe stop does not approve Quit, and a repeated request retries cleanup', async () => {
  const failed = Promise.withResolvers<void>();
  let failures = 0,
    attempts = 0,
    quits = 0;
  const lifecycle = createWindowLifecycle({
    preferences: () => preferences,
    hide() {},
    show() {},
    shutdown: () => (++attempts === 1 ? failed.promise : Promise.resolve()),
    quit: () => {
      quits++;
    },
    failed: () => {
      failures++;
    },
  });
  lifecycle.quit();
  failed.reject(Error('held ownership'));
  await failed.promise.catch(() => {});
  await Promise.resolve();
  await Promise.resolve();
  expect([failures, quits]).toEqual([1, 0]);
  lifecycle.quit();
  await Promise.resolve();
  expect(quits).toBe(1);
});

test('session switching/locking is not logout; closing, monitor loss and unknown association fail closed exactly once', () => {
  let state = 'active',
    flush = true,
    stopped = 0;
  const facts = { id: '7', uid: 123, type: 'x11', display: ':77', remote: 0 };
  const inspect = () => validateSession({ ...facts, state }, 123, ':77');
  const monitor = sessionMonitor(
    inspect,
    () => flush,
    () => {
      stopped++;
    },
  );
  expect(monitor.status.applied).toBe(true);
  state = 'online';
  monitor.check();
  expect(stopped).toBe(0);
  state = 'closing';
  monitor.check();
  monitor.check();
  expect(stopped).toBe(1);
  const lost = sessionMonitor(
    inspect,
    () => flush,
    () => {
      stopped++;
    },
  );
  expect(lost.status.applied).toBe(false);
  state = 'active';
  const bus = sessionMonitor(
    inspect,
    () => flush,
    () => {
      stopped++;
    },
  );
  flush = false;
  bus.check();
  expect(stopped).toBe(2);
  for (const patch of [{ uid: 456 }, { display: ':78' }, { type: 'tty' }, { remote: 1 }])
    expect(validateSession({ ...facts, state: 'active', ...patch }, 123, ':77').applied).toBe(
      false,
    );
  expect(
    validateSession(
      { ...facts, type: 'wayland', display: '', state: 'active' },
      123,
      ':77',
      'x11',
    ).applied,
  ).toBe(true);
  expect(
    validateSession(
      { ...facts, type: 'wayland', display: '', state: 'active' },
      123,
      ':77',
      'wayland',
    ).applied,
  ).toBe(false);
  expect(
    validateSession({ ...facts, type: 'wayland', display: '', state: 'active' }, 123, '', 'x11')
      .applied,
  ).toBe(false);
  expect(
    sessionMonitor(
      () => {
        throw Error('no PID/session mapping; multiple UID sessions');
      },
      () => true,
      () => {
        stopped++;
      },
    ).status.applied,
  ).toBe(false);
  expect(stopped).toBe(2);
});

test('session association prefers own PID, accepts only ENODATA plus explicit inherited ID, never guesses a UID session', () => {
  const missing = () => {
    throw Object.assign(Error('not associated'), { code: -constants.errno.ENODATA });
  };
  expect(associatedSession(() => 'own', 'other')).toEqual({ id: 'own', source: 'pid' });
  expect(associatedSession(missing, '7')).toEqual({ id: '7', source: 'inherited' });
  const staleSessionA = {
    id: '7',
    uid: 123,
    remote: 0,
    type: 'wayland',
    display: '',
    state: 'active',
  };
  const inherited = associatedSession(missing, '7');
  expect(
    validateSession(staleSessionA, 123, ':displayB', 'x11', inherited.source).applied,
  ).toBe(false);
  expect(validateSession(staleSessionA, 123, ':displayB', 'x11', 'pid').applied).toBe(true);
  expect(
    validateSession(
      { ...staleSessionA, type: 'x11', display: ':displayA' },
      123,
      ':displayB',
      'x11',
      inherited.source,
    ).applied,
  ).toBe(false);
  expect(
    validateSession(
      { ...staleSessionA, type: 'x11', display: ':displayB' },
      123,
      ':displayB',
      'x11',
      inherited.source,
    ).applied,
  ).toBe(true);
  expect(() => associatedSession(missing, undefined)).toThrow();
  expect(() => associatedSession(missing, '../arbitrary')).toThrow();
  expect(() =>
    associatedSession(() => {
      throw Object.assign(Error('uncertain'), { code: -constants.errno.EACCES });
    }, '7'),
  ).toThrow('uncertain');
});

test('tray creates nothing for off/unanswered/absent watcher; only Open, health imagery, loss/recreation', () => {
  const menus: unknown[] = [],
    images: string[] = [],
    titles: string[] = [];
  let created = 0,
    removed = 0,
    opened = 0;
  let clicked: (event: unknown) => void = () => {};
  const tray = createTrayEffect(
    (): TrayHandle => ({
      id: ++created,
      setMenu: (menu) => {
        menus.push(menu);
      },
      setImage: (image) => {
        images.push(image);
      },
      setTitle: (title) => {
        titles.push(title);
      },
      on: (_name, callback) => {
        clicked = callback;
      },
      remove: () => {
        removed++;
      },
    }),
    () => {
      opened++;
    },
  );
  const healthy = { attention: false, title: 'Nanosync — ● No intervention needed' };
  for (const enabled of [false, null]) tray.reconcile(enabled, true, healthy);
  expect(tray.reconcile(true, false, healthy).applied).toBe(false);
  expect(created).toBe(0);
  expect(trayHostAvailable('(true,)', '(<false>,)')).toBe(false);
  expect(trayHostAvailable('(false,)', '(<true>,)')).toBe(false);
  expect(trayHostAvailable('(true,)', '(<true>,)')).toBe(true);
  expect(tray.reconcile(true, true, healthy).applied).toBe(false);
  expect(tray.reconcile(true, true, healthy, true).applied).toBe(true);
  expect(menus).toEqual([[{ type: 'normal', label: 'Open Nanosync', action: 'open' }]]);
  clicked({ data: { action: '' } });
  clicked({ data: { action: 'quit' } });
  expect(opened).toBe(0);
  clicked({ data: { action: 'open' } });
  expect(opened).toBe(1);
  tray.reconcile(true, true, { attention: true, title: 'Nanosync — ◆ Needs attention' });
  expect(images.at(-1)).toBe('views://main/tray-attention.svg');
  expect(titles.at(-1)).toContain('◆');
  tray.reconcile(true, false, healthy);
  expect(removed).toBe(1);
  tray.reconcile(true, true, healthy);
  expect(created).toBe(2);
  expect(menus).toHaveLength(2);
  tray.close();
  expect(removed).toBe(2);
  expect(trayHealth(undefined).attention).toBe(true);
});

test('startup flags use Desktop Entry argv escaping and private profile-specific owned registration, never a foreign entry', () => {
  const parent = mkdtempSync('/tmp/ns-login-'),
    config = privateDirectory(join(parent, 'config'));
  const root = join(parent, 'profile with % $ ` " \\ characters');
  chmodSync(config, 0o755);
  const opts = {
    root,
    configHome: config,
    launcher: '/nix/store/trusted/bin/nanosync-desktop',
    consumer: true,
  };
  try {
    expect(reconcileStartup({ ...opts, enabled: false }).applied).toBe(false);
    expect(existsSync(join(config, 'autostart'))).toBe(false);
    expect(reconcileStartup({ ...opts, enabled: true, consumer: false }).applied).toBe(false);
    expect(reconcileStartup({ ...opts, enabled: true, launcher: null }).applied).toBe(false);
    expect(reconcileStartup({ ...opts, enabled: true }).applied).toBe(true);
    const files = readdirSync(join(config, 'autostart'));
    const path = join(config, 'autostart', files[0]!);
    const text = secureRead(path, 16384).toString();
    expect(text).toContain('"--startup" "--client-dir"');
    expect(text).toContain('%%');
    expect(text).not.toContain('/bin/sh');
    expect(desktopExec(['a%b', 'x y'])).toBe('"a%%b" "x y"');
    expect(() => desktopExec(['a\nb'])).toThrow();
    expect(reconcileStartup({ ...opts, root: `${root}2`, enabled: true }).applied).toBe(true);
    expect(readdirSync(join(config, 'autostart'))).toHaveLength(2);
    expect(reconcileStartup({ ...opts, enabled: false }).applied).toBe(false);
    expect(existsSync(path)).toBe(false);
    secureCreate(path, '[Desktop Entry]\nName=foreign\n');
    for (const enabled of [false, true]) {
      expect(reconcileStartup({ ...opts, enabled }).available).toBe(false);
      expect(secureRead(path).toString()).toContain('foreign');
    }
    expect(
      reconcileStartup({ ...opts, enabled: true, configHome: '/not-owned/no-entry' }).applied,
    ).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('startup retries visible-but-unflushed registration instead of claiming it applied after fsync failure', () => {
  const parent = mkdtempSync('/tmp/ns-login-fail-'),
    root = join(parent, 'client'),
    config = privateDirectory(join(parent, 'config'));
  const options = {
    enabled: true,
    root,
    configHome: config,
    launcher: '/nix/store/synthetic/bin/nanosync-desktop',
    consumer: true,
  };
  try {
    setLifecycle(root, { ...preferences, startAtLogin: true }, 0);
    expect(reconcileStartup(options).applied).toBe(true);
    const flush = spyOn(filesystem, 'fsyncSync').mockImplementation(() => {
      throw Error('synthetic filesystem failure');
    });
    try {
      expect(reconcileStartup(options).applied).toBe(false);
    } finally {
      flush.mockRestore();
    }
    expect(readPreferences(root).lifecycle.startAtLogin).toBe(true);
    expect(reconcileStartup(options).applied).toBe(true);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('installed launcher evidence must attest the pinned Resources/main.js to Worker argv path, not just a renamed upstream executable', () => {
  const parent = mkdtempSync('/tmp/ns-wrapper-'),
    launcher = join(parent, 'launcher');
  try {
    secureCreate(launcher, 'synthetic installed wrapper');
    const evidence = {
      version: 1,
      argv: 'verified-resources-main-worker-v1',
      sdkCommit: 'c9e637c4e8acc8d53fc4a1703346196b004a00d8',
      launcherSha256: createHash('sha256').update('synthetic installed wrapper').digest('hex'),
    };
    expect(launcherEvidenceValid(launcher, evidence)).toBe(true);
    for (const patch of [
      { argv: 'upstream-launcher' },
      { launcherSha256: '0'.repeat(64) },
      { sdkCommit: 'other' },
      { extra: true },
    ])
      expect(launcherEvidenceValid(launcher, { ...evidence, ...patch })).toBe(false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('singleton authenticates before activation, isolates profiles/sessions, checks root identity, and retains live ownership on uncertainty', async () => {
  const parent = mkdtempSync('/tmp/ns-one-'),
    root = join(parent, 'root'),
    runtime = join(parent, 'run');
  let opened = 0;
  const primary = await desktopSingleton(
    root,
    'session-a',
    () => {
      opened++;
      return true;
    },
    runtime,
  );
  const endpointDir = join(runtime, readdirSync(runtime)[0]!);
  const socket = join(endpointDir, 's');
  try {
    expect(primary.primary).toBe(true);
    expect(readdirSync(root)).toEqual([]);
    const alias = join(parent, 'alias');
    symlinkSync(root, alias);
    expect((await desktopSingleton(alias, 'session-a', () => false, runtime)).primary).toBe(
      false,
    );
    expect(opened).toBe(1);
    for (const authorization of [
      '',
      'Bearer nope',
      `Bearer ${'é'.repeat(64)}`,
      `Bearer ${'0'.repeat(64)}`,
    ]) {
      const reply = await fetch('http://localhost/activate', {
        unix: socket,
        method: 'POST',
        headers: { authorization },
        body: 'reopen',
      });
      expect(reply.status).toBe(403);
    }
    expect(opened).toBe(1);
    const secret = secureRead(join(endpointDir, 'capability')).toString();
    for (const [path, body] of [
      ['/other', 'reopen'],
      ['/activate', '{"exec":"no"}'],
    ]) {
      const reply = await fetch(`http://localhost${path}`, {
        unix: socket,
        method: 'POST',
        headers: { authorization: `Bearer ${secret}` },
        body,
      });
      expect(reply.status).toBe(409);
    }
    await expect(desktopSingleton(root, 'session-b', () => true, runtime)).rejects.toThrow(
      'DESKTOP_OTHER_SESSION',
    );
    chmodSync(join(endpointDir, 'capability'), 0o644);
    await expect(desktopSingleton(root, 'session-a', () => true, runtime)).rejects.toThrow();
    chmodSync(join(endpointDir, 'capability'), 0o600);
    const second = await desktopSingleton(
      join(parent, 'other'),
      'session-a',
      () => true,
      runtime,
    );
    expect(second.primary).toBe(true);
    await second.close();
    renameSync(root, `${root}-old`);
    mkdirSync(root, { mode: 0o700 });
    if (!primary.primary) throw Error('expected owner');
    expect(() => primary.assertCurrent()).toThrow();
    await expect(desktopSingleton(root, 'session-a', () => true, runtime)).rejects.toThrow(
      'DESKTOP_OWNER_UNAVAILABLE',
    );
    expect(opened).toBe(1);
  } finally {
    await primary.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('definitively dead singleton owner recovers; a live owner with missing discovery never permits takeover', async () => {
  const parent = mkdtempSync('/tmp/ns-dead-'),
    root = join(parent, 'root'),
    runtime = join(parent, 'run');
  const child = Bun.spawn(
    [process.execPath, join(import.meta.dir, 'fixtures/desktop-instance.ts'), root, runtime],
    { stdin: 'pipe', stdout: 'pipe', stderr: 'inherit' },
  );
  try {
    const reader = child.stdout.getReader();
    const ready = await reader.read();
    expect(new TextDecoder().decode(ready.value)).toContain('ready');
    reader.releaseLock();
    const endpointDir = join(runtime, readdirSync(runtime)[0]!);
    renameSync(join(endpointDir, 'endpoint'), join(endpointDir, 'saved-endpoint'));
    await expect(
      desktopSingleton(root, 'fixture-session', () => true, runtime),
    ).rejects.toThrow();
    renameSync(join(endpointDir, 'saved-endpoint'), join(endpointDir, 'endpoint'));
    child.kill('SIGKILL');
    await child.exited;
    const recovered = await desktopSingleton(root, 'fixture-session', () => true, runtime);
    expect(recovered.primary).toBe(true);
    await recovered.close();
  } finally {
    child.kill('SIGKILL');
    await child.exited;
    rmSync(parent, { recursive: true, force: true });
  }
});

test('closing incumbent refuses authenticated activation, and unsafe ancestry never becomes a second owner', async () => {
  const parent = mkdtempSync('/tmp/ns-busy-'),
    root = join(parent, 'root'),
    runtime = join(parent, 'run');
  const owner = await desktopSingleton(root, 'session', () => false, runtime);
  try {
    await expect(desktopSingleton(root, 'session', () => true, runtime)).rejects.toThrow(
      'DESKTOP_ACTIVATION_UNCERTAIN',
    );
    chmodSync(runtime, 0o777);
    await expect(desktopSingleton(root, 'session', () => true, runtime)).rejects.toThrow();
    chmodSync(runtime, 0o700);
  } finally {
    await owner.close();
    rmSync(parent, { recursive: true, force: true });
  }
});

test('CLI preference changes are read without re-saving stale flags; unknown session prevents desktop work but not metadata', async () => {
  const parent = mkdtempSync('/tmp/ns-effects-'),
    root = join(parent, 'root');
  const backend = createDesktopBackend(root, {
    async pickFolder() {
      return [];
    },
    async openAdministration() {
      return { ok: false };
    },
    quit() {},
    canSync: () => false,
  });
  try {
    const first = await backend.execute({ type: 'snapshot' });
    expect(first.ok).toBe(true);
    setLifecycle(root, preferences, 0);
    setPaused(root, { all: true }, true, 1);
    const changed = {
      ...preferences,
      startAtLogin: true,
      trayEnabled: true,
      keepSyncingAfterClose: false,
    };
    setLifecycle(root, changed, 2);
    const reply = await backend.execute({ type: 'snapshot' });
    if (!reply.ok) throw Error(reply.code);
    expect(reply.snapshot.settings.lifecycle).toEqual(changed);
    expect(reply.snapshot.settings.globalPaused).toBe(true);
    expect(readPreferences(root).revision).toBe(3);
    expect((await backend.execute({ type: 'initialize' })).ok).toBe(true);
    for (const type of ['start', 'sync-now'])
      expect(await backend.execute({ type, binding: randomUUID() })).toMatchObject({
        ok: false,
        code: 'DESKTOP_SESSION_UNAVAILABLE',
      });
    expect(
      await backend.execute({ type: 'settings', lifecycle: preferences, expectedRevision: 1 }),
    ).toMatchObject({ ok: false, code: 'CONFLICT' });
    await backend.shutdown();
    expect(readPreferences(root).lifecycle).toEqual(changed);
    expect(readPreferences(root).globalPaused).toBe(true);
    expect((await backend.execute({ type: 'snapshot' })).ok).toBe(true);
    expect(await backend.execute({ type: 'start', binding: randomUUID() })).toMatchObject({
      ok: false,
      code: 'OWNER_STOPPED',
    });
  } finally {
    await backend.shutdown();
    rmSync(parent, { recursive: true, force: true });
  }
});
