import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { startDaemon, daemonCommand, type LinuxDaemon, type DaemonOptions } from "@nanosync/linux-daemon";
import { HttpRemote } from "@nanosync/sync-core";
import { CHUNK_SIZE } from "@nanosync/protocol";
import { ClientLocal } from "../../client-local/src/index.ts";
import { bootstrapWorkflow, joinVault, credentials, api } from "../src/client.ts";
import { runServer } from "../src/server.ts";
import { main } from "../src/main.ts";

const dirs: string[] = [], daemons: LinuxDaemon[] = [], servers: { stop(): Promise<void> }[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.stop();
  for (const server of servers.splice(0)) await server.stop();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function temp() { const dir = mkdtempSync(join(tmpdir(), "nanosync-acceptance-")); dirs.push(dir); return dir; }
async function freePort(): Promise<number> {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("no ephemeral port");
  await new Promise<void>(resolve => listener.close(() => resolve()));
  return address.port;
}
async function fixture() {
  const serverDir = temp(), firstDir = temp(), secondDir = temp(), firstFiles = temp(), secondFiles = temp();
  writeFileSync(join(serverDir, "pepper.hex"), "a".repeat(64), { mode: 0o600 });
  const port = await freePort();
  let server = await runServer({ directory: serverDir, port, scanIntervalMs: 3_600_000 }); servers.push(server);
  const url = server.url, password = "acceptance password";
  let recovery = "";
  const initial = await bootstrapWorkflow(firstDir, url, join(serverDir, "bootstrap.hex"), password, async value => { recovery = value; });
  expect(recovery).toMatch(/^[a-z2-7-]+$/);
  const secondId = randomUUID();
  expect((await joinVault(secondDir, url, secondId, password)).status).toBe("pending");
  expect(await main(["approve", secondId, "--client-dir", firstDir])).toBe(0);
  expect((await joinVault(secondDir, url, secondId, undefined, recovery)).status).toBe("approved");
  const a = credentials(firstDir), b = credentials(secondDir);
  expect(a.vaultId).toBe(initial.vaultId);
  expect(b.masterKey).toBe(a.masterKey);
  const options = (creds: typeof a, clientDirectory: string, syncDirectory: string): DaemonOptions => ({
    clientDirectory, syncDirectory, vaultId: creds.vaultId, deviceId: creds.deviceId,
    masterKey: Buffer.from(creds.masterKey, "hex"), baseUrl: creds.baseUrl, token: creds.token,
    pollMs: 3_600_000, scan: { debounceMs: 0, stabilityMs: 0 }
  });
  const first = options(a, firstDir, firstFiles), second = options(b, secondDir, secondFiles);
  const start = async (opts: DaemonOptions) => { const daemon = await startDaemon(opts); daemons.push(daemon); return daemon; };
  const stop = async (daemon: LinuxDaemon) => { await daemon.stop(); daemons.splice(daemons.indexOf(daemon), 1); };
  const restartServer = async () => {
    await server.stop(); servers.splice(servers.indexOf(server), 1);
    server = await runServer({ directory: serverDir, port, scanIntervalMs: 3_600_000 }); servers.push(server);
    expect(server.url).toBe(url);
  };
  return { serverDir, firstDir, secondDir, firstFiles, secondFiles, first, second, a, b, start, stop, restartServer, url, secondId };
}
const sync = (dir: string) => daemonCommand(dir, "sync");
const status = (dir: string) => daemonCommand(dir, "status");
const contents = (dir: string) => readdirSync(dir).map(name => readFileSync(join(dir, name), "utf8")).sort();
function plaintextTree(dir: string): Record<string, string> {
  const result: Record<string, string> = {};
  function visit(path: string, prefix: string) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const name = prefix + entry.name;
      if (entry.isDirectory()) { result[name + "/"] = "directory"; visit(join(path, entry.name), name + "/"); }
      else result[name] = readFileSync(join(path, entry.name), "utf8");
    }
  }
  visit(dir, "");
  return result;
}

test("whole-revision CLI restore converges two plaintext trees without rewinding history", async () => {
  const e = await fixture();
  await e.start(e.first); await e.start(e.second);
  await sync(e.firstDir); await sync(e.secondDir);
  mkdirSync(join(e.firstFiles, "folder"), { mode: 0o700 });
  writeFileSync(join(e.firstFiles, "folder", "old"), "historic", { mode: 0o600 });
  writeFileSync(join(e.firstFiles, "keep"), "before", { mode: 0o600 });
  await sync(e.firstDir); await sync(e.secondDir);
  const target = (await status(e.firstDir)).applied;
  const expected = { "folder/": "directory", "folder/old": "historic", keep: "before" };
  expect(plaintextTree(e.firstFiles)).toEqual(expected);
  renameSync(join(e.firstFiles, "folder", "old"), join(e.firstFiles, "folder", "renamed"));
  writeFileSync(join(e.firstFiles, "keep"), "changed");
  writeFileSync(join(e.firstFiles, "added"), "later", { mode: 0o600 });
  await sync(e.firstDir); await sync(e.secondDir);
  unlinkSync(join(e.firstFiles, "folder", "renamed"));
  await sync(e.firstDir); await sync(e.secondDir);
  const before = (await status(e.firstDir)).applied;
  expect(plaintextTree(e.secondFiles)).not.toEqual(expected);
  expect(await main(["restore", target.revisionId, "--client-dir", e.firstDir])).toBe(0);
  const restored = (await status(e.firstDir)).applied;
  expect(restored.sequence).toBe(before.sequence + 1);
  expect(plaintextTree(e.firstFiles)).toEqual(expected);
  await sync(e.secondDir);
  expect(plaintextTree(e.secondFiles)).toEqual(expected);
  expect((await status(e.secondDir)).applied).toEqual(restored);
  await sync(e.firstDir); await sync(e.secondDir);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(restored.sequence);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const manifest = (await remote.manifest(restored.revisionId, Buffer.from(e.a.masterKey, "hex"))).manifest;
  expect(manifest.parents).toEqual([before.revisionId]);
  expect(manifest.entries.filter(entry => entry.kind === "file").map(entry => entry.name).sort()).toEqual(["keep", "old"]);
  expect((await daemonCommand(e.secondDir, "history")).some((entry: any) => entry.revisionId === before.revisionId)).toBe(true);
  expect((await remote.manifest(target.revisionId, Buffer.from(e.a.masterKey, "hex"))).sequence).toBe(target.sequence);
});

test("whole-revision restore retries the frozen CAS after its accepted response is lost", async () => {
  const e = await fixture();
  const first = await e.start(e.first); await sync(e.firstDir);
  writeFileSync(join(e.firstFiles, "file"), "before", { mode: 0o600 }); await sync(e.firstDir);
  const target = (await status(e.firstDir)).applied;
  writeFileSync(join(e.firstFiles, "file"), "after"); await sync(e.firstDir);
  const before = (await status(e.firstDir)).applied;
  await e.stop(first);
  const requests: string[] = [];
  let lost = false;
  const intercepted = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance") {
      requests.push(await request.clone().text());
      const response = await fetch(request);
      if (!lost) { lost = true; await response.arrayBuffer(); throw new Error("lost restore response"); }
      return response;
    }
    return fetch(request);
  } });
  await expect(daemonCommand(e.firstDir, "restore", { revision: target.revisionId })).rejects.toThrow(/lost restore response/);
  expect(intercepted.status().pendingProposal).toBe(true);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(before.sequence + 1);
  await e.stop(intercepted); await e.restartServer();
  const recovered = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance") requests.push(await request.clone().text());
    return fetch(request);
  } });
  await sync(e.firstDir);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(recovered.status().pendingProposal).toBe(false);
  expect(recovered.status().applied.sequence).toBe(before.sequence + 1);
  expect(readFileSync(join(e.firstFiles, "file"), "utf8")).toBe("before");
  await e.start(e.second); await sync(e.secondDir);
  expect(readFileSync(join(e.secondFiles, "file"), "utf8")).toBe("before");
  await sync(e.firstDir);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(before.sequence + 1);
});

test("real enrolled devices: encrypted convergence, stale multi-hop conflicts, rename identity, CLI and revocation", async () => {
  const e = await fixture();
  await e.start(e.first); await e.start(e.second);
  await sync(e.firstDir); await sync(e.secondDir);
  writeFileSync(join(e.firstFiles, "note"), "base", { mode: 0o600 }); await sync(e.firstDir); await sync(e.secondDir);
  const before = (await new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch }).manifest((await status(e.firstDir)).applied.revisionId, Buffer.from(e.a.masterKey, "hex"))).manifest;
  const id = before.entries.find(entry => entry.name === "note")?.id;
  expect(id).toBeDefined();
  renameSync(join(e.firstFiles, "note"), join(e.firstFiles, "renamed")); await sync(e.firstDir); await sync(e.secondDir);
  const renamed = (await new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch }).manifest((await status(e.firstDir)).applied.revisionId, Buffer.from(e.a.masterKey, "hex"))).manifest;
  expect(renamed.entries.find(entry => entry.name === "renamed")?.id).toBe(id);
  expect(readFileSync(join(e.secondFiles, "renamed"), "utf8")).toBe("base");
  writeFileSync(join(e.secondFiles, "renamed"), "offline");
  writeFileSync(join(e.firstFiles, "renamed"), "online"); await sync(e.firstDir);
  writeFileSync(join(e.firstFiles, "other"), "multi-hop", { mode: 0o600 }); await sync(e.firstDir);
  await sync(e.secondDir); await sync(e.firstDir);
  expect(contents(e.firstFiles)).toEqual(["multi-hop", "offline", "online"]);
  expect(contents(e.secondFiles)).toEqual(contents(e.firstFiles));
  expect((await status(e.firstDir)).applied).toEqual((await status(e.secondDir)).applied);
  expect(await daemonCommand(e.secondDir, "conflicts")).toBeInstanceOf(Array);
  expect((await daemonCommand(e.firstDir, "history")).length).toBeGreaterThan(3);
  expect(await main(["status", "--client-dir", e.firstDir, "--json"])).toBe(0);
  expect(await main(["history", "--client-dir", e.firstDir])).toBe(0);
  expect(await main(["conflicts", "--client-dir", e.secondDir])).toBe(0);
  const prior = (await daemonCommand(e.firstDir, "history")).find((item: any) => item.revisionId === before.revisionId);
  expect(prior).toBeDefined();
  expect(await main(["restore", before.revisionId, "renamed", "--client-dir", e.firstDir])).toBe(2); // name did not exist at this revision
  expect(await main(["restore", before.revisionId, "note", "--client-dir", e.firstDir])).toBe(0);
  expect(readFileSync(join(e.firstFiles, "note"), "utf8")).toBe("base");
  const restored = (await status(e.firstDir)).applied;
  await sync(e.secondDir);
  expect((await status(e.secondDir)).applied).toEqual(restored);
  expect(contents(e.secondFiles)).toEqual(["base", "multi-hop", "offline", "online"]);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(restored.sequence);
  expect(await main(["evict", "other", "--client-dir", e.firstDir])).toBe(0);
  expect(existsSync(join(e.firstFiles, "other"))).toBe(false);
  expect(await main(["download", "other", "--client-dir", e.firstDir])).toBe(0);
  expect(readFileSync(join(e.firstFiles, "other"), "utf8")).toBe("multi-hop");
  await e.restartServer();
  expect((await sync(e.firstDir)).headsConverged).toBe(true);
  expect(await main(["devices", "--client-dir", e.firstDir])).toBe(0);
  expect(await main(["revoke", e.secondId, "--client-dir", e.firstDir])).toBe(0);
  await expect(api(e.url, "/v1/head", {}, e.b.token)).rejects.toThrow(/401/);
  await expect(sync(e.secondDir)).rejects.toThrow(/Authorization is required|401|unauthorized/i);
  expect(contents(e.firstFiles)).toEqual(["base", "multi-hop", "offline", "online"]);
  const serverBytes = readdirSync(join(e.serverDir, "objects"), { recursive: true }).filter(name => typeof name === "string") as string[];
  const frames = serverBytes.filter(name => { try { return readFileSync(join(e.serverDir, "objects", name)).length > 0; } catch { return false; } });
  expect(frames.length).toBeGreaterThan(0);
  for (const name of frames) {
    const raw = readFileSync(join(e.serverDir, "objects", name));
    expect(raw.includes(Buffer.from("multi-hop"))).toBe(false);
    expect(raw.includes(Buffer.from("offline"))).toBe(false);
    expect(raw.includes(Buffer.from(e.a.masterKey))).toBe(false);
    expect(raw.includes(Buffer.from("acceptance password"))).toBe(false);
  }
  const metadata = readFileSync(join(e.serverDir, "metadata.sqlite"));
  expect(metadata.includes(Buffer.from(e.a.masterKey))).toBe(false);
  expect(metadata.includes(Buffer.from("acceptance password"))).toBe(false);
});

test("explicit CLI conflict resolution publishes a tombstone and converges durable records", async () => {
  const e = await fixture();
  const first = await e.start(e.first), second = await e.start(e.second);
  await sync(e.firstDir); await sync(e.secondDir);
  writeFileSync(join(e.firstFiles, "shared"), "base", { mode: 0o600 });
  await sync(e.firstDir); await sync(e.secondDir);
  writeFileSync(join(e.secondFiles, "shared"), "offline");
  writeFileSync(join(e.firstFiles, "shared"), "online"); await sync(e.firstDir);
  await sync(e.secondDir); await sync(e.firstDir);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const key = Buffer.from(e.a.masterKey, "hex");
  const before = (await status(e.firstDir)).applied;
  const merged = (await remote.manifest(before.revisionId, key)).manifest;
  const copy = merged.entries.find(entry => entry.conflict && entry.kind === "file")!;
  expect(copy).toBeDefined();
  const path = copy.name;
  const discarded = readFileSync(join(e.firstFiles, path), "utf8");
  const surviving = readFileSync(join(e.firstFiles, "shared"), "utf8");
  expect(new Set([discarded, surviving])).toEqual(new Set(["offline", "online"]));
  expect((await daemonCommand(e.firstDir, "conflicts")).some((item: any) => item.entry_id === copy.id)).toBe(true);
  expect((await daemonCommand(e.secondDir, "conflicts")).some((item: any) => item.entry_id === copy.id)).toBe(true);
  expect(await main(["resolve", path, "--client-dir", e.firstDir])).toBe(2);
  expect(await main(["resolve", "shared", "--confirm-discard", "--client-dir", e.firstDir])).toBe(2);
  expect((await status(e.firstDir)).applied).toEqual(before);
  expect(await main(["resolve", path, "--confirm-discard", "--client-dir", e.firstDir])).toBe(0);
  const after = (await status(e.firstDir)).applied;
  expect(after.sequence).toBe(before.sequence + 1);
  expect(plaintextTree(e.firstFiles)).toEqual({ shared: surviving });
  const resolved = (await remote.manifest(after.revisionId, key)).manifest;
  expect(resolved.parents).toEqual([before.revisionId]);
  expect(resolved.entries.find(entry => entry.id === copy.id)?.kind).toBe("tombstone");
  expect((await remote.manifest(before.revisionId, key)).manifest.entries.find(entry => entry.id === copy.id)?.sha256).toBe(copy.sha256);
  await sync(e.secondDir);
  expect(plaintextTree(e.secondFiles)).toEqual({ shared: surviving });
  expect(await daemonCommand(e.firstDir, "conflicts")).toEqual([]);
  expect(await daemonCommand(e.secondDir, "conflicts")).toEqual([]);
  await e.stop(first); await e.stop(second); await e.restartServer();
  await e.start(e.first); await e.start(e.second);
  await sync(e.firstDir); await sync(e.secondDir);
  expect(await daemonCommand(e.firstDir, "conflicts")).toEqual([]);
  expect(await daemonCommand(e.secondDir, "conflicts")).toEqual([]);
  const local = new ClientLocal(e.firstDir, e.a.vaultId, e.a.deviceId);
  try { expect(local.listWork("conflicts").find(item => item.id === copy.id)?.state).toBe("resolved"); }
  finally { local.close(); }
  expect(discarded).not.toBe(surviving);
});

test("single-file restore keeps conflict lineage on both devices", async () => {
  const e = await fixture();
  await e.start(e.first); await e.start(e.second);
  await sync(e.firstDir); await sync(e.secondDir);
  writeFileSync(join(e.firstFiles, "shared"), "base", { mode: 0o600 });
  await sync(e.firstDir); await sync(e.secondDir);
  writeFileSync(join(e.secondFiles, "shared"), "offline");
  writeFileSync(join(e.firstFiles, "shared"), "online"); await sync(e.firstDir);
  await sync(e.secondDir); await sync(e.firstDir);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const key = Buffer.from(e.a.masterKey, "hex");
  const historical = (await status(e.firstDir)).applied;
  const copy = (await remote.manifest(historical.revisionId, key)).manifest.entries.find(entry => entry.kind === "file" && entry.conflict)!;
  expect(copy).toBeDefined();
  writeFileSync(join(e.firstFiles, copy.name), "changed conflict copy");
  await sync(e.firstDir); await sync(e.secondDir);
  await daemonCommand(e.firstDir, "restore", { revision: historical.revisionId, path: copy.name });
  const restored = (await status(e.firstDir)).applied;
  const entry = (await remote.manifest(restored.revisionId, key)).manifest.entries.find(item => item.id === copy.id)!;
  expect(entry.conflict).toEqual(copy.conflict);
  expect(entry.sha256).toBe(copy.sha256);
  await sync(e.secondDir);
  expect(readFileSync(join(e.secondFiles, copy.name), "utf8")).toBe(readFileSync(join(e.firstFiles, copy.name), "utf8"));
  expect((await status(e.secondDir)).applied).toEqual(restored);
  expect((await daemonCommand(e.secondDir, "conflicts")).some((item: any) => item.entry_id === copy.id)).toBe(true);
});

test("replayed signed older head with forged higher server sequence cannot replace plaintext", async () => {
  const e = await fixture();
  const first = await e.start(e.first); await sync(e.firstDir);
  writeFileSync(join(e.firstFiles, "record"), "old", { mode: 0o600 }); await sync(e.firstDir);
  const old = (await status(e.firstDir)).applied;
  writeFileSync(join(e.firstFiles, "record"), "new"); await sync(e.firstDir);
  const applied = (await status(e.firstDir)).applied;
  await e.stop(first);
  let replay = false;
  const intercepted = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const path = new URL(request.url).pathname;
    if (replay && path === "/v1/head") return Response.json({ protocolVersion: 1, status: "head",
      revisionId: old.revisionId, sequence: applied.sequence + 10 });
    if (replay && path === `/v1/revisions/${old.revisionId}`) {
      const body = await (await fetch(request)).json() as Record<string, unknown>;
      return Response.json({ ...body, sequence: applied.sequence + 10 });
    }
    return fetch(request);
  } });
  await sync(e.firstDir);
  const before = intercepted.status();
  replay = true;
  await expect(sync(e.firstDir)).rejects.toThrow(/authenticated path|ancestry|sequence/);
  expect(intercepted.status().applied).toEqual(before.applied);
  expect(intercepted.status().accepted).toEqual(before.accepted);
  expect(readFileSync(join(e.firstFiles, "record"), "utf8")).toBe("new");
  expect((await api(e.url, "/v1/head", {}, e.a.token)).revisionId).toBe(applied.revisionId);
});

test("real HTTP delete/edit retains edited bytes on both devices and records the deletion branch", async () => {
  const e = await fixture();
  await e.start(e.first); await e.start(e.second);
  await sync(e.firstDir);
  writeFileSync(join(e.firstFiles, "record"), "original", { mode: 0o600 });
  await sync(e.firstDir); await sync(e.secondDir);
  unlinkSync(join(e.secondFiles, "record"));
  writeFileSync(join(e.firstFiles, "record"), "edited"); await sync(e.firstDir);
  await sync(e.secondDir); await sync(e.firstDir);
  expect(contents(e.firstFiles)).toEqual(["edited"]);
  expect(contents(e.secondFiles)).toEqual(["edited"]);
  expect((await status(e.firstDir)).applied).toEqual((await status(e.secondDir)).applied);
  const history = await daemonCommand(e.secondDir, "history");
  expect(history.some((item: any) => item.sequence === null)).toBe(true);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  const before = (await status(e.firstDir)).applied;
  const old = (await remote.manifest(before.revisionId, Buffer.from(e.a.masterKey, "hex"))).manifest;
  const copy = old.entries.find(entry => entry.conflict && entry.kind === "file")!;
  expect(copy).toBeDefined();
  expect(old.entries.find(entry => entry.id === copy.conflict!.sourceEntryId)?.kind).toBe("tombstone");
  expect(await main(["resolve", copy.name, "--confirm-discard", "--client-dir", e.firstDir])).toBe(0);
  await sync(e.secondDir);
  expect(plaintextTree(e.firstFiles)).toEqual({});
  expect(plaintextTree(e.secondFiles)).toEqual({});
  expect(await daemonCommand(e.firstDir, "conflicts")).toEqual([]);
  expect(await daemonCommand(e.secondDir, "conflicts")).toEqual([]);
  const after = (await status(e.firstDir)).applied;
  expect(after.sequence).toBe(before.sequence + 1);
  expect((await remote.manifest(before.revisionId, Buffer.from(e.a.masterKey, "hex"))).manifest.entries.find(entry => entry.id === copy.id)?.sha256).toBe(copy.sha256);
});

test("accepted CAS response lost on real HTTP replays exactly after daemon and server restart", async () => {
  const e = await fixture();
  const initial = await e.start(e.first); await sync(e.firstDir); await e.stop(initial);
  writeFileSync(join(e.firstFiles, "durable"), "not overwritten", { mode: 0o600 });
  const requests: string[] = [];
  const interrupted = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance") {
      requests.push(await request.clone().text());
      const response = await fetch(request);
      if (requests.length === 1) { await response.arrayBuffer(); throw new Error("lost accepted response"); }
      return response;
    }
    return fetch(request);
  } });
  await expect(sync(e.firstDir)).rejects.toThrow(/lost accepted response/);
  expect((await status(e.firstDir)).pendingProposal).toBe(true);
  await e.stop(interrupted); await e.restartServer();
  const replay = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (new URL(request.url).pathname === "/v1/head/advance") requests.push(await request.clone().text());
    return fetch(request);
  } });
  await sync(e.firstDir);
  expect(requests).toHaveLength(2);
  expect(requests[1]).toBe(requests[0]);
  expect(replay.status().pendingProposal).toBe(false);
  expect(replay.status().applied.sequence).toBe(2);
  const other = await e.start(e.second); await sync(e.secondDir);
  expect(readFileSync(join(e.secondFiles, "durable"), "utf8")).toBe("not overwritten");
  expect(other.status().applied).toEqual(replay.status().applied);
});

test("real HTTP interrupted chunk upload resumes at the next chunk boundary after restart", async () => {
  const e = await fixture();
  const first = await e.start(e.first); await sync(e.firstDir); await e.stop(first);
  const bytes = Buffer.alloc(CHUNK_SIZE + 17, 0x31); bytes.fill(0x32, CHUNK_SIZE);
  writeFileSync(join(e.firstFiles, "large"), bytes, { mode: 0o600 });
  const uploaded: string[] = []; let truncated = false;
  const interrupted = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/")) {
      const id = request.url.split("/").at(-1)!; uploaded.push(id);
      if (uploaded.length === 2 && !truncated) {
        truncated = true;
        const original = new Uint8Array(await request.arrayBuffer());
        const partial = original.subarray(0, Math.floor(original.length / 2));
        const headers = new Headers(request.headers); headers.set("content-length", String(partial.length));
        const response = await fetch(request.url, { method: "PUT", headers, body: partial });
        expect(response.status).toBeGreaterThanOrEqual(400);
        return response;
      }
    }
    return fetch(request);
  } });
  await expect(sync(e.firstDir)).rejects.toThrow();
  expect(truncated).toBe(true);
  expect(uploaded).toHaveLength(2);
  expect(uploaded[0]).not.toBe(uploaded[1]);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(1);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  expect(await remote.presence("chunk", [uploaded[0]!])).toEqual(new Set());
  expect(await remote.presence("chunk", [uploaded[1]!])).toEqual(new Set([uploaded[1]!]));
  await e.stop(interrupted); await e.restartServer();
  const resumed: string[] = [];
  await e.start({ ...e.first, fetch: (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/"))
      resumed.push(request.url.split("/").at(-1)!);
    return fetch(request);
  } });
  await sync(e.firstDir);
  expect(resumed).toEqual([uploaded[1]!]);
  expect((await status(e.firstDir)).applied.sequence).toBe(2);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(2);
  await e.start(e.second); await sync(e.secondDir);
  expect(readFileSync(join(e.secondFiles, "large"))).toEqual(bytes);
});

test("truncated successful upload response resumes from the completed chunk after daemon restart", async () => {
  const e = await fixture();
  const initial = await e.start(e.first); await sync(e.firstDir); await e.stop(initial);
  const bytes = Buffer.alloc(CHUNK_SIZE + 23, 0x41); bytes.fill(0x42, CHUNK_SIZE);
  writeFileSync(join(e.firstFiles, "response"), bytes, { mode: 0o600 });
  let completedId: string | null = null;
  const interrupted = await e.start({ ...e.first, fetch: async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const response = await fetch(request);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/") && !completedId) {
      completedId = request.url.split("/").at(-1)!;
      expect(response.status).toBe(201);
      await response.arrayBuffer(); // The server accepted the complete frame; only its response is lost.
      return new Response('{"protocolVersion":1,"status":', { status: 201, headers: response.headers });
    }
    return response;
  } });
  await expect(sync(e.firstDir)).rejects.toThrow();
  expect(completedId).not.toBeNull();
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(1);
  const remote = new HttpRemote({ baseUrl: e.url, token: e.a.token, fetch });
  expect(await remote.presence("chunk", [completedId!])).toEqual(new Set());
  await e.stop(interrupted); await e.restartServer();
  const retried: string[] = [];
  await e.start({ ...e.first, fetch: (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    if (request.method === "PUT" && new URL(request.url).pathname.startsWith("/v1/objects/chunk/"))
      retried.push(request.url.split("/").at(-1)!);
    return fetch(request);
  } });
  await sync(e.firstDir);
  expect(retried).toHaveLength(1);
  expect(retried[0]).not.toBe(completedId);
  expect((await status(e.firstDir)).applied.sequence).toBe(2);
  await e.start(e.second); await sync(e.secondDir);
  expect(readFileSync(join(e.secondFiles, "response"))).toEqual(bytes);
});

test("accepted real HTTP CAS survives restart before local apply without overwriting plaintext", async () => {
  const e = await fixture();
  const initial = await e.start(e.first); await sync(e.firstDir); await e.stop(initial);
  writeFileSync(join(e.firstFiles, "survivor"), "keep this edit", { mode: 0o600 });
  const original = ClientLocal.prototype.acceptProposal;
  let interrupted = false;
  ClientLocal.prototype.acceptProposal = function (sequence) {
    original.call(this, sequence);
    ClientLocal.prototype.acceptProposal = original;
    interrupted = true;
    throw new Error("process stopped after durable acceptance before local apply");
  };
  let daemon: LinuxDaemon;
  try {
    daemon = await e.start(e.first);
    await expect(sync(e.firstDir)).rejects.toThrow(/before local apply/);
  } finally { ClientLocal.prototype.acceptProposal = original; }
  expect(interrupted).toBe(true);
  expect(daemon!.status().accepted.sequence).toBe(2);
  expect(daemon!.status().applied.sequence).toBe(1);
  expect(readFileSync(join(e.firstFiles, "survivor"), "utf8")).toBe("keep this edit");
  await e.stop(daemon!); await e.restartServer();
  const recovered = await e.start(e.first); await sync(e.firstDir);
  expect(recovered.status().pendingProposal).toBe(false);
  expect(recovered.status().applied.sequence).toBe(2);
  expect((await api(e.url, "/v1/head", {}, e.a.token)).sequence).toBe(2);
  await e.start(e.second); await sync(e.secondDir);
  expect(readFileSync(join(e.firstFiles, "survivor"), "utf8")).toBe("keep this edit");
  expect(readFileSync(join(e.secondFiles, "survivor"), "utf8")).toBe("keep this edit");
  expect((await status(e.secondDir)).applied).toEqual(recovered.status().applied);
});
