import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, linkSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireStartupGate } from "../src/startup-lock.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nanosync-gate-"));
  chmodSync(root, 0o700); roots.push(root);
  return { root, gate: join(root, ".daemon-startup") };
}
function starttime() {
  const text = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  return text.slice(text.lastIndexOf(") ") + 2).split(/\s+/)[19]!;
}

test("stale absent PID and reused PID/starttime recover without manual intervention", () => {
  const { root, gate } = fixture();
  writeFileSync(gate, `2147483647:1\n`, { mode: 0o600 });
  const release = acquireStartupGate(root);
  expect(lstatSync(gate).mode & 0o777).toBe(0o600);
  expect(readFileSync(gate, "utf8")).toBe(`${process.pid}:${starttime()}\n`);
  release(); expect(existsSync(gate)).toBe(false);
  writeFileSync(gate, `${process.pid}:${BigInt(starttime()) + 1n}\n`, { mode: 0o600 });
  acquireStartupGate(root)();
  expect(existsSync(gate)).toBe(false);
});

test("live gate refuses another owner and retains its record", () => {
  const { root, gate } = fixture();
  const release = acquireStartupGate(root), record = readFileSync(gate, "utf8");
  expect(() => acquireStartupGate(root)).toThrow(/live process/);
  expect(readFileSync(gate, "utf8")).toBe(record);
  release();
});

test("unsafe, symlinked, hardlinked, and ownerless gates fail closed", () => {
  const { root, gate } = fixture();
  const target = join(root, "target");
  writeFileSync(target, `2147483647:1\n`, { mode: 0o600 });
  symlinkSync(target, gate);
  expect(() => acquireStartupGate(root)).toThrow(/unsafe startup gate/);
  expect(lstatSync(gate).isSymbolicLink()).toBe(true);
  rmSync(gate);
  writeFileSync(gate, `2147483647:1\n`, { mode: 0o666 }); chmodSync(gate, 0o644);
  expect(() => acquireStartupGate(root)).toThrow(/unsafe startup gate/);
  rmSync(gate);
  mkdirSync(gate, { mode: 0o700 });
  expect(() => acquireStartupGate(root)).toThrow(/unsafe startup gate/);
  rmSync(gate, { recursive: true });
  writeFileSync(gate, "", { mode: 0o600 });
  expect(() => acquireStartupGate(root)).toThrow(/trustworthy owner/);
  rmSync(gate);
  linkSync(target, gate);
  expect(() => acquireStartupGate(root)).toThrow(/hardlink/);
});

test("release refuses a replaced gate inode", () => {
  const { root, gate } = fixture();
  const release = acquireStartupGate(root);
  renameSync(gate, join(root, "saved"));
  writeFileSync(gate, `${process.pid}:${starttime()}\n`, { mode: 0o600 });
  expect(() => release()).toThrow(/changed/);
  expect(existsSync(gate)).toBe(true);
});

test("a crash after hardlink publication but before unlinking stage can recover", () => {
  const { root, gate } = fixture();
  const staged = join(root, ".daemon-startup-123e4567-e89b-42d3-a456-426614174005");
  writeFileSync(staged, "2147483647:1\n", { mode: 0o600 }); linkSync(staged, gate);
  acquireStartupGate(root)();
  expect(existsSync(gate)).toBe(false);
  expect(existsSync(staged)).toBe(false);
});
