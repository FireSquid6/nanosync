import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, cpSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createConnection, discoverConnection, repairConnection } from "../src/connections.ts";

const created: string[] = [];
function fixture() {
  const base = mkdtempSync(join(tmpdir(), "nanosync-connections-"));
  created.push(base);
  const global = join(base, "global"), first = join(base, "first"), second = join(base, "second");
  mkdirSync(global, { mode: 0o700 }); mkdirSync(first); mkdirSync(second);
  return { base, global, first, second, vault: randomUUID(), device: randomUUID() };
}
afterEach(() => { for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("nearest marker, independent replicas, and overlapping-root rejection", () => {
  const e = fixture();
  const a = createConnection(e.global, e.first, "registered-server", e.vault, e.device);
  mkdirSync(join(e.first, "sub"));
  expect(discoverConnection(e.global, join(e.first, "sub"))).toEqual(a);
  expect(() => createConnection(e.global, join(e.first, "sub"), "registered-server", e.vault, e.device)).toThrow(/nested|overlap/);
  const b = createConnection(e.global, e.second, "registered-server", e.vault, e.device);
  expect(b.connectionId).not.toBe(a.connectionId);
  expect(() => discoverConnection(e.global, e.base)).toThrow(/setup/);
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
  expect(() => discoverConnection(e.global, e.second)).toThrow(/repair/);
  const moved = repairConnection(e.global, e.second, "move");
  expect(moved.connectionId).toBe(a.connectionId);
  expect(discoverConnection(e.global, e.second)).toEqual(moved);
  const record = join(e.global, "connections", `${a.connectionId}.json`);
  rmSync(record);
  expect(() => discoverConnection(e.global, e.second)).toThrow(/global connection state/);
});
