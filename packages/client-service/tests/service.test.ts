import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { chmodSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClientService, type ServiceOptions } from "../src/service.ts";
import { CredentialStoreError, type CredentialStore } from "../src/credential-store.ts";
import { privateDirectory, secureCreate } from "../src/security.ts";
import { acquireSyncLock, inspectSyncOwner } from "../src/sync-lock.ts";
import { ownerEndpoint } from "../src/sync-control.ts";
// These are the actual CLI seams, not a second desktop-only registry.
import { createConnection, records, discoverConnection } from "../../cli/src/connections.ts";
import { bootstrapWorkflow, credentials, joinVault } from "../../cli/tests/support/legacy-fixture.ts";
import { main } from "../../cli/src/main.ts";
import { runServer } from "../../cli/src/server.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temp() {
  const root = mkdtempSync(join(tmpdir(), "client-service-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function memoryStore() {
  const values = new Map<string, string>();
  const store: CredentialStore = { get: id => values.get(id) ?? null, set: (id, value) => { values.set(id, value); }, delete: id => { values.delete(id); } };
  return { values, store };
}
function service(root: string, options: ServiceOptions = { owner: "CLI" }) {
  const client = new ClientService(root, options);
  cleanups.push(() => client.stop());
  return client;
}
function register(root = temp(), files = temp(), creds: ReturnType<typeof credentials> = { baseUrl: "http://127.0.0.1:1", deviceId: randomUUID(), vaultId: randomUUID(), token: "private-token", masterKey: "ab".repeat(32) }) {
  const serverId = randomUUID();
  const info = { version: 1, serverId, baseUrl: creds.baseUrl.replace(/\/$/, ""), deviceId: creds.deviceId, name: "Home", token: creds.token };
  secureCreate(join(privateDirectory(join(root, "servers")), `${serverId}.json`), JSON.stringify(info));
  const keyPath = join(privateDirectory(join(root, "keys")), `${serverId}-${creds.vaultId}.json`);
  secureCreate(keyPath, JSON.stringify({ version: 1, serverId, vaultId: creds.vaultId, masterKey: creds.masterKey }));
  const binding = createConnection(root, files, serverId, creds.vaultId, creds.deviceId);
  return { root, files, binding, info, creds, keyPath, replica: join(root, "replicas", binding.connectionId) };
}
async function freePort() {
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const address = listener.address();
  if (!address || typeof address === "string") throw new Error("Missing port");
  await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function realServer() {
  const directory = temp(), root = temp();
  writeFileSync(join(directory, "pepper.hex"), "a".repeat(64), { mode: 0o600 });
  const server = await runServer({ directory, port: await freePort(), scanIntervalMs: 3_600_000 });
  cleanups.push(() => server.stop());
  let recovery = "";
  await bootstrapWorkflow(root, server.url, join(directory, "bootstrap.hex"), "service test password", async value => { recovery = value; });
  return { directory, server, root, recovery, first: register(root, temp(), credentials(root)) };
}

test("CLI registry and desktop read model share bindings; listing never transfers or exposes secrets", async () => {
  const f = register();
  const original = readFileSync(join(f.root, "servers", `${f.info.serverId}.json`), "utf8");
  let transfers = 0, storeReads = 0;
  const desktop = service(f.root, { owner: "Desktop", credentialStore: { get() { storeReads++; throw new CredentialStoreError(); }, set() { throw new Error("implicit migration"); }, delete() { throw new Error("implicit deletion"); } }, runnerOptions: { fetch: async () => { transfers++; throw new Error("implicit transfer"); } } });
  const snapshot = await desktop.snapshot();
  expect(snapshot.servers).toEqual([{ id: f.info.serverId, name: "Home", url: f.info.baseUrl, credentialMode: "protected-file" }]);
  expect(snapshot.folders).toHaveLength(1);
  expect(snapshot.folders[0]).toMatchObject({ id: f.binding.connectionId, path: f.files, vaultId: f.creds.vaultId, status: "Credentials required", owner: null });
  expect(records(f.root)).toEqual([f.binding]);
  expect(discoverConnection(f.root, f.files)).toEqual(f.binding);
  const serialized = JSON.stringify(snapshot);
  for (const secret of [f.creds.token, f.creds.masterKey, '"token"', '"masterKey"', '"capability"']) expect(serialized).not.toContain(secret);
  await expect(desktop.sync(f.binding.connectionId)).rejects.toMatchObject({ code: "CREDENTIALS_REQUIRED" });
  expect(readFileSync(join(f.root, "servers", `${f.info.serverId}.json`), "utf8")).toBe(original);
  expect(existsSync(f.keyPath)).toBe(true);
  expect(existsSync(f.replica)).toBe(false);
  expect(transfers).toBe(0);
  expect(storeReads).toBe(0);
});

test("a missing root remains in the registry and is never scanned as remote deletions", async () => {
  const f = register();
  writeFileSync(join(f.files, "keep.txt"), "preserve me");
  const moved = `${f.files}-unavailable`;
  renameSync(f.files, moved);
  cleanups.push(() => rmSync(moved, { recursive: true, force: true }));
  let requests = 0;
  const cli = service(f.root, { owner: "CLI", runnerOptions: { fetch: async () => { requests++; throw new Error("must not transfer"); } } });
  expect((await cli.snapshot()).folders[0]).toMatchObject({ id: f.binding.connectionId, path: f.files, status: "Folder unavailable" });
  await expect(cli.sync(f.binding.connectionId)).rejects.toThrow("missing");
  expect(records(f.root)).toEqual([f.binding]);
  expect(readFileSync(join(moved, "keep.txt"), "utf8")).toBe("preserve me");
  expect(requests).toBe(0);
});

test("locked OS credentials give an actionable error with no plaintext or network fallback", async () => {
  const f = register(), { store } = memoryStore();
  const migrator = service(f.root, { owner: "Desktop", credentialStore: store });
  await migrator.migrate(f.info.serverId);
  let requests = 0;
  const locked: CredentialStore = { get() { throw new CredentialStoreError(); }, set() { throw new CredentialStoreError(); }, delete() { throw new CredentialStoreError(); } };
  const desktop = service(f.root, { owner: "Desktop", credentialStore: locked, runnerOptions: { fetch: async () => { requests++; throw new Error("fallback"); } } });
  expect((await desktop.snapshot()).servers[0]?.credentialMode).toBe("os");
  await expect(desktop.sync(f.binding.connectionId)).rejects.toMatchObject({ code: "CREDENTIAL_STORE_LOCKED", message: expect.stringContaining("unlock the login keyring") });
  expect(requests).toBe(0);
  expect(existsSync(f.keyPath)).toBe(false);
  expect(readFileSync(join(f.root, "servers", `${f.info.serverId}.json`), "utf8")).not.toContain(f.creds.token);
  expect(ownerEndpoint(f.replica)).toBeNull();
});

test("explicit OS migration enables a real encrypted roundtrip through ClientService", async () => {
  const e = await realServer(), secondRoot = temp(), secondId = randomUUID();
  expect((await joinVault(secondRoot, e.server.url, secondId, "service test password")).status).toBe("pending");
  expect(await main(["server", "devices", "approve", "--device-id", secondId, "--server-dir", e.directory])).toBe(0);
  expect((await joinVault(secondRoot, e.server.url, secondId, undefined, e.recovery)).status).toBe("approved");
  const second = register(secondRoot, temp(), credentials(secondRoot)), { store } = memoryStore();
  let requests = 0;
  const desktop = service(e.first.root, { owner: "Desktop", credentialStore: store, runnerOptions: { fetch: async (input, init) => { requests++; return fetch(input, init); } } });
  const cli = service(second.root);
  expect((await desktop.snapshot()).folders[0]?.status).toBe("Credentials required");
  await expect(desktop.sync(e.first.binding.connectionId)).rejects.toMatchObject({ code: "CREDENTIALS_REQUIRED" });
  expect(requests).toBe(0);
  await desktop.migrate(e.first.info.serverId);
  expect(existsSync(e.first.keyPath)).toBe(false);
  expect((await desktop.snapshot()).servers[0]?.credentialMode).toBe("os");
  writeFileSync(join(e.first.files, "from-desktop.txt"), "real encrypted upload", { mode: 0o600 });
  const uploaded = await desktop.sync(e.first.binding.connectionId);
  expect(uploaded.sequence).toBeGreaterThan(1);
  expect(await cli.sync(second.binding.connectionId)).toEqual(uploaded);
  expect(readFileSync(join(second.files, "from-desktop.txt"), "utf8")).toBe("real encrypted upload");
  writeFileSync(join(second.files, "from-cli.txt"), "real encrypted download", { mode: 0o600 });
  const returned = await cli.sync(second.binding.connectionId);
  expect(await desktop.sync(e.first.binding.connectionId)).toEqual(returned);
  expect(readFileSync(join(e.first.files, "from-cli.txt"), "utf8")).toBe("real encrypted download");
  const snapshot = await desktop.snapshot();
  expect(snapshot.folders[0]).toMatchObject({ status: "Up to date", owner: "Desktop", sequence: returned.sequence, conflicts: 0, error: null });
  expect(Number.isFinite(Date.parse(snapshot.folders[0]!.lastSync!))).toBe(true);
  for (const secret of [e.first.creds.token, e.first.creds.masterKey, ownerEndpoint(e.first.replica)!.capability]) expect(JSON.stringify(snapshot)).not.toContain(secret);
  const beforeListing = requests;
  await desktop.snapshot();
  expect(requests).toBe(beforeListing);
  await desktop.stop();
  expect((await service(e.first.root, { owner: "Desktop", credentialStore: store }).snapshot()).folders[0]).toMatchObject({ sequence: returned.sequence, lastSync: snapshot.folders[0]!.lastSync });
}, 20_000);

test("a live legacy CLI lock fails closed without starting a competing runner", async () => {
  const f = register(), replica = privateDirectory(join(privateDirectory(join(f.root, "replicas")), f.binding.connectionId)), release = acquireSyncLock(replica);
  const before = readFileSync(join(replica, ".sync-owner"), "utf8");
  release();
  // A pre-control CLI has the live PID record but does not hold the new kernel gate.
  secureCreate(join(replica, ".sync-owner"), before);
  let requests = 0;
  const cli = service(f.root, { owner: "CLI", runnerOptions: { fetch: async () => { requests++; throw new Error("competing runner"); } } });
  expect((await cli.snapshot()).folders[0]?.error).toContain("older sync process");
  await expect(cli.sync(f.binding.connectionId)).rejects.toThrow("another live process");
  expect(requests).toBe(0);
  expect(readFileSync(join(replica, ".sync-owner"), "utf8")).toBe(before);
  expect(existsSync(join(replica, "local.sqlite"))).toBe(false);
  expect(existsSync(join(replica, "sync-control.json"))).toBe(false);
});

// Inline worker keeps the cross-process fixture inside this test's owned files.
// Only the worker observes Bun.serve; the parent and other tests keep their globals.
const ownerWorker = `
import { ClientService } from ${JSON.stringify(new URL("../src/service.ts", import.meta.url).href)};
const data = JSON.parse(process.env.SERVICE_TEST_DATA);
const values = new Map(data.values);
const store = { get: id => values.get(id) ?? null, set: (id, value) => values.set(id, value), delete: id => values.delete(id) };
const send = value => process.send(value);
const originalServe = Bun.serve.bind(Bun);
Bun.serve = options => originalServe({ ...options, fetch(request, server) {
  const observed = request.clone();
  const result = options.fetch(request, server);
  // Report receipt without awaiting the blocked sync response.
  if (request.method === "POST") observed.json().then(body => {
    if (body.operation === "sync") send({ type: "forwarded" });
  }).catch(() => {});
  return result;
} });
let release;
const gate = new Promise(resolve => { release = resolve; });
let calls = 0, blocked = false;
const owner = new ClientService(data.root, { owner: "CLI", credentialStore: store, runnerOptions: { fetch: async (input, init) => {
  if (new URL(input instanceof Request ? input.url : input).pathname === "/v1/capabilities") calls++;
  if (!blocked) { blocked = true; send({ type: "ready", pid: process.pid }); await gate; }
  return fetch(input, init);
} } });
process.on("message", async message => {
  try {
    if (message === "release") release();
    if (message === "again") {
      const before = calls;
      const head = await owner.sync(data.id);
      send({ type: "again", head, calls: calls - before });
    }
    if (message === "stop") { await owner.stop(); send({ type: "stopped" }); process.disconnect(); }
  } catch (error) { send({ type: "error", error: String(error) }); }
});
Promise.all([owner.sync(data.id), owner.sync(data.id)]).then(([head, shared]) => {
  if (JSON.stringify(head) !== JSON.stringify(shared)) throw new Error("Concurrent owner requests returned different heads");
  send({ type: "completed", head, calls });
}).catch(error => send({ type: "error", error: String(error) }));
`;

test("independent CLI process coalesces desktop requests through authenticated control; Desktop.stop preserves CLI ownership", async () => {
  const e = await realServer(), f = e.first, { store, values } = memoryStore();
  const desktop = service(f.root, { owner: "Desktop", credentialStore: store, runnerOptions: { fetch: async () => { throw new Error("Desktop must forward, not start a competing runner"); } } });
  await desktop.migrate(f.info.serverId);
  type Message = { type: string; pid?: number; head?: { revisionId: string; sequence: number }; calls?: number; error?: string };
  const messages: Message[] = [], waiting: { type: string; resolve(value: Message): void; reject(error: Error): void }[] = [];
  let failure: Error | undefined;
  function receive(message: Message) {
    if (message.type === "error") {
      failure = new Error(message.error);
      for (const waiter of waiting.splice(0)) waiter.reject(failure);
      return;
    }
    const index = waiting.findIndex(waiter => waiter.type === message.type);
    if (index < 0) messages.push(message);
    else waiting.splice(index, 1)[0]!.resolve(message);
  }
  function next(type: string): Promise<Message> {
    if (failure) return Promise.reject(failure);
    const index = messages.findIndex(message => message.type === type);
    if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]!);
    return new Promise((resolve, reject) => waiting.push({ type, resolve, reject }));
  }
  const child = Bun.spawn([process.execPath, "--eval", ownerWorker], {
    env: { ...process.env, SERVICE_TEST_DATA: JSON.stringify({ root: f.root, id: f.binding.connectionId, values: [...values] }) },
    stdin: "ignore", stdout: "inherit", stderr: "inherit",
    ipc(message) { receive(message as Message); },
  });
  cleanups.push(async () => { if (child.exitCode === null) child.kill(); await child.exited; });
  void child.exited.then(code => {
    if (waiting.length) {
      failure = new Error(`Owner worker exited unexpectedly (${code})`);
      for (const waiter of waiting.splice(0)) waiter.reject(failure);
    }
  });
  const ready = await next("ready");
  expect(ready.pid).not.toBe(process.pid);
  const endpoint = ownerEndpoint(f.replica)!;
  expect(endpoint.pid).toBe(ready.pid!);
  expect(endpoint.owner).toBe("CLI");
  expect((await desktop.snapshot()).folders[0]).toMatchObject({ owner: "CLI", status: "Syncing" });
  const first = desktop.sync(f.binding.connectionId), second = desktop.sync(f.binding.connectionId);
  // Both real control requests have entered the CLI handler while its engine is blocked.
  await next("forwarded");
  await next("forwarded");
  child.send("release");
  const completed = await next("completed");
  expect(await first).toEqual(completed.head!);
  expect(await second).toEqual(completed.head!);
  // Each engine job negotiates capabilities once; both forwarded requests share that job.
  expect(completed.calls).toBe(1);
  // A later request is a new job, not a cached control response.
  child.send("again");
  const baseline = await next("again");
  expect(completed.calls).toBe(baseline.calls!);
  expect(ownerEndpoint(f.replica)).toEqual(endpoint);
  await desktop.stop();
  expect(ownerEndpoint(f.replica)).toEqual(endpoint);
  child.send("again");
  const surviving = await next("again");
  expect(surviving.head).toEqual(completed.head!);
  expect(surviving.calls).toBeGreaterThan(0);
  child.send("stop");
  await next("stopped");
  expect(await child.exited).toBe(0);
  expect(ownerEndpoint(f.replica)).toBeNull();
}, 20_000);

test("failed control cleanup still releases the runner and stop can retry after descriptor repair", async () => {
  const e = await realServer(), f = e.first, cli = service(f.root);
  await cli.sync(f.binding.connectionId);
  const descriptor = join(f.replica, "sync-control.json");
  expect(ownerEndpoint(f.replica)?.owner).toBe("CLI");
  chmodSync(descriptor, 0o644);
  // Restore permissions even on assertion failure so afterEach can drain the owner.
  cleanups.push(() => { if (existsSync(descriptor)) chmodSync(descriptor, 0o600); });
  await expect(cli.stop()).rejects.toThrow();
  expect(existsSync(descriptor)).toBe(true);
  expect(inspectSyncOwner(f.replica)).toBeNull();
  // This must acquire the real kernel gate too, not merely observe a missing PID file.
  const release = acquireSyncLock(f.replica);
  release();
  chmodSync(descriptor, 0o600);
  await cli.stop();
  expect(existsSync(descriptor)).toBe(false);
  expect(ownerEndpoint(f.replica)).toBeNull();
  await expect(cli.sync(f.binding.connectionId)).rejects.toThrow("stopped");
}, 20_000);
