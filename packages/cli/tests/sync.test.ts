import {
  createConnection, privateDirectory, secureCreate, initializeCredentials, SyncRunner, openBoundSync, stopOwnedSync, stopBoundSyncForRemoval, type SyncOptions,
  type SyncEvent,
} from '@nanosync/client-service';
import { afterEach, expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, statSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocal } from "@nanosync/client-local";
import { LinuxWatcher } from '@nanosync/linux-client';
import { controlProcess } from '../../client-service/tests/control-process.ts';
import { HttpRemote } from "@nanosync/sync-core";
import { CHUNK_SIZE } from "@nanosync/protocol";
import { bootstrapWorkflow, credentials, joinVault } from "./support/legacy-fixture.ts";
import { main } from "../src/main.ts";
import { runServer } from "../src/server.ts";

const dirs: string[] = [];
const servers: { stop(): Promise<void> }[] = [];
const runners: SyncRunner[] = [];
afterEach(async () => {
  for (const runner of runners.splice(0)) await runner.stop();
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() {
  const dir = mkdtempSync(join(tmpdir(), "nanosync-sync-"));
  dirs.push(dir);
  return dir;
}
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
async function fixture() {
  const serverDir = temp(), firstDir = temp(), secondDir = temp(), firstFiles = temp(), secondFiles = temp();
  writeFileSync(join(serverDir, "pepper.hex"), "a".repeat(64), { mode: 0o600 });
  const server = await runServer({ directory: serverDir, port: await freePort(), scanIntervalMs: 3_600_000 });
  servers.push(server);
  let recovery = "";
  initializeCredentials(firstDir, 'protected-file');
  initializeCredentials(secondDir, 'protected-file');
  await bootstrapWorkflow(firstDir, server.url, join(serverDir, "bootstrap.hex"), "sync test password", async value => { recovery = value; });
  const secondId = randomUUID();
  expect((await joinVault(secondDir, server.url, secondId, "sync test password")).status).toBe("pending");
  expect(await main(["server", "devices", "approve", "--device-id", secondId, "--server-dir", serverDir])).toBe(0);
  expect((await joinVault(secondDir, server.url, secondId, undefined, recovery)).status).toBe("approved");
  const first = credentials(firstDir), second = credentials(secondDir);
  function options(creds: typeof first, clientDirectory: string, syncDirectory: string): SyncOptions {
    return { clientDirectory, syncDirectory, vaultId: creds.vaultId, deviceId: creds.deviceId,
      masterKey: Buffer.from(creds.masterKey, "hex"), baseUrl: creds.baseUrl, token: creds.token,
      pollMs: 10_000, scan: { debounceMs: 100, stabilityMs: 100 } };
  }
  function register(root: string, files: string, creds: typeof first) {
    const serverId = randomUUID();
    secureCreate(join(privateDirectory(join(root, "servers")), `${serverId}.json`), JSON.stringify({version:1, serverId, baseUrl:creds.baseUrl.replace(/\/$/, ""), deviceId:creds.deviceId, name:"test", token:creds.token}));
    secureCreate(join(privateDirectory(join(root, "keys")), `${serverId}-${creds.vaultId}.json`), JSON.stringify({version:1, serverId, vaultId:creds.vaultId, masterKey:creds.masterKey}));
    const binding = createConnection(root, files, serverId, creds.vaultId, creds.deviceId);
    return options(creds, privateDirectory(join(privateDirectory(join(root,"replicas")),binding.connectionId)), files);
  }
  return { serverDir, firstDir, secondDir, firstFiles, secondFiles, first, second,
    a: register(firstDir, firstFiles, first), b: register(secondDir, secondFiles, second), url: server.url };
}
function start(options: SyncOptions) {
  const runner = SyncRunner.start(options);
  runners.push(runner);
  return runner;
}
async function stop(runner: SyncRunner) {
  await runner.stop();
  runners.splice(runners.indexOf(runner), 1);
}
function controlledWatch(runner: SyncRunner, onSuccess: Parameters<SyncRunner["watch"]>[1], onError: Parameters<SyncRunner["watch"]>[2]) {
  const controller = new AbortController();
  let now = 10_000, paused = Promise.withResolvers<void>(), wake = Promise.withResolvers<void>();
  const watching = runner.watch(controller.signal, onSuccess, onError, {
    now: () => now,
    wait: async signal => {
      wake = Promise.withResolvers<void>();
      const abort = () => wake.reject(signal.reason);
      signal.addEventListener("abort", abort, { once: true });
      paused.resolve();
      try { signal.throwIfAborted(); await wake.promise; }
      finally { signal.removeEventListener("abort", abort); }
    },
  });
  return {
    ready: () => paused.promise,
    advance: async () => {
      await paused.promise;
      paused = Promise.withResolvers<void>();
      now += 10_000; wake.resolve();
      await paused.promise;
    },
    stop: async () => { controller.abort(); await watching; },
  };
}

test("sync reports transfer progress on stderr while preserving JSON stdout", async () => {
  const e = await fixture();
  const uploadProgress: SyncEvent[] = [];
  const publisher = start({ ...e.a, onEvent: event => uploadProgress.push(event) });
  await publisher.syncOnce();
  for (let index = 0; index < 26; index++) {
    writeFileSync(join(e.firstFiles, `note-${index}`), `contents ${index}`, { mode: 0o600 });
  }
  uploadProgress.length = 0;
  const head = await publisher.syncOnce();
  expect(uploadProgress[0]).toEqual({ type: "checking" });
  expect(uploadProgress).toContainEqual({ type: "scanning" });
  expect(uploadProgress).toContainEqual({ type: "transfer", direction: "upload", count: 25, bytes: expect.any(Number) });
  expect(uploadProgress.at(-1)).toEqual({ type: "complete" });

  const stdout: string[] = [], stderr: string[] = [];
  const output = spyOn(console, "log").mockImplementation(message => stdout.push(String(message)));
  const progress = spyOn(console, "error").mockImplementation(message => stderr.push(String(message)));
  try {
    expect(await main([
      "client", "sync", "--json", "--client-dir", e.secondDir, "--path", e.secondFiles,
    ])).toBe(0);
  } finally { output.mockRestore(); progress.mockRestore(); }
  expect(stdout).toHaveLength(1);
  expect(JSON.parse(stdout[0]!)).toEqual({ ok: true, code: "OK", data: head });
  const events = stderr.map(line => JSON.parse(line));
  expect(events.every(event => event.event === "sync-progress")).toBe(true);
  expect(events[0].message).toBe("Connecting to server and checking sync state...");
  expect(events.some(event => event.message.startsWith("Downloaded 25 encrypted objects"))).toBe(true);
  expect(events.at(-1).message).toBe("Sync complete.");
  expect(readFileSync(join(e.secondFiles, "note-25"), "utf8")).toBe("contents 25");
});

test("one-shot CLI sync converges enrolled devices, keeps rename identity, and rejects overlap", async () => {
  const e = await fixture();
  expect(await main(["client", "sync"])).toBe(2);
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstDir])).toBe(2);
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  writeFileSync(join(e.firstFiles, "note"), "before", { mode: 0o600 });
  const uploaded = start(e.a);
  expect(() => start(e.a)).toThrow(/live process|sync ownership lock/);
  const head = await uploaded.syncOnce();
  await stop(uploaded);
  const downloaded = start(e.b);
  expect((await downloaded.syncOnce()).revisionId).toBe(head.revisionId);
  await stop(downloaded);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const initial = await remote.manifest(head.revisionId, e.a.masterKey);
  const id = initial.manifest.entries.find(entry => entry.name === "note")?.id;
  expect(readFileSync(join(e.secondFiles, "note"), "utf8")).toBe("before");
  renameSync(join(e.firstFiles, "note"), join(e.firstFiles, "renamed"));
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  const after = await remote.head();
  expect((await remote.manifest(after.revisionId!, e.a.masterKey)).manifest.entries.find(entry => entry.name === "renamed")?.id).toBe(id);
  expect(readFileSync(join(e.secondFiles, "renamed"), "utf8")).toBe("before");
});

test("first snapshot sync imports an existing local file without deleting it", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "existing"), "kept", { mode: 0o600 });
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
  expect(readFileSync(join(e.firstFiles, "existing"), "utf8")).toBe("kept");
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "existing"), "utf8")).toBe("kept");
});

test("first import prunes nested virtualenv links and hardlinks while preserving included files", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), ".venv/\n**/cache/\n", { mode: 0o600 });
  mkdirSync(join(e.firstFiles, "project", ".venv"), { recursive: true });
  mkdirSync(join(e.firstFiles, "project", "cache"));
  writeFileSync(join(e.firstFiles, "project", "source"), "source");
  symlinkSync("missing", join(e.firstFiles, "project", ".venv", "link"));
  writeFileSync(join(e.firstFiles, "project", ".venv", "package"), "wheel");
  linkSync(join(e.firstFiles, "project", ".venv", "package"), join(e.firstFiles, "project", ".venv", "package-copy"));
  linkSync(join(e.firstFiles, "project", "source"), join(e.firstFiles, "project", ".venv", "hardlink"));
  symlinkSync("missing", join(e.firstFiles, "project", "cache", "link"));
  // The included source is now hardlinked, so safety still rejects it.
  const a = start(e.a);
  await expect(a.syncOnce()).rejects.toThrow(/unsafe filesystem entry/);
  unlinkSync(join(e.firstFiles, "project", ".venv", "hardlink"));
  const head = await a.syncOnce();
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const names = (await remote.manifest(head.revisionId, e.a.masterKey)).manifest.entries.map(entry => entry.name);
  expect(names).toContain("source");
  expect(names).not.toContain(".venv");
  expect(names).not.toContain("cache");
  expect(names).not.toContain(".nanosyncignore");
  await start(e.b).syncOnce();
  expect(readFileSync(join(e.secondFiles, "project", "source"), "utf8")).toBe("source");
  expect(existsSync(join(e.secondFiles, "project", ".venv"))).toBe(false);
});

test("local ignore preserves tracked remote state and never applies changes into ignored paths", async () => {
  const e = await fixture();
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, "shared"), "original");
  const original = await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "shared\nprivate/\n", { mode: 0o600 });
  mkdirSync(join(e.firstFiles, "private"), { mode: 0o700 });
  symlinkSync("missing", join(e.firstFiles, "private", "unsafe"));
  writeFileSync(join(e.firstFiles, "shared"), "locally ignored");
  writeFileSync(join(e.secondFiles, "new"), "remote change", { mode: 0o600 });
  mkdirSync(join(e.secondFiles, "private"), { mode: 0o700 });
  writeFileSync(join(e.secondFiles, "private", "remote"), "only on second device", { mode: 0o600 });
  await b.syncOnce();
  await a.syncOnce();
  expect(readFileSync(join(e.firstFiles, "shared"), "utf8")).toBe("locally ignored");
  expect(existsSync(join(e.firstFiles, "private", "remote"))).toBe(false);
  expect(readFileSync(join(e.secondFiles, "private", "remote"), "utf8")).toBe("only on second device");
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const current = await remote.head();
  expect((await remote.manifest(current.revisionId!, e.a.masterKey)).manifest.entries.find(entry => entry.name === "shared")?.id)
    .toBe((await remote.manifest(original.revisionId, e.a.masterKey)).manifest.entries.find(entry => entry.name === "shared")?.id);
  expect(readFileSync(join(e.firstFiles, "new"), "utf8")).toBe("remote change");
  writeFileSync(join(e.firstFiles, "outside"), "published", { mode: 0o600 });
  await a.syncOnce(); await b.syncOnce();
  expect(readFileSync(join(e.secondFiles, "shared"), "utf8")).toBe("original");
  expect(readFileSync(join(e.secondFiles, "outside"), "utf8")).toBe("published");
  unlinkSync(join(e.firstFiles, "shared"));
  symlinkSync("missing", join(e.firstFiles, "shared"));
  writeFileSync(join(e.secondFiles, "shared"), "remote update");
  await b.syncOnce(); await a.syncOnce();
  expect(existsSync(join(e.firstFiles, "shared"))).toBe(false); // dangling link remains untouched
  unlinkSync(join(e.firstFiles, "shared"));
  writeFileSync(join(e.firstFiles, "shared"), "locally ignored");
  unlinkSync(join(e.firstFiles, "private", "unsafe"));
  unlinkSync(join(e.firstFiles, ".nanosyncignore"));
  await expect(a.syncOnce()).rejects.toThrow(/divergent local path/);
});

test("unignoring a remote-only path cannot publish a deletion", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "private/\n", { mode: 0o600 });
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  mkdirSync(join(e.secondFiles, "private"));
  writeFileSync(join(e.secondFiles, "private", "only-remote"), "keep");
  const published = await b.syncOnce(); await a.syncOnce();
  unlinkSync(join(e.firstFiles, ".nanosyncignore"));
  await expect(a.syncOnce()).rejects.toThrow(/untracked or divergent remote path/);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  expect((await remote.head()).revisionId).toBe(published.revisionId);
  expect(readFileSync(join(e.secondFiles, "private", "only-remote"), "utf8")).toBe("keep");
});

test("unignoring a tracked path deleted while excluded cannot publish a deletion", async () => {
  const e = await fixture();
  const a = start(e.a);
  await a.syncOnce();
  writeFileSync(join(e.firstFiles, "tracked"), "keep");
  const head = await a.syncOnce();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "tracked\n", { mode: 0o600 });
  unlinkSync(join(e.firstFiles, "tracked"));
  await a.syncOnce();
  await stop(a);
  unlinkSync(join(e.firstFiles, ".nanosyncignore"));
  await expect(start(e.a).syncOnce()).rejects.toThrow(/previously ignored local path/);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  expect((await remote.head()).revisionId).toBe(head.revisionId);
});

test("remote deletion of ignored tracked content preserves local copy and unignore guard", async () => {
  const e = await fixture();
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, "tracked"), "local original");
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "tracked\n", { mode: 0o600 });
  unlinkSync(join(e.secondFiles, "tracked"));
  const deleted = await b.syncOnce();
  await a.syncOnce();
  expect(readFileSync(join(e.firstFiles, "tracked"), "utf8")).toBe("local original");
  writeFileSync(join(e.firstFiles, "unrelated"), "new");
  await a.syncOnce();
  unlinkSync(join(e.firstFiles, ".nanosyncignore"));
  await expect(a.syncOnce()).rejects.toThrow(/previously ignored local path/);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const head = await remote.head();
  expect(head.sequence).toBe(deleted.sequence + 1);
  expect((await remote.manifest(head.revisionId!, e.a.masterKey)).manifest.entries.find(entry => entry.name === "tracked")?.kind).toBe("tombstone");
});

test("remote rename of an ignored tracked file refuses apply before creating an intent", async () => {
  const e = await fixture();
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, "tracked"), "local original");
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "tracked\n", { mode: 0o600 });
  renameSync(join(e.secondFiles, "tracked"), join(e.secondFiles, "moved"));
  await b.syncOnce();
  await expect(a.syncOnce()).rejects.toThrow(/ignored entry moved/);
  expect(readFileSync(join(e.firstFiles, "tracked"), "utf8")).toBe("local original");
  const local = new ClientLocal(e.a.clientDirectory, e.a.vaultId, e.a.deviceId);
  try { expect(local.pendingApplies()).toEqual([]); } finally { local.close(); }
});

test("fresh client merges pre-existing local files with remote history", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "remote"), "uploaded", { mode: 0o600 });
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
  writeFileSync(join(e.secondFiles, "local"), "must stay", { mode: 0o600 });
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "local"), "utf8")).toBe("must stay");
  expect(readFileSync(join(e.secondFiles, "remote"), "utf8")).toBe("uploaded");
  const local = new ClientLocal(e.b.clientDirectory, e.b.vaultId, e.b.deviceId);
  try { expect(local.head("applied").revisionId).not.toBeNull(); }
  finally { local.close(); }
});

test('ignore rename followed by directory-fsync failure invalidates verified status before mutation without watcher timing', async () => {
  const e = await fixture(), runner = start(e.a);
  const { clientStatus, observeSyncLock } = await import('@nanosync/client-service');
  const filesystem = await import('node:fs'), { spyOn } = await import('bun:test');
  await runner.syncOnce();
  expect(clientStatus(e.firstDir).bindings[0]!.upToDate).toBe(true);
  const native = filesystem.fsyncSync;
  const failure = spyOn(filesystem, 'fsyncSync').mockImplementation(fd => {
    if (filesystem.readlinkSync(`/proc/self/fd/${fd}`) === e.firstFiles && filesystem.existsSync(join(e.firstFiles, '.nanosyncignore'))) throw Error('directory fsync injected');
    native(fd);
  });
  try { await expect(runner.saveIgnores('*.tmp', 'absent', () => {})).rejects.toThrow('directory fsync injected'); }
  finally { failure.mockRestore(); }
  expect(readFileSync(join(e.firstFiles, '.nanosyncignore'), 'utf8')).toBe('*.tmp');
  expect(clientStatus(e.firstDir).bindings[0]!.upToDate).toBe(false);
  expect(observeSyncLock(e.a.clientDirectory)?.live).toBe(true);
  await expect(runner.saveIgnores('# blind retry', 'absent', () => {})).rejects.toMatchObject({ code: 'CONFLICT' });
  expect(readFileSync(join(e.firstFiles, '.nanosyncignore'), 'utf8')).toBe('*.tmp');
  await stop(runner);
});

test("one-shot stale-head sync retains both concurrent edits and retries frozen accepted proposals", async () => {
  const e = await fixture();
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, "shared"), "base", { mode: 0o600 });
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.secondFiles, "shared"), "offline");
  writeFileSync(join(e.firstFiles, "shared"), "online");
  await a.syncOnce(); await b.syncOnce(); await a.syncOnce();
  const values = (dir: string) => readdirSync(dir).filter(name => name !== ".nanosync").map(name => readFileSync(join(dir, name), "utf8")).sort();
  expect(values(e.firstFiles)).toEqual(["offline", "online"]);
  expect(values(e.secondFiles)).toEqual(values(e.firstFiles));
  const { clientStatus } = await import('@nanosync/client-service');
  const status = clientStatus(e.secondDir).bindings[0]!;
  expect(status.facts?.conflicts).toBeGreaterThan(0);
  expect(status.upToDate).toBe(false);
  expect(status.attentionRequired).toBe(true);
  expect(status.lastSuccessfulSync).not.toBeNull();
  await stop(a); await stop(b);

  writeFileSync(join(e.firstFiles, "new"), "published", { mode: 0o600 });
  let lost = false;
  const requests: string[] = [];
  const transport = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance") {
      requests.push(await request.clone().text());
      const response = await fetch(request);
      if (!lost) { lost = true; await response.arrayBuffer(); throw new Error("lost accepted response"); }
      return response;
    }
    return fetch(request);
  };
  const interrupted = start({ ...e.a, fetch: transport });
  await expect(interrupted.syncOnce()).rejects.toThrow("lost accepted response");
  await stop(interrupted);
  const resumed = start({ ...e.a, fetch: transport });
  await resumed.syncOnce();
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  await stop(resumed);
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "new"), "utf8")).toBe("published");
  const { listConflicts, checkedConflictFolder } = await import('@nanosync/client-service');
  const open = listConflicts(e.secondDir).bindings[0]!;
  expect(open.conflicts.length).toBeGreaterThan(0);
  expect(checkedConflictFolder(e.secondDir, open.connectionId, open.conflicts[0]!.id)).toBe(e.secondFiles);
  expect(listConflicts(e.secondDir).bindings[0]!.conflicts).toEqual(open.conflicts);
  for (const conflict of open.conflicts) unlinkSync(join(e.secondFiles, conflict.path));
  expect(listConflicts(e.secondDir).bindings[0]!.conflicts).toEqual(open.conflicts);
  expect(await main(['client', 'sync', '--client-dir', e.secondDir, '--path', e.secondFiles])).toBe(0);
  expect(listConflicts(e.secondDir).bindings[0]!.conflicts).toEqual([]);
});

test("one-shot delete/edit merge retains the deletion and edited conflict copy", async () => {
  const e = await fixture();
  const a = start(e.a), b = start(e.b);
  await a.syncOnce(); await b.syncOnce();
  writeFileSync(join(e.firstFiles, "shared"), "base", { mode: 0o600 });
  const base = await a.syncOnce();
  await b.syncOnce();
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const original = (await remote.manifest(base.revisionId, e.a.masterKey)).manifest.entries.find(entry => entry.name === "shared")!;
  writeFileSync(join(e.secondFiles, "shared"), "edited");
  unlinkSync(join(e.firstFiles, "shared"));
  await a.syncOnce();
  const merged = await b.syncOnce();
  await a.syncOnce();
  const manifest = (await remote.manifest(merged.revisionId, e.a.masterKey)).manifest;
  expect(manifest.entries.find(entry => entry.id === original.id)?.kind).toBe("tombstone");
  expect(manifest.entries.some(entry => entry.kind === "file" && !!entry.conflict)).toBe(true);
  const values = (dir: string) => readdirSync(dir).filter(name => name !== ".nanosync").map(name => readFileSync(join(dir, name), "utf8"));
  expect(values(e.firstFiles)).toEqual(["edited"]);
  expect(values(e.secondFiles)).toEqual(values(e.firstFiles));
});

test("restarted one-shot sync retries only the incomplete chunk", async () => {
  const e = await fixture();
  await start(e.a).syncOnce();
  await stop(runners[0]!);
  const data = Buffer.alloc(CHUNK_SIZE + 29, 0x41);
  data.fill(0x42, CHUNK_SIZE);
  writeFileSync(join(e.firstFiles, "large"), data, { mode: 0o600 });
  const uploads: string[] = [];
  let truncated = false;
  const interrupted = start({ ...e.a, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/")) {
      uploads.push(request.url.split("/").at(-1)!);
      if (uploads.length === 2 && !truncated) {
        truncated = true;
        const frame = new Uint8Array(await request.arrayBuffer());
        const partial = frame.subarray(0, Math.floor(frame.length / 2));
        const headers = new Headers(request.headers);
        headers.set("content-length", String(partial.length));
        return fetch(request.url, { method: "PUT", headers, body: partial });
      }
    }
    return fetch(request);
  } });
  await expect(interrupted.syncOnce()).rejects.toThrow();
  await stop(interrupted);
  expect(truncated).toBe(true);
  expect(uploads).toHaveLength(2);
  const retry: string[] = [];
  const resumed = start({ ...e.a, fetch: (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/")) {
      retry.push(request.url.split("/").at(-1)!);
    }
    return fetch(request);
  } });
  await resumed.syncOnce();
  await stop(resumed);
  expect(retry).toEqual([uploads[1]!]);
  expect(await main(["client", "sync", "--client-dir", e.secondDir, "--path", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "large"))).toEqual(data);
});

test("foreground continuous sync polls changes and shuts down without retaining the owner lock", async () => {
  const e = await fixture();
  const runner = start({ ...e.a, pollMs: 10_000 });
  const heads: { revisionId: string; sequence: number }[] = [];
  const errors: unknown[] = [];
  const watching = controlledWatch(runner, head => heads.push(head), error => errors.push(error));
  try {
    await watching.ready();
    const initial = heads[0]!.sequence;
    writeFileSync(join(e.firstFiles, "activity"), "one", { mode: 0o600 });
    writeFileSync(join(e.firstFiles, "activity"), "two");
    await watching.advance();
    expect(heads.at(-1)!.sequence).toBe(initial + 1);
    await watching.advance();
    expect(heads.at(-1)!.sequence).toBe(initial + 1);
    expect(errors).toEqual([]);
  } finally { await watching.stop(); await stop(runner); }
  expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
});

test("continuous sync reloads ignore rules and prunes new unsafe directories", async () => {
  const e = await fixture();
  const runner = start({ ...e.a, pollMs: 10_000 });
  const heads: number[] = [], errors: unknown[] = [];
  const watching = controlledWatch(runner, head => heads.push(head.sequence), error => errors.push(error));
  try {
    await watching.ready();
    writeFileSync(join(e.firstFiles, ".nanosyncignore"), ".venv/\n", { mode: 0o600 });
    mkdirSync(join(e.firstFiles, ".venv"));
    symlinkSync("missing", join(e.firstFiles, ".venv", "link"));
    writeFileSync(join(e.firstFiles, "included"), "yes");
    await watching.advance();
    expect(heads.some(sequence => sequence > 1)).toBe(true);
    expect(errors).toEqual([]);
    const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
    const head = await remote.head();
    expect((await remote.manifest(head.revisionId!, e.a.masterKey)).manifest.entries.map(entry => entry.name))
      .toEqual(expect.arrayContaining(["included"]));
    expect((await remote.manifest(head.revisionId!, e.a.masterKey)).manifest.entries.some(entry => entry.name === ".venv")).toBe(false);
  } finally { await watching.stop(); await stop(runner); }
});

test("continuous CLI command runs in the foreground and releases the lock on SIGTERM", async () => {
  const e = await fixture();
  const lock = join(e.a.clientDirectory, ".sync-owner");
  const started = Promise.withResolvers<void>(), transport = globalThis.fetch;
  const requests = spyOn(globalThis, "fetch").mockImplementation(Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    started.resolve();
    return transport(input, init);
  }, { preconnect: transport.preconnect }));
  const running = main(["client", "sync", "--watch", "--client-dir", e.firstDir, "--path", e.firstFiles]);
  try {
    await started.promise;
    expect(existsSync(lock)).toBe(true);
    expect(await main(["client", "sync", "--client-dir", e.firstDir, "--path", e.firstFiles])).toBe(0);
    expect(await main(["client", "vaults", "disconnect", "--client-dir", e.firstDir, "--path", e.firstFiles, "--force", "--yes"])).toBe(2);
    expect(await main(["client", "connections", "remove", "--client-dir", e.firstDir, "--server", "test", "--force", "--yes"])).toBe(2);
    expect(existsSync(join(e.firstFiles, ".nanosync"))).toBe(true);
  } finally {
    process.emit("SIGTERM");
    try { expect(await running).toBe(0); } finally { requests.mockRestore(); }
  }
  expect(existsSync(lock)).toBe(false);
});

test("continuous sync reports an offline failure then retries until connected", async () => {
  const e = await fixture();
  let offline = true;
  const runner = start({ ...e.a, pollMs: 100, fetch: (input, init) => {
    if (offline) return Promise.reject(new TypeError("temporarily offline"));
    return fetch(input, init);
  } });
  const errors: unknown[] = [];
  const heads: string[] = [];
  const watching = controlledWatch(runner, head => heads.push(head.revisionId), error => errors.push(error));
  try {
    await watching.ready();
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(TypeError);
    offline = false;
    await watching.advance();
    expect(heads[0]).toBeTruthy();
  } finally { await watching.stop(); await stop(runner); }
});


test("deleted vault stops watch without changing plaintext or stored keys", async () => {
  const f = await fixture();
  writeFileSync(join(f.firstFiles, "precious.txt"), "offline unsynced work");
  const { ServerMetadataDatabase, VaultRepository, MaintenanceRepository } = await import('@nanosync/server-metadata');
  const cleaned = Promise.withResolvers<void>(), finishDeletion = MaintenanceRepository.prototype.finishDeletion;
  const cleanup = spyOn(MaintenanceRepository.prototype, 'finishDeletion').mockImplementation(function(this: InstanceType<typeof MaintenanceRepository>, id) {
    finishDeletion.call(this, id); cleaned.resolve();
  });
  const db = new ServerMetadataDatabase(join(f.serverDir, 'metadata.sqlite'));
  try { new VaultRepository(db).markDeleted(f.first.vaultId, {origin:'server-local',actorId:null}, Date.now()); }
  finally { db.close(); }
  const runner = start(f.a), controller = new AbortController();
  const errors: unknown[] = [];
  const outcome = await runner.watch(controller.signal, () => { throw Error('deleted sync succeeded'); }, error => errors.push(error))
    .then(() => 'unexpected success', error => { expect(error).toMatchObject({code:'VAULT_DELETED'}); return 'stopped'; });
  expect(outcome).toBe('stopped');
  expect(errors).toHaveLength(1);
  expect(errors[0]).toMatchObject({code:'VAULT_DELETED',status:410});
  expect(readFileSync(join(f.firstFiles, 'precious.txt'),'utf8')).toBe('offline unsynced work');
  expect(credentials(f.firstDir).masterKey).toBe(f.first.masterKey);
  expect(Buffer.from(f.a.masterKey).toString('hex')).toBe(f.first.masterKey);
  const inspection = new ServerMetadataDatabase(join(f.serverDir, 'metadata.sqlite'));
  try {
    await cleaned.promise;
    expect(new VaultRepository(inspection).deletions()[0]?.cleanupState).toBe('complete');
  } finally { inspection.close(); cleanup.mockRestore(); }
  const { LocalFilesystem } = await import('@nanosync/server-object-storage');
  expect((await new LocalFilesystem(join(f.serverDir, 'objects')).list()).keys).toEqual([]);
});

test('disconnect distinguishes synchronized plaintext from unscanned edits and preserves both', async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, 'saved'), 'published', {mode:0o600});
  expect(await main(['client','sync','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
  writeFileSync(join(e.firstFiles, 'saved'), 'unscanned', {mode:0o600});
  expect(await main(['client','vaults','disconnect','--client-dir',e.firstDir,'--path',e.firstFiles,'--yes'])).toBe(2);
  expect(readFileSync(join(e.firstFiles, 'saved'),'utf8')).toBe('unscanned');
  expect(existsSync(join(e.firstFiles,'.nanosync'))).toBe(true);
  expect(await main(['client','sync','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
  expect(await main(['client','vaults','disconnect','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
  expect(readFileSync(join(e.firstFiles, 'saved'),'utf8')).toBe('unscanned');
});

test('forced multi-binding removal preflights every lock and registry contention preserves all bindings', async () => {
  const e = await fixture();
  const { records } = await import('@nanosync/client-service');
  const { acquireSyncLock } = await import('@nanosync/client-service');
  const first = records(e.firstDir)[0]!;
  const another = temp();
  writeFileSync(join(another,'private-note'),'retained',{mode:0o600});
  createConnection(e.firstDir, another, first.serverId, first.vaultId, first.deviceId, true);
  const bindings = records(e.firstDir).sort((a,b) => a.connectionId.localeCompare(b.connectionId));
  const last = bindings[1]!;
  const release = acquireSyncLock(privateDirectory(join(privateDirectory(join(e.firstDir,'replicas')),last.connectionId)));
  const remove = ['client','connections','remove','--client-dir',e.firstDir,'--server',first.serverId,'--force','--yes'];
  try {
    expect(await main(remove)).toBe(2);
    expect(records(e.firstDir)).toHaveLength(2);
    for (const c of bindings) expect(existsSync(join(c.root,'.nanosync'))).toBe(true);
    expect(existsSync(join(e.firstDir,'servers',`${first.serverId}.json`))).toBe(true);
  } finally { release(); }
  const releaseRegistry = acquireSyncLock(privateDirectory(join(e.firstDir,'registry-lock')));
  try {
    expect(await main(remove)).toBe(2);
    expect(records(e.firstDir)).toHaveLength(2);
  } finally { releaseRegistry(); }
  expect(await main(remove)).toBe(0);
  expect(records(e.firstDir)).toHaveLength(0);
  expect(readFileSync(join(another,'private-note'),'utf8')).toBe('retained');
  expect(existsSync(join(e.firstDir,'servers',`${first.serverId}.json`))).toBe(false);
  // Local forgetting does not revoke the remote approved-device credential.
  expect((await fetch(e.url + '/v1/vaults',{headers:{authorization:`Bearer ${e.first.token}`}})).status).toBe(200);
});

test('connect revalidates the selected server after remote discovery races local removal', async () => {
  const e = await fixture();
  const { records } = await import('@nanosync/client-service');
  const binding = records(e.firstDir)[0]!, destination = temp();
  const native = globalThis.fetch;
  let removed = false;
  globalThis.fetch = (async (input, init) => {
    const response = await native(input, init);
    if (!removed && String(input).endsWith('/v1/vaults')) {
      removed = true;
      expect(await main(['client','connections','remove','--client-dir',e.firstDir,'--server',binding.serverId,'--force'])).toBe(0);
    }
    return response;
  }) as typeof fetch;
  try {
    expect(await main(['client','vaults','connect','--client-dir',e.firstDir,'--server',binding.serverId,'--vault',binding.vaultId,'--path',destination,'--non-interactive'])).toBe(2);
    expect(removed).toBe(true);
    expect(records(e.firstDir)).toHaveLength(0);
    expect(existsSync(join(destination,'.nanosync'))).toBe(false);
  } finally { globalThis.fetch = native; }
});

for (const [before, after] of [[0o600, 0o700], [0o700, 0o600]]) {
  test(`disconnect requires force for unscanned executable change ${before} -> ${after}`, async () => {
    const e = await fixture();
    const path = join(e.firstFiles, 'script');
    writeFileSync(path, '#!/bin/sh\necho saved\n', { mode: before });
    expect(await main(['client','sync','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
    chmodSync(path, after!);
    const disconnect = ['client','vaults','disconnect','--client-dir',e.firstDir,'--path',e.firstFiles];
    expect(await main([...disconnect, '--yes'])).toBe(2);
    expect(existsSync(join(e.firstFiles, '.nanosync'))).toBe(true);
    expect(await main([...disconnect, '--force'])).toBe(0);
    expect(readFileSync(path, 'utf8')).toBe('#!/bin/sh\necho saved\n');
    expect(statSync(path).mode & 0o777).toBe(after!);
  });
}

test("offline edits survive an interrupted merge across 65 remote revisions", async () => {
  const e = await fixture();
  const initial = start(e.b);
  await initial.syncOnce(); await stop(initial);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, vaultId: e.a.vaultId, fetch });
  let current = await remote.manifest((await remote.head()).revisionId!, e.a.masterKey);
  const folder = randomUUID(), root = current.manifest.entries.find(entry => entry.parentId === null)!;
  for (let i = 0; i < 65; i++) {
    const manifest = { ...current.manifest, revisionId: randomUUID(), parents: [current.manifest.revisionId],
      entries: [root, { id: folder, parentId: root.id, name: `remote-${i}`, kind: "directory" as const }] };
    expect((await remote.publish(manifest, [], [], e.a.masterKey, current.manifest.revisionId, new Date().toISOString())).status).toBe("accepted");
    current = await remote.manifest(manifest.revisionId, e.a.masterKey);
  }
  writeFileSync(join(e.secondFiles, "offline"), "local work", { mode: 0o600 });
  let advances = 0;
  const interrupted = start({ ...e.b, fetch: (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance" && ++advances === 3)
      return Promise.reject(new Error("interrupted reconciliation"));
    return fetch(request);
  } });
  await expect(interrupted.syncOnce()).rejects.toThrow("interrupted reconciliation");
  await stop(interrupted);
  const pending = new ClientLocal(e.b.clientDirectory, e.b.vaultId, e.b.deviceId);
  try { expect(pending.reconciliation()).not.toBeNull(); } finally { pending.close(); }
  const resumed = start(e.b), head = await resumed.syncOnce();
  expect(await resumed.syncOnce()).toEqual(head);
  expect(readFileSync(join(e.secondFiles, "offline"), "utf8")).toBe("local work");
  expect(statSync(join(e.secondFiles, "remote-64")).isDirectory()).toBe(true);
  const finished = new ClientLocal(e.b.clientDirectory, e.b.vaultId, e.b.deviceId);
  try { expect(finished.reconciliation()).toBeNull(); expect(finished.proposal()).toBeNull(); }
  finally { finished.close(); }
});

test("merge recovery handles a lost acceptance followed by interrupted filesystem staging", async () => {
  const e = await fixture(), a = start(e.a), initial = start(e.b);
  await a.syncOnce(); await initial.syncOnce();
  writeFileSync(join(e.firstFiles, "shared"), "base", { mode: 0o600 });
  await a.syncOnce(); await initial.syncOnce(); await stop(initial);
  writeFileSync(join(e.secondFiles, "shared"), "offline");
  writeFileSync(join(e.firstFiles, "shared"), "online");
  await a.syncOnce();
  let lost = false, interrupted = false;
  const transport: NonNullable<SyncOptions["fetch"]> = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const pathname = new URL(request.url).pathname;
    if (lost && !interrupted && pathname.startsWith("/v1/objects/chunk/")) {
      interrupted = true; throw new Error("staging interrupted");
    }
    const response = await fetch(request);
    if (!lost && pathname === "/v1/head/advance" && (await response.clone().json()).status === "accepted") {
      lost = true; await response.arrayBuffer(); throw new Error("merge acceptance lost");
    }
    return response;
  };
  const first = start({ ...e.b, fetch: transport });
  await expect(first.syncOnce()).rejects.toThrow("merge acceptance lost"); await stop(first);
  const second = start({ ...e.b, fetch: transport });
  await expect(second.syncOnce()).rejects.toThrow("staging interrupted"); await stop(second);
  const pending = new ClientLocal(e.b.clientDirectory, e.b.vaultId, e.b.deviceId);
  try { expect(pending.pendingApplies()).toHaveLength(1); expect(pending.reconciliation()).not.toBeNull(); }
  finally { pending.close(); }
  await start(e.b).syncOnce();
  expect(readdirSync(e.secondFiles).filter(name => name !== ".nanosync").map(name => readFileSync(join(e.secondFiles, name), "utf8")).sort())
    .toEqual(["offline", "online"]);
  const finished = new ClientLocal(e.b.clientDirectory, e.b.vaultId, e.b.deviceId);
  try { expect(finished.reconciliation()).toBeNull(); expect(finished.pendingApplies()).toEqual([]); expect(finished.proposal()).toBeNull(); }
  finally { finished.close(); }
});

test("abort and stop cancel stalled sync requests and release ownership", async () => {
  const e = await fixture();
  for (const action of ["abort", "stop"] as const) {
    const started = Promise.withResolvers<Request>();
    const runner = start({ ...e.a, fetch: input => {
      const request = input as Request; started.resolve(request);
      return new Promise<Response>((_resolve, reject) => {
        request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true });
      });
    } });
    const controller = new AbortController(), errors: unknown[] = [];
    const watching = runner.watch(controller.signal, () => { throw new Error("unexpected success"); }, error => errors.push(error));
    const request = await started.promise;
    if (action === "abort") controller.abort(); else await runner.stop();
    await watching; await stop(runner);
    expect(request.signal.aborted).toBe(true);
    expect(errors).toEqual([]);
    expect(existsSync(join(e.a.clientDirectory, ".sync-owner"))).toBe(false);
  }
});

test('synchronized executable metadata permits clean disconnect for publisher and downloaded replica', async () => {
  const e = await fixture();
  const path = join(e.firstFiles, 'script');
  writeFileSync(path, '#!/bin/sh\n', { mode: 0o600 });
  expect(await main(['client','sync','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
  chmodSync(path, 0o700);
  expect(await main(['client','sync','--client-dir',e.firstDir,'--path',e.firstFiles])).toBe(0);
  expect(await main(['client','sync','--client-dir',e.secondDir,'--path',e.secondFiles])).toBe(0);
  for (const [client, root] of [[e.firstDir, e.firstFiles], [e.secondDir, e.secondFiles]]) {
    expect(await main(['client','vaults','disconnect','--client-dir',client!,'--path',root!])).toBe(0);
    expect(statSync(join(root!, 'script')).mode & 0o100).toBe(0o100);
    expect(readFileSync(join(root!, 'script'), 'utf8')).toBe('#!/bin/sh\n');
  }
});

test('completed forwarding survives normal temporary host close before client returns', async () => {
  const e = await fixture(), closed = Promise.withResolvers<void>();
  let closing: Promise<void> | undefined;
  const host = await openBoundSync(e.firstDir, e.firstFiles, { origin: 'cli', instanceId: randomUUID(),
    onEvent(event) { if (event.type === 'complete') closing = host.close().then(() => closed.resolve()); } });
  const attached = await openBoundSync(e.firstDir, e.firstFiles, { origin: 'desktop', instanceId: randomUUID() });
  try {
    const syncing = attached.syncOnce();
    await closed.promise;
    expect(existsSync(join(e.a.clientDirectory, '.sync-owner'))).toBe(false);
    expect(await syncing).toMatchObject({ revisionId: expect.any(String), sequence: 1 });
  } finally { await closing; await attached.close(); await host.close(); }
});

test('attached CLI SIGINT detaches and desktop-instance stop leaves independent CLI process running', async () => {
  const e = await fixture(), instanceId = randomUUID();
  const owner = controlProcess(e.firstDir, e.firstFiles, { origin: 'cli', instanceId });
  let cli: ReturnType<typeof Bun.spawn> | undefined;
  try {
    await owner.next(); owner.command('watch');
    expect(await owner.next()).toEqual({ watching: true });
    expect(await owner.next()).toMatchObject({ head: { sequence: 1 } });
    cli = Bun.spawn([process.execPath, join(import.meta.dir, '../src/main.ts'), 'client', 'sync', '--watch', '--json',
      '--client-dir', e.firstDir, '--path', e.firstFiles], { stdout: 'pipe', stderr: 'pipe' });
    const stderr = cli.stderr as ReadableStream<Uint8Array>;
    const reader = stderr.getReader();
    let progress = '';
    while (!progress.includes('"event":"synced"')) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`attached CLI ended before ready: ${progress}`);
      progress += new TextDecoder().decode(chunk.value);
    }
    cli.kill('SIGINT');
    expect(await cli.exited).toBe(0);
    reader.releaseLock();
    expect(existsSync(join(e.a.clientDirectory, '.sync-owner'))).toBe(true);
    await stopOwnedSync(instanceId);
    owner.command('sync');
    expect(await owner.next()).toMatchObject({ head: { sequence: 1 } });
    expect(owner.child.exitCode).toBeNull();
  } finally {
    if (cli && cli.exitCode === null) { cli.kill('SIGINT'); await cli.exited; }
    await owner.close();
  }
});

test('intentional owner stop never promotes attached watch', async () => {
  const e = await fixture();
  const owner = controlProcess(e.firstDir, e.firstFiles, { origin: 'desktop', instanceId: randomUUID() });
  await owner.next(); owner.command('watch');
  expect(await owner.next()).toEqual({ watching: true });
  expect(await owner.next()).toMatchObject({ head: { sequence: 1 } });
  const attachedProcess = controlProcess(e.firstDir, e.firstFiles, { origin: 'cli', instanceId: randomUUID() });
  try {
    await attachedProcess.next(); attachedProcess.command('watch');
    expect(await attachedProcess.next()).toEqual({ watching: true });
    expect(await attachedProcess.next()).toMatchObject({ head: { sequence: 1 } });
    await stopBoundSyncForRemoval(e.firstDir, e.firstFiles);
    attachedProcess.command('sync');
    expect(await attachedProcess.next()).toEqual({ code: 'OWNER_UNAVAILABLE' });
    expect(existsSync(join(e.a.clientDirectory, '.sync-owner'))).toBe(false);
  } finally { await attachedProcess.close(); await owner.close(); }
});

test('watcher shutdown failure still awaits active pass and retains ownership', async () => {
  const e = await fixture(), ready = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let block = false;
  const runner = start({ ...e.a, fetch: async (input, init) => {
    if (block) { entered.resolve(); await release.promise; }
    return fetch(input, init);
  } });
  const controller = new AbortController();
  const watching = runner.watch(controller.signal, () => ready.resolve(), () => {});
  await ready.promise;
  block = true;
  const active = runner.syncOnce().catch(error => error);
  await entered.promise;
  const originalClose = LinuxWatcher.prototype.close;
  const close = spyOn(LinuxWatcher.prototype, 'close').mockImplementation(function(this: LinuxWatcher) {
    originalClose.call(this);
    throw Error('controlled watcher failure');
  });
  const stopping = runner.stop().catch(error => error);
  try {
    expect(existsSync(join(e.a.clientDirectory, '.sync-owner'))).toBe(true);
    release.resolve();
    await active;
    expect(await stopping).toMatchObject({ message: 'controlled watcher failure' });
    expect(existsSync(join(e.a.clientDirectory, '.sync-owner'))).toBe(true);
    await watching;
    // An uncertain stop deliberately retains this process's lock; isolate cleanup to the fixture.
    runners.splice(runners.indexOf(runner), 1);
  } finally { close.mockRestore(); release.resolve(); }
});

test('verified status uses injected success time, becomes stale on close and preserves history through pause and missing roots', async () => {
  const { startBoundSync, clientStatus, setPaused } = await import('@nanosync/client-service');
  const e = await fixture();
  let clock = 1000;
  const owner = { origin: 'desktop' as const, instanceId: randomUUID() };
  const runner = await startBoundSync(e.firstDir, e.firstFiles, { now: () => clock, owner });
  runners.push(runner);
  await runner.syncOnce();
  let status = clientStatus(e.firstDir, e.firstFiles, () => clock).bindings[0]!;
  expect(status).toMatchObject({ upToDate: true, lastSuccessfulSync: 1000, lastRemoteCheck: 1000, owner });
  const binding = status.connectionId;
  clock = 2000;
  setPaused(e.firstDir, { all: true }, true);
  await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
  status = clientStatus(e.firstDir, e.firstFiles).bindings[0]!;
  expect(status).toMatchObject({ phase: 'paused', error: null, upToDate: false, lastSuccessfulSync: 1000 });
  const errors: unknown[] = [];
  const watch = controlledWatch(runner, () => {}, error => errors.push(error));
  await watch.ready();
  expect(errors).toEqual([]);
  setPaused(e.firstDir, { binding }, true);
  setPaused(e.firstDir, { all: true }, false);
  await watch.advance();
  expect(clientStatus(e.firstDir).bindings[0]!.pause.effective).toBe(true);
  setPaused(e.firstDir, { binding }, false);
  await watch.advance();
  expect(clientStatus(e.firstDir).bindings[0]!.lastSuccessfulSync).toBe(2000);
  const readiness = spyOn(LinuxWatcher.prototype, 'ready');
  try {
    setPaused(e.firstDir, { binding }, true);
    await watch.advance();
    expect(readiness).not.toHaveBeenCalled();
    expect(errors).toEqual([]);
  } finally { readiness.mockRestore(); }
  await watch.stop(); runners.splice(runners.indexOf(runner), 1);
  status = clientStatus(e.firstDir).bindings[0]!;
  expect(status).toMatchObject({ upToDate: false, freshness: 'stale-or-unknown', lastSuccessfulSync: 2000 });
  renameSync(e.firstFiles, e.firstFiles + '-gone');
  try {
    expect(clientStatus(e.firstDir, e.firstFiles).bindings[0]).toMatchObject({ phase: 'folder-unavailable', lastSuccessfulSync: 2000 });
    await expect(startBoundSync(e.firstDir, e.firstFiles)).rejects.toThrow();
    expect(existsSync(e.firstFiles)).toBe(false);
    expect(existsSync(join(e.a.clientDirectory, 'local.sqlite'))).toBe(true);
  } finally { renameSync(e.firstFiles + '-gone', e.firstFiles); }
});

test('pause before advance preserves exact frozen proposal for restart replay', async () => {
  const { startBoundSync, setPaused, clientStatus } = await import('@nanosync/client-service');
  const e = await fixture();
  const initial = await startBoundSync(e.firstDir, e.firstFiles);
  await initial.syncOnce(); await initial.stop();
  writeFileSync(join(e.firstFiles, 'new'), 'durable local edit', { mode: 0o600 });
  const binding = clientStatus(e.firstDir).bindings[0]!.connectionId;
  let paused = false;
  const runner = await startBoundSync(e.firstDir, e.firstFiles, { fetch: async input => {
    const request = input as Request;
    const response = await fetch(request);
    if (!paused && request.method === 'PUT' && new URL(request.url).pathname.includes('/manifest/')) {
      paused = true; setPaused(e.firstDir, { binding }, true);
    }
    return response;
  } });
  await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
  await runner.stop();
  const local = new ClientLocal(e.a.clientDirectory, e.a.vaultId, e.a.deviceId);
  const frozen = local.proposal()!;
  expect(frozen.state).toBe('prepared');
  expect(local.statusFacts().pending.proposal).toBe(1);
  local.close();
  setPaused(e.firstDir, { binding }, false);
  const advances: unknown[] = [];
  const resumed = await startBoundSync(e.firstDir, e.firstFiles, { fetch: async input => {
    const request = input as Request;
    if (new URL(request.url).pathname === '/v1/head/advance') advances.push(await request.clone().json());
    return fetch(request);
  } });
  runners.push(resumed);
  await resumed.syncOnce();
  expect(advances[0]).toEqual(frozen.request);
  expect(readFileSync(join(e.firstFiles, 'new'), 'utf8')).toBe('durable local edit');
});

test('loss of root after scan and before upload never publishes deletions or recreates root', async () => {
  const { startBoundSync } = await import('@nanosync/client-service');
  const e = await fixture();
  const initial = await startBoundSync(e.firstDir, e.firstFiles);
  await initial.syncOnce(); await initial.stop();
  writeFileSync(join(e.firstFiles, 'new'), 'original', { mode: 0o600 });
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const before = await remote.head();
  let removed = false, uploads = 0, advances = 0;
  const runner = await startBoundSync(e.firstDir, e.firstFiles, { fetch: async input => {
    const request = input as Request, path = new URL(request.url).pathname;
    if (request.method === 'PUT') uploads++;
    if (path === '/v1/head/advance') advances++;
    const response = await fetch(request);
    if (!removed && path === '/v1/objects/presence') {
      removed = true; renameSync(e.firstFiles, e.firstFiles + '-original');
    }
    return response;
  } });
  try {
    await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'FOLDER_UNAVAILABLE' });
    await runner.stop();
    expect(removed).toBe(true); expect(uploads).toBe(0); expect(advances).toBe(0);
    expect(await remote.head()).toEqual(before);
    expect(existsSync(e.firstFiles)).toBe(false);
    expect(readFileSync(join(e.firstFiles + '-original', 'new'), 'utf8')).toBe('original');
    expect(existsSync(join(e.a.clientDirectory, 'local.sqlite'))).toBe(true);
  } finally { await runner.stop(); if (removed) renameSync(e.firstFiles + '-original', e.firstFiles); }
});

test('same-process pause delivery interrupts a large scan at bounded macrotask checkpoints', async () => {
  const { ClientError } = await import('@nanosync/client-service');
  const e = await fixture();
  let armed = false, blocked = false, scannedSteps = 0;
  const delivered = Promise.withResolvers<void>();
  const runner = start({ ...e.a,
    beforeWork() {
      if (armed) scannedSteps++;
      if (blocked) throw new ClientError('SYNC_PAUSED', 'paused');
    },
    onEvent(event) {
      if (event.type === 'scanning' && armed) setImmediate(() => { blocked = true; delivered.resolve(); });
    },
  });
  await runner.syncOnce();
  for (let index = 0; index < 100; index++) writeFileSync(join(e.firstFiles, `file-${index}`), 'edit');
  armed = true;
  await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
  await delivered.promise;
  expect(scannedSteps).toBeLessThan(100);
  expect(ClientLocal.readStatus(e.a.clientDirectory, e.a.vaultId, e.a.deviceId)!.pending.proposal).toBe(0);
});

test('pause preserves independent actionable error and last success without exposing remote error text', async () => {
  const { startBoundSync, clientStatus, setPaused } = await import('@nanosync/client-service');
  const { RemoteError } = await import('@nanosync/sync-core');
  const e = await fixture();
  let denied = false, clock = 1000;
  const runner = await startBoundSync(e.firstDir, e.firstFiles, { now: () => clock,
    fetch: async input => {
      if (denied) throw new RemoteError(403, 'FORBIDDEN', 'secret error sentinel');
      return fetch(input);
    },
  });
  runners.push(runner);
  await runner.syncOnce(); denied = true; clock = 2000;
  await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'FORBIDDEN' });
  setPaused(e.firstDir, { all: true }, true);
  await expect(runner.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
  const status = clientStatus(e.firstDir).bindings[0]!;
  expect(status).toMatchObject({ phase: 'paused', attentionRequired: true, error: 'FORBIDDEN', lastSuccessfulSync: 1000 });
  expect(JSON.stringify(status)).not.toContain('secret error sentinel');
});

test.each(['upload', 'download'] as const)('bound runner pauses an in-flight %s at a chunk boundary and resumes without retransferring it', async direction => {
  const { startBoundSync, clientStatus, setPaused } = await import('@nanosync/client-service');
  const e = await fixture();
  for (const [state, files] of [[e.firstDir, e.firstFiles], [e.secondDir, e.secondFiles]] as const) {
    const initial = await startBoundSync(state, files); await initial.syncOnce(); await initial.stop();
  }
  const payload = Buffer.alloc(CHUNK_SIZE + 17, 7);
  writeFileSync(join(e.firstFiles, 'bounded'), payload, { mode: 0o600 });
  if (direction === 'download') {
    const publisher = await startBoundSync(e.firstDir, e.firstFiles);
    await publisher.syncOnce(); await publisher.stop();
  }
  const state = direction === 'upload' ? e.firstDir : e.secondDir;
  const files = direction === 'upload' ? e.firstFiles : e.secondFiles;
  const binding = clientStatus(state).bindings[0]!.connectionId;
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  let requests = 0;
  const transport = async (input: RequestInfo | URL) => {
    const request = input as Request, response = await fetch(request);
    if (request.method === (direction === 'upload' ? 'PUT' : 'GET') &&
        new URL(request.url).pathname.startsWith('/v1/objects/chunk/')) {
      requests++;
      if (requests === 1) { entered.resolve(); await release.promise; }
    }
    return response;
  };
  const owner = { origin: 'desktop' as const, instanceId: randomUUID() };
  const runner = await startBoundSync(state, files, { fetch: transport, owner }); runners.push(runner);
  const pass = runner.syncOnce(); void pass.catch(() => {});
  try {
    await entered.promise;
    const held = clientStatus(state).bindings[0]!;
    const before = held.progress![direction];
    if (direction === 'download') {
      expect(held.facts!.pending.applies).toBe(1);
      expect(held.freshness).toBe('stale-or-unknown');
    }
    setPaused(state, { binding }, true);
    const pausing = clientStatus(state).bindings[0]!;
    expect(pausing).toMatchObject({ phase: 'pausing', ownerPresent: true, owner });
    if (direction === 'download') {
      expect(pausing.facts!.pending.applies).toBe(1);
      expect(pausing.freshness).toBe('stale-or-unknown');
    }
    release.resolve();
    await expect(pass).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
    expect(requests).toBe(1);
    const paused = clientStatus(state).bindings[0]!;
    expect(paused).toMatchObject({ phase: 'paused', upToDate: false, error: null });
    expect(paused.progress![direction].count - before.count).toBe(1);
    expect(paused.progress![direction].bytes - before.bytes).toBe(CHUNK_SIZE + 96);
    if (direction === 'download') expect(paused.facts!.pending.applies).toBe(1);
    await stop(runner);
    const resumed = await startBoundSync(state, files, { fetch: transport, owner }); runners.push(resumed);
    await expect(resumed.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
    expect(requests).toBe(1);
    setPaused(state, { binding }, false);
    await resumed.syncOnce();
    expect(requests).toBe(2);
    expect(readFileSync(join(files, 'bounded'))).toEqual(payload);
    expect(clientStatus(state).bindings[0]).toMatchObject({ upToDate: true });
  } finally { release.resolve(); await pass.catch(() => {}); }
});

test.each(['pause', 'root-loss'] as const)('bound runner keeps apply recovery after %s following an atomic installation', async interruption => {
  const fs = await import('node:fs');
  const { dirname } = await import('node:path');
  const { startBoundSync, clientStatus, setPaused } = await import('@nanosync/client-service');
  const e = await fixture();
  for (const [state, files] of [[e.firstDir, e.firstFiles], [e.secondDir, e.secondFiles]] as const) {
    const initial = await startBoundSync(state, files); await initial.syncOnce(); await initial.stop();
  }
  writeFileSync(join(e.firstFiles, 'first'), 'first contents', { mode: 0o600 });
  writeFileSync(join(e.firstFiles, 'second'), 'second contents', { mode: 0o600 });
  const publisher = await startBoundSync(e.firstDir, e.firstFiles);
  await publisher.syncOnce(); await publisher.stop();
  const remote = new HttpRemote({ baseUrl: e.url, token: e.b.token, fetch });
  const head = await remote.head(), binding = clientStatus(e.secondDir).bindings[0]!.connectionId;
  const receiver = await startBoundSync(e.secondDir, e.secondFiles); runners.push(receiver);
  const native = fs.linkSync;
  let interrupted = false, installations = 0;
  const install = spyOn(fs, 'linkSync').mockImplementation((source, target) => {
    native(source, target);
    if (fs.realpathSync(dirname(String(target))) !== e.secondFiles) return;
    installations++;
    if (interrupted) return;
    interrupted = true;
    if (interruption === 'pause') setPaused(e.secondDir, { binding }, true);
    else renameSync(e.secondFiles, e.secondFiles + '-saved');
  });
  try {
    await expect(receiver.syncOnce()).rejects.toThrow();
    expect(interrupted).toBe(true); expect(installations).toBe(1);
    expect(clientStatus(e.secondDir).bindings[0]).toMatchObject({
      phase: interruption === 'pause' ? 'paused' : 'folder-unavailable', upToDate: false,
    });
  } finally { install.mockRestore(); await stop(receiver); }
  expect(ClientLocal.readStatus(e.b.clientDirectory, e.b.vaultId, e.b.deviceId)!.pending.applies).toBe(1);
  if (interruption === 'root-loss') {
    try {
      await expect(startBoundSync(e.secondDir, e.secondFiles)).rejects.toMatchObject({ code: 'FOLDER_UNAVAILABLE' });
      expect(existsSync(e.secondFiles)).toBe(false);
      mkdirSync(e.secondFiles, { mode: 0o700 });
      fs.copyFileSync(join(e.secondFiles + '-saved', '.nanosync'), join(e.secondFiles, '.nanosync'));
      await expect(startBoundSync(e.secondDir, e.secondFiles)).rejects.toMatchObject({ code: 'FOLDER_UNAVAILABLE' });
    } finally {
      rmSync(e.secondFiles, { recursive: true, force: true });
      renameSync(e.secondFiles + '-saved', e.secondFiles);
    }
  }
  const resumed = await startBoundSync(e.secondDir, e.secondFiles); runners.push(resumed);
  if (interruption === 'pause') {
    await expect(resumed.syncOnce()).rejects.toMatchObject({ code: 'SYNC_PAUSED' });
    setPaused(e.secondDir, { binding }, false);
  }
  await resumed.syncOnce();
  expect(readFileSync(join(e.secondFiles, 'first'), 'utf8')).toBe('first contents');
  expect(readFileSync(join(e.secondFiles, 'second'), 'utf8')).toBe('second contents');
  expect(ClientLocal.readStatus(e.b.clientDirectory, e.b.vaultId, e.b.deviceId)!.pending.applies).toBe(0);
  expect(await remote.head()).toEqual(head);
  expect(clientStatus(e.secondDir).bindings[0]!.upToDate).toBe(true);
});
