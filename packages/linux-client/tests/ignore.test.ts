import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { IgnoreRules } from "../src/ignore.ts";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function rules(text: string) {
  const dir = mkdtempSync(join(tmpdir(), "nanosync-ignore-")); dirs.push(dir);
  writeFileSync(join(dir, ".nanosyncignore"), text);
  return { dir, policy: new IgnoreRules(dir) };
}
test("anchored, basename, glob, and directory-only patterns", () => {
  const { policy } = rules("# local config\n.venv/\n/build/\n*.tmp\nproject/**/cache/\n");
  expect(policy.ignores("nested/.venv/lib/link")).toBe(true);
  expect(policy.ignores(".venv", true)).toBe(true);
  expect(policy.ignores(".venv")).toBe(false);
  expect(policy.ignores("nested/build", true)).toBe(false);
  expect(policy.ignores("build", true)).toBe(true);
  expect(policy.ignores("nested/x.tmp")).toBe(true);
  expect(policy.ignores("project/lib/cache/item")).toBe(true);
  expect(policy.ignores("project/cache/item")).toBe(true);
  expect(policy.ignores("nested/.nanosyncignore")).toBe(false);
  expect(policy.ignores(".nanosyncignore")).toBe(true);
});
test("invalid policy fails closed; control file cannot be a link", () => {
  for (const pattern of ["!keep", "../private", "foo\\bar", "[ab]"]) {
    const dir = mkdtempSync(join(tmpdir(), "nanosync-ignore-")); dirs.push(dir);
    writeFileSync(join(dir, ".nanosyncignore"), pattern);
    expect(() => new IgnoreRules(dir)).toThrow();
  }
  const dir = mkdtempSync(join(tmpdir(), "nanosync-ignore-")); dirs.push(dir);
  symlinkSync("missing", join(dir, ".nanosyncignore"));
  expect(() => new IgnoreRules(dir)).toThrow(/unsafe/);
});
