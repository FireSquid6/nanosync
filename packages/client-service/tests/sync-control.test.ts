import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireSyncLock } from "../src/sync-lock.ts";
import { privateDirectory, secureCreate, secureReplace } from "../src/security.ts";
import { ownerEndpoint, publishControl, requestOwner, type OwnerStatus } from "../src/sync-control.ts";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
function temp() {
  const root = privateDirectory(mkdtempSync(join(tmpdir(), "sync-control-")));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
const status: OwnerStatus = { owner: "CLI", status: "Not checked", progress: null, error: null, lastSync: null, sequence: null, conflicts: 0 };
function fixture(sync = async () => ({ revisionId: "revision", sequence: 1 })) {
  const root = temp(), release = acquireSyncLock(root);
  cleanups.push(release);
  let reads = 0, syncs = 0;
  const control = publishControl(root, "CLI", { status: () => { reads++; return status; }, sync: () => { syncs++; return sync(); } });
  cleanups.push(() => control.stop());
  const endpoint = ownerEndpoint(root)!;
  const url = `http://127.0.0.1:${endpoint.port}/`;
  const headers = { authorization: `Bearer ${endpoint.capability}`, "content-type": "application/json" };
  return { root, endpoint, url, headers, counts: () => ({ reads, syncs }) };
}

test("control requires a lock and authenticates every operation, rejecting browser Origins", async () => {
  expect(() => publishControl(temp(), "CLI", { status: () => status, sync: async () => ({ revisionId: "x", sequence: 1 }) })).toThrow("ownership lock");
  const f = fixture();
  for (const headers of [{}, { ...f.headers, authorization: `Bearer ${"0".repeat(64)}` }, { ...f.headers, authorization: `Bearer ${"0".repeat(63)}é` }, { ...f.headers, origin: "http://localhost" }, { ...f.headers, origin: "null" }]) {
    const response = await fetch(f.url, { method: "POST", headers, body: JSON.stringify({ operation: "sync" }) });
    expect(response.status).toBe(401);
    await response.text();
  }
  expect(f.counts()).toEqual({ reads: 0, syncs: 0 });
  expect(await requestOwner<OwnerStatus>(f.endpoint, "status")).toEqual(status);
  expect(await requestOwner<{ revisionId: string; sequence: number }>(f.endpoint, "sync")).toEqual({ revisionId: "revision", sequence: 1 });
  expect(f.counts()).toEqual({ reads: 1, syncs: 1 });
});

test("authenticated control accepts only exact status/sync requests and hides handler errors", async () => {
  const f = fixture(async () => { throw new Error("private-token /private/path master-key"); });
  for (const body of [{ operation: "quit" }, { operation: "migrate" }, { operation: "sync", id: "another-folder" }, {}, [], null]) {
    const response = await fetch(f.url, { method: "POST", headers: f.headers, body: JSON.stringify(body) });
    expect(response.status).toBe(400);
    await response.text();
  }
  for (const [method, path] of [["GET", ""], ["POST", "other"]]) {
    const response = await fetch(f.url + path, { method, headers: f.headers });
    expect(response.status).toBe(404);
    await response.text();
  }
  expect(f.counts()).toEqual({ reads: 0, syncs: 0 });
  const failure = await fetch(f.url, { method: "POST", headers: f.headers, body: JSON.stringify({ operation: "sync" }) });
  expect(failure.status).toBe(409);
  expect(await failure.json()).toEqual({ error: "The active owner could not complete synchronization." });
});

test("stale or PID-mismatched endpoint metadata never directs discovery to an attacker listener", async () => {
  const f = fixture();
  let requests = 0;
  const attacker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json(status); } });
  cleanups.push(async () => { await attacker.stop(true); });
  for (const identity of [{ pid: process.pid, starttime: String(BigInt(f.endpoint.starttime) + 1n) }, { pid: 2147483647, starttime: f.endpoint.starttime }]) {
    secureReplace(join(f.root, "sync-control.json"), JSON.stringify({ ...f.endpoint, ...identity, port: attacker.port }));
    const discovered = ownerEndpoint(f.root);
    if (discovered) await requestOwner(discovered, "status");
    expect(discovered).toBeNull();
  }
  expect(requests).toBe(0);
});

test("a live legacy owner without control is preserved and cannot be replaced", () => {
  const root = temp(), release = acquireSyncLock(root);
  const original = readFileSync(join(root, ".sync-owner"), "utf8");
  release();
  // Legacy owners leave a PID record without holding the new kernel gate.
  secureCreate(join(root, ".sync-owner"), original);
  expect(ownerEndpoint(root)).toBeNull();
  expect(() => acquireSyncLock(root)).toThrow("another live process");
  expect(readFileSync(join(root, ".sync-owner"), "utf8")).toBe(original);
  expect(existsSync(join(root, "sync-control.json"))).toBe(false);
});

test("old control cleanup preserves replacement endpoint metadata", async () => {
  const root = temp(), release = acquireSyncLock(root);
  cleanups.push(release);
  const control = publishControl(root, "CLI", { status: () => status, sync: async () => ({ revisionId: "x", sequence: 1 }) });
  cleanups.push(() => control.stop());
  const replacement = JSON.stringify({ ...ownerEndpoint(root), capability: "f".repeat(64) });
  secureReplace(join(root, "sync-control.json"), replacement);
  await control.stop();
  expect(readFileSync(join(root, "sync-control.json"), "utf8")).toBe(replacement);
});

test("a previously discovered handle is rejected before contacting a replaced listener", async () => {
  const f = fixture();
  let requests = 0;
  const attacker = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() { requests++; return Response.json(status); } });
  cleanups.push(async () => { await attacker.stop(true); });
  const path = join(f.root, "sync-control.json");
  // Discover a live handle, then replace its registration before the caller sends.
  secureReplace(path, JSON.stringify({ ...f.endpoint, port: attacker.port }));
  const saved = ownerEndpoint(f.root)!;
  for (const replacement of [
    { ...f.endpoint, capability: "f".repeat(64) },
    { ...f.endpoint, starttime: String(BigInt(f.endpoint.starttime) + 1n) },
    { ...f.endpoint, pid: 2147483647 },
  ]) {
    secureReplace(path, JSON.stringify(replacement));
    await expect(requestOwner<OwnerStatus>(saved, "status")).rejects.toThrow();
  }
  expect(requests).toBe(0);
});

test("an owner response is rejected if its capability changes while the request is in flight", async () => {
  const f = fixture();
  let requests = 0;
  const listener = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    requests++;
    secureReplace(join(f.root, "sync-control.json"), JSON.stringify({ ...f.endpoint, capability: "e".repeat(64) }));
    return Response.json(status);
  } });
  cleanups.push(async () => { await listener.stop(true); });
  secureReplace(join(f.root, "sync-control.json"), JSON.stringify({ ...f.endpoint, port: listener.port }));
  const discovered = ownerEndpoint(f.root)!;
  await expect(requestOwner<OwnerStatus>(discovered, "status")).rejects.toThrow();
  expect(requests).toBe(1);
});
