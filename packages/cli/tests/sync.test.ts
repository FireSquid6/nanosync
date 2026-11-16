import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientLocal } from "@nanosync/client-local";
import { applyNewFiles, hydrateFile, LinuxScanner } from "@nanosync/linux-client";
import { SyncEngine, HttpRemote } from "@nanosync/sync-core";
import { CHUNK_SIZE } from "@nanosync/protocol";
import { bootstrapWorkflow, credentials, joinVault } from "../src/client.ts";
import { main } from "../src/main.ts";
import { runServer } from "../src/server.ts";
import { SyncRunner, type SyncOptions } from "../src/sync-runner.ts";

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
  await bootstrapWorkflow(firstDir, server.url, join(serverDir, "bootstrap.hex"), "sync test password", async value => { recovery = value; });
  const secondId = randomUUID();
  expect((await joinVault(secondDir, server.url, secondId, "sync test password")).status).toBe("pending");
  expect(await main(["approve", secondId, "--client-dir", firstDir])).toBe(0);
  expect((await joinVault(secondDir, server.url, secondId, undefined, recovery)).status).toBe("approved");
  const first = credentials(firstDir), second = credentials(secondDir);
  function options(creds: typeof first, clientDirectory: string, syncDirectory: string): SyncOptions {
    return { clientDirectory, syncDirectory, vaultId: creds.vaultId, deviceId: creds.deviceId,
      masterKey: Buffer.from(creds.masterKey, "hex"), baseUrl: creds.baseUrl, token: creds.token,
      pollMs: 10_000, scan: { debounceMs: 100, stabilityMs: 100 } };
  }
  return { firstDir, secondDir, firstFiles, secondFiles, first, second,
    a: options(first, firstDir, firstFiles), b: options(second, secondDir, secondFiles), url: server.url };
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
async function waitFor(check: () => boolean, timeoutMs = 8_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() >= until) throw new Error("timed out waiting for synchronization");
    await Bun.sleep(50);
  }
}

test("one-shot CLI sync converges enrolled devices, keeps rename identity, and rejects overlap", async () => {
  const e = await fixture();
  expect(await main(["sync"])).toBe(2);
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstDir])).toBe(2);
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(0);
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
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
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(0);
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
  const after = await remote.head();
  expect((await remote.manifest(after.revisionId!, e.a.masterKey)).manifest.entries.find(entry => entry.name === "renamed")?.id).toBe(id);
  expect(readFileSync(join(e.secondFiles, "renamed"), "utf8")).toBe("before");
});

test("first snapshot sync imports an existing local file without deleting it", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "existing"), "kept", { mode: 0o600 });
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(0);
  expect(readFileSync(join(e.firstFiles, "existing"), "utf8")).toBe("kept");
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
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
  const local = new ClientLocal(e.firstDir, e.a.vaultId, e.a.deviceId);
  try { expect(local.pendingApplies()).toEqual([]); } finally { local.close(); }
});

test("fresh client merges pre-existing local files with remote history", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "remote"), "uploaded", { mode: 0o600 });
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(0);
  writeFileSync(join(e.secondFiles, "local"), "must stay", { mode: 0o600 });
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "local"), "utf8")).toBe("must stay");
  expect(readFileSync(join(e.secondFiles, "remote"), "utf8")).toBe("uploaded");
  const local = new ClientLocal(e.secondDir, e.b.vaultId, e.b.deviceId);
  try { expect(local.head("applied").revisionId).not.toBeNull(); }
  finally { local.close(); }
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
  const values = (dir: string) => readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).sort();
  expect(values(e.firstFiles)).toEqual(["offline", "online"]);
  expect(values(e.secondFiles)).toEqual(values(e.firstFiles));
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
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "new"), "utf8")).toBe("published");
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
  const values = (dir: string) => readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8"));
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
  expect(await main(["sync", "--client-dir", e.secondDir, "--sync-dir", e.secondFiles])).toBe(0);
  expect(readFileSync(join(e.secondFiles, "large"))).toEqual(data);
});

test("foreground continuous sync debounces changes and shuts down without retaining the owner lock", async () => {
  const e = await fixture();
  const runner = start({ ...e.a, pollMs: 10_000 });
  const controller = new AbortController();
  const heads: { revisionId: string; sequence: number }[] = [];
  const errors: unknown[] = [];
  const watching = runner.watch(controller.signal, head => heads.push(head), error => errors.push(error));
  try {
    await waitFor(() => heads.length > 0);
    const initial = heads[0]!.sequence;
    writeFileSync(join(e.firstFiles, "activity"), "one", { mode: 0o600 });
    writeFileSync(join(e.firstFiles, "activity"), "two");
    await waitFor(() => heads.some(head => head.sequence > initial));
    expect(heads.at(-1)!.sequence).toBe(initial + 1);
    await Bun.sleep(1_100);
    expect(heads.at(-1)!.sequence).toBe(initial + 1);
    expect(errors).toEqual([]);
  } finally { controller.abort(); await watching; await stop(runner); }
  expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(0);
});

test("continuous sync reloads ignore rules and prunes new unsafe directories", async () => {
  const e = await fixture();
  const runner = start({ ...e.a, pollMs: 10_000 });
  const controller = new AbortController();
  const heads: number[] = [], errors: unknown[] = [];
  const watching = runner.watch(controller.signal, head => heads.push(head.sequence), error => errors.push(error));
  try {
    await waitFor(() => heads.length > 0);
    writeFileSync(join(e.firstFiles, ".nanosyncignore"), ".venv/\n", { mode: 0o600 });
    mkdirSync(join(e.firstFiles, ".venv"));
    symlinkSync("missing", join(e.firstFiles, ".venv", "link"));
    writeFileSync(join(e.firstFiles, "included"), "yes");
    await waitFor(() => heads.some(sequence => sequence > 1));
    expect(errors).toEqual([]);
    const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
    const head = await remote.head();
    expect((await remote.manifest(head.revisionId!, e.a.masterKey)).manifest.entries.map(entry => entry.name))
      .toEqual(expect.arrayContaining(["included"]));
    expect((await remote.manifest(head.revisionId!, e.a.masterKey)).manifest.entries.some(entry => entry.name === ".venv")).toBe(false);
  } finally { controller.abort(); await watching; await stop(runner); }
});

test("continuous CLI command runs in the foreground and releases the lock on SIGTERM", async () => {
  const e = await fixture();
  const lock = join(e.firstDir, ".sync-owner");
  const running = main(["sync", "--continuous", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles]);
  try {
    await waitFor(() => existsSync(lock));
    expect(await main(["sync", "--client-dir", e.firstDir, "--sync-dir", e.firstFiles])).toBe(2);
  } finally {
    process.emit("SIGTERM");
    expect(await running).toBe(0);
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
  const controller = new AbortController();
  const errors: unknown[] = [];
  const heads: string[] = [];
  const watching = runner.watch(controller.signal, head => heads.push(head.revisionId), error => errors.push(error));
  try {
    await waitFor(() => errors.length > 0);
    expect(errors[0]).toBeInstanceOf(TypeError);
    offline = false;
    await waitFor(() => heads.length > 0);
    expect(heads[0]).toBeTruthy();
  } finally { controller.abort(); await watching; await stop(runner); }
});

test("portable sync adapters import local files from genesis and converge without CLI lifecycle", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "existing"), "portable import", { mode: 0o600 });
  writeFileSync(join(e.firstFiles, ".nanosyncignore"), "private\n", { mode: 0o600 });
  writeFileSync(join(e.firstFiles, "private"), "not published", { mode: 0o600 });
  const imported = await syncPortable(e.a);
  expect(imported.sequence).toBe(2);
  expect(await syncPortable(e.b)).toEqual(imported);
  expect(readFileSync(join(e.secondFiles, "existing"), "utf8")).toBe("portable import");
  expect(existsSync(join(e.secondFiles, "private"))).toBe(false);
});

async function syncPortable(options: SyncOptions, prepare?: (local: ClientLocal) => void) {
  const local = new ClientLocal(options.clientDirectory, options.vaultId, options.deviceId);
  try {
    prepare?.(local);
    const scanner = new LinuxScanner(options.syncDirectory, local, options.scan);
    const remote = new HttpRemote({ ...options, fetch: options.fetch ?? fetch, journal: local });
    const engine = new SyncEngine({ vaultId: options.vaultId, deviceId: options.deviceId, masterKey: options.masterKey,
      local, scanner, remote, randomUUID, now: () => new Date().toISOString(),
      apply: (manifest, sequence, key) => applyNewFiles(scanner.root, local, remote, manifest, sequence, key),
      hydrate: (manifest, revision, key, intent, path) => hydrateFile(scanner.root, local, remote, manifest, revision, key, intent.direction, path, intent),
    });
    const head = await engine.syncOnce();
    expect(local.head("applied")).toEqual(head);
    expect(local.pendingApplies()).toEqual([]);
    expect(local.proposal()).toBeNull();
    return head;
  } finally { local.close(); }
}

test("portable adapters recover a persisted interrupted apply before scanning", async () => {
  const e = await fixture();
  writeFileSync(join(e.firstFiles, "remote"), "durable remote bytes", { mode: 0o600 });
  const published = await syncPortable(e.a);
  await expect(syncPortable(e.b, local => {
    // Crash after filesystem mutation but before durable applied-head completion.
    local.finishApply = () => { throw new Error("interrupted apply completion"); };
  })).rejects.toThrow("interrupted apply completion");
  const local = new ClientLocal(e.secondDir, e.b.vaultId, e.b.deviceId);
  try {
    expect(local.pendingApplies()).toHaveLength(1);
    expect(local.head("accepted")).toEqual(published);
    expect(local.head("applied").revisionId).toBeNull();
  } finally { local.close(); }
  expect(await syncPortable(e.b)).toEqual(published);
  expect(readFileSync(join(e.secondFiles, "remote"), "utf8")).toBe("durable remote bytes");
});
test("portable adapters replay exact frozen publication bytes after a lost accepted response", async () => {
  const e = await fixture();
  await syncPortable(e.a);
  writeFileSync(join(e.firstFiles, "published"), "frozen bytes", { mode: 0o600 });
  const requests: string[] = [];
  const transport: NonNullable<SyncOptions["fetch"]> = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname !== "/v1/head/advance") return fetch(request);
    requests.push(await request.clone().text());
    const response = await fetch(request);
    if (requests.length === 1) {
      await response.arrayBuffer();
      throw new Error("lost accepted response");
    }
    return response;
  };
  await expect(syncPortable({ ...e.a, fetch: transport })).rejects.toThrow("lost accepted response");
  const recovered = await syncPortable({ ...e.a, fetch: transport });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(await syncPortable(e.b)).toEqual(recovered);
  expect(readFileSync(join(e.secondFiles, "published"), "utf8")).toBe("frozen bytes");
});
