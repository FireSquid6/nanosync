import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, cpSync, renameSync, rmSync, writeFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, discoverConnection, repairConnection, records, disconnectConnections, removeServerConnection } from "../src/connections.ts";

import { privateDirectory, secureCreate } from "../src/security.ts";
import { acquireSyncLock } from "../src/sync-lock.ts";
import { main } from "../src/main.ts";

const created: string[] = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "nanosync-connections-"));
  created.push(base);
  const global = join(base, "global"), first = join(base, "first"), second = join(base, "second");
  mkdirSync(global, { mode: 0o700 }); mkdirSync(first); mkdirSync(second);
  return { base, global, first, second, vault: randomUUID(), device: randomUUID() };
}
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("forced disconnect and server removal discard missing roots without bypassing locks", async () => {
  const e = fixture(), serverId = randomUUID();
  const credential = join(privateDirectory(join(e.global, "servers")), `${serverId}.json`);
  secureCreate(credential, JSON.stringify({ version: 1, serverId, baseUrl: "http://localhost", deviceId: e.device, name: "home", token: "a".repeat(43) }));
  const a = createConnection(e.global, e.first, serverId, e.vault, e.device);
  const b = createConnection(e.global, e.second, serverId, e.vault, e.device);
  rmSync(e.first, { recursive: true }); rmSync(e.second, { recursive: true });
  expect(() => disconnectConnections(e.global, [a])).toThrow(/missing/);
  expect(await main(["client", "vaults", "disconnect", "--client-dir", e.global, "--path", e.first, "--force"])).toBe(0);
  expect(records(e.global).map(item => item.connectionId)).toEqual([b.connectionId]);
  const replica = privateDirectory(join(privateDirectory(join(e.global, "replicas")), b.connectionId));
  const release = acquireSyncLock(replica);
  try { expect(() => removeServerConnection(e.global, serverId, true)).toThrow(/live process/); }
  finally { release(); }
  expect(existsSync(credential)).toBe(true);
  expect(records(e.global)).toHaveLength(1);
  removeServerConnection(e.global, serverId, true);
  expect(records(e.global)).toEqual([]);
  expect(existsSync(credential)).toBe(false);
});

test("force does not accept a replaced root or touch its marker", () => {
  const e = fixture();
  const a = createConnection(e.global, e.first, "server", e.vault, e.device);
  rmSync(e.first, { recursive: true });
  symlinkSync(e.second, e.first);
  expect(() => disconnectConnections(e.global, [a], true)).toThrow(/symlink/);
  expect(records(e.global)).toHaveLength(1);
  expect(existsSync(e.first)).toBe(true);
});

test("nearest marker, independent replicas, and overlapping-root rejection", () => {
  const e = fixture();
  const a = createConnection(e.global, e.first, "registered-server", e.vault, e.device);
  mkdirSync(join(e.first, "sub"));
  expect(discoverConnection(e.global, join(e.first, "sub"))).toEqual(a);
  expect(() => createConnection(e.global, join(e.first, "sub"), "registered-server", e.vault, e.device)).toThrow(/nested|overlap/);
  const b = createConnection(e.global, e.second, "registered-server", e.vault, e.device);
  expect(b.connectionId).not.toBe(a.connectionId);
  expect(() => discoverConnection(e.global, e.base)).toThrow(/client vaults connect/);
});

test("private .nanosync state is not an ancestor marker during setup, discovery or repair", () => {
  const e = fixture(), global = join(e.base, ".nanosync");
  mkdirSync(global, { mode: 0o700 });
  const connection = createConnection(global, e.first, "server", e.vault, e.device);
  expect(discoverConnection(global, e.first)).toEqual(connection);
  expect(() => discoverConnection(global, e.second)).toThrow(/client vaults connect/);
  expect(() => createConnection(global, global, "server", e.vault, e.device)).toThrow(/private global state/);
  cpSync(join(e.first, ".nanosync"), join(e.second, ".nanosync"));
  const copy = repairConnection(global, e.second, "copy", true);
  expect(discoverConnection(global, e.second)).toEqual(copy);
  const movedRoot = join(e.base, "moved");
  renameSync(e.first, movedRoot);
  const moved = repairConnection(global, movedRoot, "move");
  expect(moved.connectionId).toBe(connection.connectionId);
  expect(discoverConnection(global, movedRoot)).toEqual(moved);
});

test("nonempty confirmation, copied marker refusal and explicit independent copy", () => {
  const e = fixture();
  writeFileSync(join(e.first, "existing"), "present");
  expect(() => createConnection(e.global, e.first, "server", e.vault, e.device)).toThrow(/confirm/);
  const a = createConnection(e.global, e.first, "server", e.vault, e.device, true);
  cpSync(join(e.first, ".nanosync"), join(e.second, ".nanosync"));
  expect(() => discoverConnection(e.global, e.second)).toThrow(/copied or moved/);
  expect(() => repairConnection(e.global, e.second, "copy")).toThrow(/confirmation/);
  const b = repairConnection(e.global, e.second, "copy", true);
  expect(b.connectionId).not.toBe(a.connectionId);
  expect(discoverConnection(e.global, e.first)).toEqual(a);
  expect(discoverConnection(e.global, e.second)).toEqual(b);
});

test("moved root retains its journal identity, unknown state fails closed", () => {
  const e = fixture();
  const a = createConnection(e.global, e.first, "server", e.vault, e.device);
  rmSync(e.second, { recursive: true }); renameSync(e.first, e.second);
  expect(() => discoverConnection(e.global, e.second)).toThrow(/copied or moved/);
  const moved = repairConnection(e.global, e.second, "move");
  expect(moved.connectionId).toBe(a.connectionId);
  expect(discoverConnection(e.global, e.second)).toEqual(moved);
  const record = join(e.global, "connections", `${a.connectionId}.json`);
  rmSync(record);
  expect(() => discoverConnection(e.global, e.second)).toThrow(/global connection state/);
});
