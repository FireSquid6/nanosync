import { BrowserView, BrowserWindow, Utils } from 'electrobun/main';
import events from 'electrobun/main/events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClientService } from '../../../../packages/client-service/src/service.ts';
import { ConnectionSetup } from '../../../../packages/client-service/src/connection-setup.ts';
import { createClientRequests } from './client-rpc.ts';
import type { ClientSnapshot, DesktopRPC, Result } from '../shared/rpc.ts';

let publish: (snapshot: ClientSnapshot) => void = () => {};
const service = new ClientService(process.env['NANOSYNC_CLIENT_DIR'] ?? join(homedir(), '.nanosync'), {
  owner: 'Desktop',
  onChange: snapshot => publish(snapshot),
});
const setup = new ConnectionSetup(service.root);
let stopped = false;
let quitting: Promise<Result> | null = null;
function quit(): Promise<Result> {
  if (quitting) return quitting;
  quitting = (async (): Promise<Result> => {
    try {
      await service.stop();
      stopped = true;
      Utils.quit();
      return { ok: true, value: null };
    } catch {
      quitting = null;
      return { ok: false, error: 'Unable to stop desktop sync safely. Try quitting again.' };
    }
  })();
  return quitting;
}

const rpc = BrowserView.defineRPC<DesktopRPC>({ handlers: {} });
// Use a function, not framework object dispatch (which also looks up inherited keys).
rpc.setRequestHandler(createClientRequests({
  service,
  setup,
  chooseFolder: async () => {
    const paths = await Utils.openFileDialog({ startingFolder: homedir(), canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false });
    return paths[0] ?? null;
  },
  openExternal: url => Utils.openExternal(url),
  quit,
  stopping: () => quitting !== null,
  publish: snapshot => publish(snapshot),
}));

const mainWindow = new BrowserWindow({
  title: 'nanosync',
  url: 'views://mainview/live.html',
  rpc,
  // v2.0.7 native/shared/navigation_rules.h: ^ denies; last matching glob wins.
  navigationRules: JSON.stringify(['^*', 'views://mainview/live.html']),
  frame: { width: 1280, height: 900, x: 200, y: 200 },
});
publish = snapshot => {
  try {
    const result = mainWindow.webview?.rpc?.proxy.send.snapshotChanged(snapshot);
    if (result) void Promise.resolve(result).catch(() => {});
  } catch { /* The window may already be closing. */ }
};

// Both system quit and native window close wait for desktop-owned sync cleanup.
events.on('before-quit', event => {
  if (stopped) return;
  event.response = { allow: false };
  void quit();
});
events.on(`will-close-${mainWindow.id}`, event => {
  if (stopped) return;
  event.response = { allow: false };
  void quit();
});
