import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from 'electrobun/main';
import { ClientError, readPreferences } from '@nanosync/client-service';
import type { DesktopRPC, DesktopSnapshot } from './rpc';
import { createDesktopBackend } from './backend';
import { openAdministration, openCheckedFolder } from './open-native';
import {
  createWindowLifecycle,
  startupHidden,
  reconcileTick,
  trayHealth,
  unavailable,
  type LifecycleStatus,
} from './lifecycle';
import { desktopSingleton } from './singleton';
import { linuxSession } from './linux-session';
import {
  autostartConsumerAvailable,
  installedLauncher,
  reconcileStartup,
  trayWatcherAvailable,
  ownTrayRegistered,
} from './linux-effects';
import { createTrayEffect } from './tray';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--client-dir');
if (rootFlag >= 0 && (!args[rootFlag + 1] || args[rootFlag + 1]!.startsWith('--')))
  throw Error('CLIENT_DIRECTORY_REQUIRED');
const requestedRoot = resolve(
  rootFlag < 0 ? join(homedir(), '.nanosync') : args[rootFlag + 1]!,
);
let sessionLost = false;
const session = linuxSession(() => {
  sessionLost = true;
  lifecycle?.quit();
});
let lifecycle: ReturnType<typeof createWindowLifecycle> | undefined;
let window: BrowserWindow | undefined;
const startup = args.includes('--startup');
const singleton = await desktopSingleton(
  requestedRoot,
  session.identity,
  (reopen) => {
    if (!lifecycle || lifecycle.closing || sessionLost) return false;
    if (reopen) lifecycle.reopen();
    return true;
  },
  undefined,
  !startup,
).catch((error) => {
  session.close();
  console.error(
    'DESKTOP_INSTANCE_UNAVAILABLE: No second owner was launched. Wait for the existing instance to stop, then retry in its graphical session.',
  );
  throw error;
});
if (
  !singleton.primary ||
  (startup && !readPreferences(singleton.root).lifecycle.startAtLogin)
) {
  if (singleton.primary) {
    reconcileStartup({
      enabled: false,
      root: singleton.root,
      configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      launcher: null,
      consumer: false,
    });
    await singleton.close();
  }
  session.close();
  Utils.quit();
} else {
  const primary = singleton;
  const root = primary.root;
  let timer: ReturnType<typeof setInterval> | undefined;
  let reconciling: Promise<void> | undefined;
  const status: LifecycleStatus = {
    startup: unavailable('Startup has not yet been reconciled.'),
    tray: unavailable('Tray has not yet been reconciled.'),
    session: session.status,
    closing: false,
  };
  function assertInstance() {
    try {
      primary.assertCurrent();
    } catch {
      lifecycle?.quit();
      throw new ClientError('DESKTOP_INSTANCE_UNAVAILABLE', 'Instance changed');
    }
  }
  const backend = createDesktopBackend(root, {
    pickFolder: () =>
      Utils.openFileDialog({
        startingFolder: homedir(),
        canChooseFiles: false,
        canChooseDirectory: true,
        allowsMultipleSelection: false,
      }),
    openAdministration,
    openFolder: openCheckedFolder,
    quit() {
      lifecycle!.quit();
    },
    requestQuit() {
      lifecycle!.quit();
    },
    lifecycleStatus: () => ({
      ...status,
      session: session.status,
      closing: lifecycle?.closing ?? false,
    }),
    canSync: () => {
      session.check();
      return session.status.applied && !sessionLost;
    },
    preferencesChanged: reconcile,
    authorize: assertInstance,
  });
  function createWindow(hidden = false) {
    const rpc = BrowserView.defineRPC<DesktopRPC>({
      handlers: { requests: { client: (value) => backend.execute(value) } },
    });
    const created = new BrowserWindow({
      title: 'Nanosync',
      url: 'about:blank',
      frame: { width: 1100, height: 820, x: 120, y: 120 },
      rpc,
      hidden,
      allowedProtocols: { views: true, appData: false },
      navigationRules: JSON.stringify(['^*', 'views://main/index.html']),
    });
    created.webview.setNavigationRules(['^*', 'views://main/index.html']);
    created.webview.loadURL('views://main/index.html');
    created.on('will-close', (event) =>
      lifecycle!.close(event as { response: { allow: boolean } }),
    );
    created.on('close', () => {
      if (window === created) window = undefined;
    });
    window = created;
    return created;
  }
  function show() {
    if (!window) createWindow();
    else window.show();
  }
  const tray = createTrayEffect(
    () => new Tray({ title: 'Nanosync', image: 'views://main/tray.svg', template: false }),
    show,
  );
  lifecycle = createWindowLifecycle({
    preferences: () => readPreferences(root).lifecycle,
    hide: () => window?.hide(),
    show,
    async shutdown() {
      // Stop admission synchronously in backend.shutdown before waiting for any native effect.
      const stopped = backend.shutdown();
      clearInterval(timer);
      await stopped;
      await reconciling;
      tray.close();
      session.close();
      await singleton.close();
    },
    quit: () => {
      Utils.quit();
    },
    failed() {
      status.shutdownError =
        'Shutdown failed. Ownership is retained; inspect saved state and retry Quit.';
      show();
    },
  });
  Electrobun.events.on('before-quit', (event) =>
    lifecycle!.beforeQuit(event as { response: { allow: boolean } }),
  );
  async function reconcile() {
    if (lifecycle?.closing) return;
    if (reconciling) {
      await reconciling;
      return reconcile();
    }
    reconciling = (async () => {
      // Read after capability probes: CLI changes are never written back from cached UI/native state.
      assertInstance();
      const requested = readPreferences(root).lifecycle;
      const [watcher, consumer] = await Promise.all([
        requested.trayEnabled === true ? trayWatcherAvailable() : false,
        requested.startAtLogin ? autostartConsumerAvailable() : false,
      ]);
      if (lifecycle?.closing) return;
      const preferences = readPreferences(root).lifecycle;
      status.startup = reconcileStartup({
        enabled: preferences.startAtLogin,
        root,
        configHome: process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
        launcher: installedLauncher(),
        consumer,
      });
      const reply = await backend.execute({ type: 'snapshot' });
      const snapshot: DesktopSnapshot | undefined = reply.ok ? reply.snapshot : undefined;
      const registered =
        watcher && preferences.trayEnabled === true ? await ownTrayRegistered(tray.id) : false;
      if (!lifecycle?.closing)
        status.tray = tray.reconcile(
          preferences.trayEnabled,
          watcher,
          trayHealth(snapshot),
          registered,
        );
    })()
      .catch(() => {
        tray.close();
        status.startup = unavailable(
          'Native reconciliation failed. Saved intent is retained; check settings and session availability.',
        );
        status.tray = unavailable('Tray state is unknown. Reopen with the launcher.');
      })
      .finally(() => {
        reconciling = undefined;
      });
    return reconciling;
  }
  createWindow(startupHidden(startup, readPreferences(root).lifecycle));
  await reconcile();
  if (!lifecycle.closing && !sessionLost) {
    timer = setInterval(() => {
      reconcileTick(reconciling, reconcile);
    }, 1500);
    session.check();
    if (session.status.applied && !sessionLost)
      void backend.resumeDesktopWork().catch(() => console.error('DESKTOP_RESUME_BLOCKED'));
  }
}
