import { BrowserView, BrowserWindow, Utils } from 'electrobun/main';
import events from 'electrobun/main/events';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ClientService } from '../../../../packages/client-service/src/service.ts';
import { validIdRequest } from '../shared/rpc.ts';
import type { ClientSnapshot, DesktopRPC, Result } from '../shared/rpc.ts';

let publish: (snapshot: ClientSnapshot) => void = () => {};
const service = new ClientService(process.env['NANOSYNC_CLIENT_DIR'] ?? join(homedir(), '.nanosync'), {
  owner: 'Desktop',
  onChange: snapshot => publish(snapshot),
});
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
rpc.setRequestHandler(async (method, params) => {
  if (method === 'quit') return params === undefined ? quit() : { ok: false, error: 'Invalid request.' };
  if (quitting) return { ok: false, error: 'Desktop sync is stopping.' };
  try {
    switch (method) {
      case 'snapshot':
        if (params !== undefined) return { ok: false, error: 'Invalid request.' };
        return { ok: true, value: await service.snapshot() };
      case 'sync':
      case 'migrate': {
        if (!validIdRequest(params)) return { ok: false, error: 'Invalid request.' };
        const snapshot = await service.snapshot();
        const known = method === 'sync' ? snapshot.folders : snapshot.servers;
        if (!known.some(item => item.id === params.id)) return { ok: false, error: 'Item no longer exists. Refresh and try again.' };
        if (method === 'sync') await service.sync(params.id);
        else await service.migrate(params.id);
        publish(await service.snapshot());
        return { ok: true, value: null };
      }
      default: return { ok: false, error: 'Unsupported request.' };
    }
  } catch (error) {
    // Only known codes select fixed messages; exception text can contain secrets.
    const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
    if (code === 'CREDENTIAL_STORE_LOCKED') return { ok: false, error: 'Unlock the OS credential store and retry. No protected-file fallback was used.' };
    if (code === 'CREDENTIALS_REQUIRED') return { ok: false, error: 'Choose credential migration in Connections before syncing from the desktop.' };
    if (code === 'CONFLICT') return { ok: false, error: 'The folder or connection is in use or has changed. Stop its active sync owner before migrating credentials, then refresh.' };
    return { ok: false, error: 'Operation failed. Refresh and check the client status.' };
  }
});

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
