import { expect, test } from "bun:test";
import { IgnoreMatcher } from "../src/index.ts";

test("portable ignore matcher preserves directory, anchoring, glob, and metadata guards", () => {
  const policy = new IgnoreMatcher("# local config\r\n.venv/\n/build/\n*.tmp\nproject/**/cache/\n");
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
  expect(policy.ignores(".nanosync")).toBe(true);
  expect(policy.ignores("nested/.nanosync")).toBe(false);
  for (const pattern of ["!keep", "../private", "foo\\bar", "[ab]", "***"]) {
    expect(() => new IgnoreMatcher(pattern)).toThrow();
  }
  expect(new IgnoreMatcher("").ignores("included")).toBe(false);
});
