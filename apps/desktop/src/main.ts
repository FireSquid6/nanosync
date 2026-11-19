import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import Electrobun, { BrowserView, BrowserWindow, Utils } from 'electrobun/main';
import type { DesktopRPC } from './rpc';
import { createDesktopBackend } from './backend';
import { openAdministration } from './open-native';

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--client-dir');
if (rootFlag >= 0 && !args[rootFlag + 1]) throw Error('CLIENT_DIRECTORY_REQUIRED');
const root = resolve(rootFlag < 0 ? join(homedir(), '.nanosync') : args[rootFlag + 1]!);
let quitSafe = false;
let shutdown: Promise<void> | undefined;
const backend = createDesktopBackend(root, {
  pickFolder: () => Utils.openFileDialog({ startingFolder: homedir(), canChooseFiles: false, canChooseDirectory: true, allowsMultipleSelection: false }),
  openAdministration,
  quit() { quitSafe = true; Utils.quit(); },
});
const rpc = BrowserView.defineRPC<DesktopRPC>({ handlers: { requests: { client: value => backend.execute(value) } } });
const window = new BrowserWindow({
  title: 'Nanosync', url: 'about:blank', frame: { width: 1100, height: 820, x: 120, y: 120 }, rpc,
  allowedProtocols: { views: true, appData: false },
  navigationRules: JSON.stringify(['^*', 'views://main/index.html']),
});
window.webview.setNavigationRules(['^*', 'views://main/index.html']);
window.webview.loadURL('views://main/index.html');
Electrobun.events.on('before-quit', (event: unknown) => {
  if (quitSafe) return;
  // Electrobun emits synchronously: veto now, then request Quit again after safe cleanup.
  (event as { response: { allow: boolean } }).response = { allow: false };
  shutdown ??= backend.shutdown().then(() => { quitSafe = true; Utils.quit(); }).catch(() => {
    console.error('DESKTOP_SHUTDOWN_BLOCKED');
    shutdown = undefined;
  });
});
window.on('will-close', (event: unknown) => {
  if (quitSafe) return;
  (event as { response: { allow: boolean } }).response = { allow: false };
  Utils.quit();
});
// Tray/startup/background policy are deliberately not installed until lifecycle step 10.
void backend.resumeDesktopWork().catch(() => console.error('DESKTOP_RESUME_BLOCKED'));
