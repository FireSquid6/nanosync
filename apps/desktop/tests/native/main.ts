import assert from 'node:assert/strict';
import { readFileSync, renameSync, watch, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CString, dlopen, ptr } from 'bun:ffi';
import Electrobun, { BrowserView, BrowserWindow, Utils } from 'electrobun/main';
import type { FixtureRPC } from './rpc';
import { observeConsole } from './observe-console';
import { verifyPackagedRuntime } from '../../src/verify-runtime';

// SDK_SECURITY_FIXTURE_ONLY: never an application backend or production entrypoint.
const sentinel = 'SYNTH_PASSWORD_71_SYNTH_RECOVERY_83';
const root = process.env.NANOSYNC_FIXTURE_ROOT!;
assert.ok(root.startsWith('/tmp/nanosync-native-security-'));
const runtime = verifyPackagedRuntime();
assert.ok(runtime.loadedCore.startsWith(root));
const symbols = dlopen(runtime.loadedCore, {
  getHostTransportDebugJSON: { args: [], returns: 'ptr' },
  freeCoreString: { args: ['ptr'], returns: 'void' },
  configureWebviewRuntime: { args: ['u32', 'ptr', 'ptr'], returns: 'bool' },
}).symbols;
let echoes = 0;
let rendererMalformed = false;
let preloadObserved = false;
let preloadLogs: string[] = [];
let navigationDenied = false;
let preloadWindow: BrowserWindow | undefined;
function publish(name: string, value: unknown) {
  const path = join(root, name);
  writeFileSync(`${path}.part`, JSON.stringify(value), { mode: 0o600 });
  renameSync(`${path}.part`, path);
}
function snapshot() {
  const payload = symbols.getHostTransportDebugJSON();
  if (!payload) throw Error("FIXTURE_DEBUG_UNAVAILABLE");
  try {
    return { debug: JSON.parse(new CString(payload).toString()), echoes, rendererMalformed, preloadObserved, preloadLogs, navigationDenied };
  } finally { symbols.freeCoreString(payload); }
}
const rpc = BrowserView.defineRPC<FixtureRPC>({ handlers: { requests: {
  echo(params) { console.log('FIXTURE_MAIN_ECHO'); assert.equal(params, null); echoes++; return { value: 'PROTECTED_SYNTHETIC_RESULT' }; },
  syncFailure(params) { assert.equal(params, null); throw Error(sentinel); },
  async asyncFailure(params) { assert.equal(params, null); throw Error(sentinel); },
  nonError(params) { assert.equal(params, null); throw sentinel; },
  rendererMalformedDone(params) { assert.equal(params, null); rendererMalformed = true; return true; },
  preloadObserved() { throw Error("WRONG_PRELOAD_VIEW"); },
  async ready(params) {
    console.log('FIXTURE_MAIN_READY');
    assert.equal(params.id, window.webview.id);
    assert.ok(Number.isSafeInteger(params.port) && params.port > 0 && params.port < 65536);
    for (const operation of [rpc.request.syncFailure, rpc.request.asyncFailure]) {
      await assert.rejects(operation(null), /RPC_REMOTE_FAILED/);
    }
    console.log('FIXTURE_MAIN_RENDERER_FAILURES_CHECKED');
    const report = await rpc.request.report(null);
    console.log('FIXTURE_MAIN_REPORT');
    assert.equal(report.href, 'views://main/index.html');
    assert.equal(report.socket, true);
    // The synthetic transport key is shared only over this private 0600 fixture file, never logs.
    publish('ready.json', { port: params.port, id: transport.webview.id, key: Array.from(transport.webview.secretKey), pid: process.pid, argv: process.argv.slice(2), runtime, snapshot: snapshot() });
    return { ok: true };
  },
} } });
const window = new BrowserWindow({
  title: 'Isolated SDK security fixture', url: 'about:blank', hidden: true, preload: observeConsole,
  frame: { x: 0, y: 0, width: 500, height: 400 }, rpc,
  allowedProtocols: { views: true, appData: false },
  navigationRules: JSON.stringify(['^*', 'views://main/index.html']),
});
window.webview.setNavigationRules(['^*', 'views://main/index.html']);
window.webview.loadURL('views://main/index.html');
const transportRpc = BrowserView.defineRPC<FixtureRPC>({ handlers: { requests: {
  echo(params) { assert.equal(params, null); echoes++; return { value: 'PROTECTED_SYNTHETIC_RESULT' }; },
  syncFailure(params) { assert.equal(params, null); throw Error(sentinel); },
  async asyncFailure(params) { assert.equal(params, null); throw Error(sentinel); },
  nonError(params) { assert.equal(params, null); throw sentinel; },
} } });
const transport = new BrowserWindow({
  title: 'Isolated transport target', url: 'about:blank', hidden: true, rpc: transportRpc,
  frame: { x: 0, y: 0, width: 400, height: 300 },
  allowedProtocols: { views: true, appData: false },
  navigationRules: JSON.stringify(['^*', 'views://main/transport.html']),
});
transport.webview.setNavigationRules(['^*', 'views://main/transport.html']);
transport.webview.loadURL('views://main/transport.html');
window.webview.on('will-navigate', (event: unknown) => {
  const detail = JSON.parse((event as { data: { detail: string } }).data.detail);
  if (detail.url.startsWith('http://127.0.0.1:') && detail.allowed === false) navigationDenied = true;
});

Electrobun.events.on('before-quit', () => { publish('quit-approval.json', { observed: true }); });

async function command(value: { id: number; operation: string; url?: string }) {
  assert.ok(Number.isSafeInteger(value.id));
  switch (value.operation) {
    case 'snapshot': return snapshot();
    case 'serializer-failure':
      await window.webview.queueHostMessageToWebview({ toJSON() { throw Error(sentinel); } });
      return { completed: true };
    case 'message-failures': rpc.send.notice({ value: 'SYNTHETIC_NOTIFICATION' }); return { dispatched: true };
    case 'push': transportRpc.send.notice({ value: 'PROTECTED_SYNTHETIC_RESULT' }); return snapshot();
    case 'malformed-renderer':
      window.webview.executeJavascript(`window.__electrobun.receiveMessageFromHost({type:${JSON.stringify(sentinel)}});window.__electrobunHostBridge.postMessage(JSON.stringify({type:'request',id:901,method:'rendererMalformedDone',params:null}));`);
      return snapshot();
    case 'preload-failure': {
      const full = readFileSync(join(runtime.bundle, 'Resources/preload-full.js'), 'utf8');
      const sandbox = readFileSync(join(runtime.bundle, 'Resources/preload-sandboxed.js'), 'utf8');
      const injected = `${observeConsole}\nwindow.crypto.subtle.importKey=()=>Promise.reject(new Error(${JSON.stringify(sentinel)}));\n${full}\0`;
      const preload = Buffer.from(injected), sandboxed = Buffer.from(`${sandbox}\0`);
      assert.ok(symbols.configureWebviewRuntime(0, ptr(preload), ptr(sandboxed)));
      preloadWindow = new BrowserWindow({
        title: 'Isolated synthetic preload failure', url: 'about:blank', hidden: true,
        rpc: BrowserView.defineRPC<FixtureRPC>({ handlers: { requests: {
          preloadObserved(params) { assert.ok(Array.isArray(params.logs) && params.logs.every(log => typeof log === "string" && log.length < 4096)); preloadLogs = params.logs; preloadObserved = true; return true; },
        } } }),
        frame: { x: 0, y: 0, width: 400, height: 300 },
        allowedProtocols: { views: true, appData: false },
        navigationRules: JSON.stringify(['^*', 'views://main/failure.html']),
      });
      preloadWindow.webview.setNavigationRules(['^*', 'views://main/failure.html']);
      preloadWindow.webview.loadURL('views://main/failure.html');
      assert.ok(preloadWindow.webview.id !== window.webview.id);
      return snapshot();
    }
    case 'navigation':
      assert.ok(value.url?.startsWith('http://127.0.0.1:'));
      window.webview.loadURL(value.url!);
      return snapshot();
    case 'popup': return rpc.request.popup({ url: value.url! });
    case 'report': return rpc.request.report(null);
    case 'fatal': setImmediate(() => { throw Error(sentinel); }); return { exiting: true };
    case 'quit': setImmediate(() => { assert.equal(Utils.quit(0), true); }); return { exiting: true };
    default: throw Error('FIXTURE_COMMAND');
  }
}
let last = 0;
let tail = Promise.resolve();
watch(root, (_event, filename) => {
  if (filename !== 'command.json') return;
  tail = tail.then(async () => {
    const value = JSON.parse(readFileSync(join(root, 'command.json'), 'utf8'));
    if (value.id <= last) return;
    last = value.id;
    const result = await command(value);
    publish(`response-${value.id}.json`, result);
  }).catch(() => { console.error('FIXTURE_COMMAND_FAILED'); process.exit(2); });
});
