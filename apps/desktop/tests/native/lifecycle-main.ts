import assert from 'node:assert/strict';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import Electrobun, { BrowserView, BrowserWindow, Tray, Utils } from 'electrobun/main';
import { readPreferences, setLifecycle } from '@nanosync/client-service';
import { createWindowLifecycle, startupHidden } from '../../src/lifecycle';
import { desktopSingleton } from '../../src/singleton';
import { createDesktopBackend } from '../../src/backend';
import { createTrayEffect } from '../../src/tray';
import { trayWatcherAvailable, ownTrayRegistered } from '../../src/linux-effects';
const root = process.env.NANOSYNC_LIFECYCLE_FIXTURE!;
assert.ok(root.startsWith('/tmp/nanosync-native-lifecycle-'));
let window: BrowserWindow | undefined;
let opens = 0,
  quits = 0,
  cleanupReady = false,
  stopped = false;
const cleanup = Promise.withResolvers<void>();
function publish(name: string, value: unknown) {
  writeFileSync(join(root, `${name}.part`), JSON.stringify(value), { mode: 0o600 });
  renameSync(join(root, `${name}.part`), join(root, name));
}
const singleton = await desktopSingleton(
  join(root, 'client'),
  'private-fixture',
  (reopen) => {
    if (lifecycle.closing) return false;
    if (reopen) lifecycle.reopen();
    return true;
  },
  join(root, 'instances'),
);
assert.ok(singleton.primary);
const backend = createDesktopBackend(singleton.root, {
  async pickFolder() {
    return [];
  },
  async openAdministration() {
    return { ok: false };
  },
  quit() {},
});
function show() {
  opens++;
  if (!window) create(false);
  else window.showInactive();
}
const tray = createTrayEffect(
  () => new Tray({ title: 'Nanosync', image: 'views://main/tray.svg', template: false }),
  show,
);
const lifecycle = createWindowLifecycle({
  preferences: () => readPreferences(singleton.root).lifecycle,
  hide: () => window?.hide(),
  show,
  async shutdown() {
    const stopping = backend.shutdown();
    await stopping;
    stopped = true;
    await cleanup.promise;
    cleanupReady = true;
    tray.close();
    await singleton.close();
  },
  quit: () => {
    Utils.quit();
  },
  failed: () => {
    publish('failure.json', { failed: true });
  },
});
Electrobun.events.on('before-quit', (event) => {
  quits++;
  publish('quit.json', { quits, cleanupReady, stopped });
  lifecycle.beforeQuit(event as { response: { allow: boolean } });
});
function create(hidden: boolean) {
  const created = new BrowserWindow({
    title: 'Private lifecycle fixture',
    url: 'about:blank',
    hidden,
    activate: false,
    frame: { width: 480, height: 320, x: 0, y: 0 },
    allowedProtocols: { views: true, appData: false },
  });
  created.webview.setNavigationRules(['^*', 'about:blank']);
  created.on('will-close', (event) =>
    lifecycle.close(event as { response: { allow: boolean } }),
  );
  created.on('close', () => {
    if (window === created) window = undefined;
  });
  window = created;
}
create(startupHidden(true, readPreferences(singleton.root).lifecycle));
function snapshot() {
  return {
    id: window?.id ?? null,
    visible: window?.isVisible() ?? false,
    views: BrowserView.getAll().length,
    trays: Tray.getAll().length,
    opens,
    quits,
    cleanupReady,
    stopped,
    closing: lifecycle.closing,
  };
}
let last = 0,
  tail = Promise.resolve();
watch(root, (_event, name) => {
  if (name !== 'command.json') return;
  tail = tail
    .then(async () => {
      const command = JSON.parse(readFileSync(join(root, 'command.json'), 'utf8'));
      if (command.id <= last) return;
      last = command.id;
      let result: unknown;
      switch (command.operation) {
        case 'show':
          show();
          break;
        case 'request-close':
          window!.requestClose();
          break;
        case 'destroy':
          window!.close();
          break;
        case 'reopen':
          lifecycle.reopen();
          break;
        case 'tray-normal':
        case 'tray-attention': {
          result = tray.reconcile(
            true,
            await trayWatcherAvailable(),
            {
              title:
                command.operation === 'tray-normal'
                  ? 'Nanosync — ● No intervention needed'
                  : 'Nanosync — ◆ Needs attention',
              attention: command.operation === 'tray-attention',
            },
            await ownTrayRegistered(tray.id),
          );
          break;
        }
        case 'tray-off':
          result = tray.reconcile(false, true, { title: '', attention: false });
          break;
        case 'keep-off':
          setLifecycle(
            singleton.root,
            { startAtLogin: false, trayEnabled: false, keepSyncingAfterClose: false },
            readPreferences(singleton.root).revision,
          );
          break;
        case 'quit':
          result = Utils.quit();
          break;
        case 'release':
          setImmediate(() => cleanup.resolve());
          break;
        case 'snapshot':
          break;
        default:
          throw Error('FIXTURE_COMMAND');
      }
      publish(`response-${command.id}.json`, { result, ...snapshot() });
    })
    .catch(() => {
      publish('failure.json', { failed: true });
      process.exit(2);
    });
});
publish('ready.json', snapshot());
