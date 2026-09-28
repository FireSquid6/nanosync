import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LocalFilesystem,
  ObjectStorageError,
  type Filesystem,
} from "../src/index.ts";

const roots: string[] = [];
const encoder = new TextEncoder();

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function create(options: { maximumObjectSize?: number } = {}): Promise<{ root: string; filesystem: Filesystem }> {
  const root = await mkdtemp(join(tmpdir(), "nanosync-objects-"));
  roots.push(root);
  return { root, filesystem: new LocalFilesystem(root, options) };
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    pull(controller) {
      const value = chunks.shift();
      if (value === undefined) controller.close();
      else controller.enqueue(encoder.encode(value));
    },
  });
}

async function text(body: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(body).text();
}

const helloChecksum = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

describe("LocalFilesystem", () => {
  test("streams a verified object through every public read operation", async () => {
    const { filesystem } = await create();
    expect(await filesystem.putIfAbsent("chunks/aa/hello", stream("he", "ll", "o"), helloChecksum)).toEqual({
      status: "stored",
      size: 5,
      checksum: helloChecksum,
    });

    expect(await filesystem.stat("chunks/aa/hello")).toMatchObject({ size: 5 });
    expect(await filesystem.existsBatch(["chunks/aa/hello", "chunks/missing"])).toEqual([true, false]);
    expect(await text((await filesystem.open("chunks/aa/hello")).stream)).toBe("hello");

    expect(await filesystem.delete("chunks/aa/hello")).toEqual({ deleted: true });
    expect(await filesystem.delete("chunks/aa/hello")).toEqual({ deleted: false });
  });

  test("does not publish checksum mismatches and removes temporary files", async () => {
    const { root, filesystem } = await create();
    await expect(filesystem.putIfAbsent("bad/object", stream("wrong"), helloChecksum)).rejects.toMatchObject({
      code: "CHECKSUM_MISMATCH",
    });
    expect(await filesystem.existsBatch(["bad/object"])).toEqual([false]);
    expect(await readdir(join(root, ".nanosync-tmp"))).toEqual([]);
  });

  test("is idempotent for matching objects and never replaces a conflict", async () => {
    const { filesystem } = await create();
    await filesystem.putIfAbsent("object", stream("hello"), helloChecksum);
    expect(await filesystem.putIfAbsent("object", stream("ignored"), helloChecksum)).toMatchObject({ status: "already-present" });

    const otherChecksum = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7";
    await expect(filesystem.putIfAbsent("object", stream("world"), otherChecksum)).rejects.toMatchObject({
      code: "OBJECT_CONFLICT",
    });
    expect(await text((await filesystem.open("object")).stream)).toBe("hello");
  });

  test("publishes only one object when different writers race", async () => {
    const { filesystem } = await create();
    const worldChecksum = "486ea46224d1bb4fb680f34f7c9ad96a8f24ec88be73ea8e5a6c65260e9cb8a7";
    const results = await Promise.allSettled([
      filesystem.putIfAbsent("raced", stream("hello"), helloChecksum),
      filesystem.putIfAbsent("raced", stream("world"), worldChecksum),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected).toMatchObject({ status: "rejected", reason: { code: "OBJECT_CONFLICT" } });
    expect(["hello", "world"]).toContain(await text((await filesystem.open("raced")).stream));
  });

  test("rejects traversal, ambiguous keys, and symlink traversal", async () => {
    const { root, filesystem } = await create();
    for (const key of ["", "/absolute", "../escape", "a/../b", "a//b", "a/./b", "a\\b", "nul\0byte", ".nanosync-tmp/x"]) {
      await expect(filesystem.existsBatch([key])).rejects.toBeInstanceOf(ObjectStorageError);
    }

    const outside = await mkdtemp(join(tmpdir(), "nanosync-outside-"));
    roots.push(outside);
    await symlink(outside, join(root, "escape"));
    await expect(filesystem.putIfAbsent("escape/object", stream("hello"), helloChecksum)).rejects.toMatchObject({ code: "SYMLINK" });
    await expect(filesystem.open("escape/object")).rejects.toMatchObject({ code: "SYMLINK" });
  });

  test("uses validated half-open byte ranges", async () => {
    const { filesystem } = await create();
    await filesystem.putIfAbsent("object", stream("hello"), helloChecksum);
    const opened = await filesystem.open("object", { start: 1, endExclusive: 4 });
    expect(opened).toMatchObject({ size: 5, range: { start: 1, endExclusive: 4 } });
    expect(await text(opened.stream)).toBe("ell");
    expect(await text((await filesystem.open("object", { start: 5, endExclusive: 5 })).stream)).toBe("");

    for (const range of [
      { start: -1, endExclusive: 2 },
      { start: 2, endExclusive: 1 },
      { start: 0, endExclusive: 6 },
      { start: 0.5, endExclusive: 2 },
    ]) {
      await expect(filesystem.open("object", range)).rejects.toMatchObject({ code: "RANGE_NOT_SATISFIABLE" });
    }
  });

  test("lists regular objects in stable pages", async () => {
    const { filesystem } = await create();
    for (const key of ["chunks/c", "manifests/a", "chunks/a", "chunks/b"]) {
      await filesystem.putIfAbsent(key, stream("hello"), helloChecksum);
    }
    const first = await filesystem.list("chunks", { limit: 2 });
    expect(first).toEqual({ keys: ["chunks/a", "chunks/b"], cursor: "chunks/b" });
    expect(await filesystem.list("chunks", { limit: 2, cursor: first.cursor ?? undefined })).toEqual({
      keys: ["chunks/c"],
      cursor: null,
    });
  });

  test("cleans up after an interrupted source stream", async () => {
    const { root, filesystem } = await create();
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("partial"));
        controller.error(new Error("connection lost"));
      },
    });
    await expect(filesystem.putIfAbsent("interrupted", source, helloChecksum)).rejects.toThrow("connection lost");
    expect(await filesystem.existsBatch(["interrupted"])).toEqual([false]);
    expect(await readdir(join(root, ".nanosync-tmp"))).toEqual([]);
  });

  test("enforces the configured size while consuming incrementally", async () => {
    const { filesystem } = await create({ maximumObjectSize: 5 });
    let pulls = 0;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls++;
        controller.enqueue(new Uint8Array(3));
      },
      cancel() {},
    });
    await expect(filesystem.putIfAbsent("too-large", source, "0".repeat(64))).rejects.toMatchObject({ code: "SIZE_LIMIT_EXCEEDED" });
    expect(pulls).toBeLessThan(5);
    expect(await filesystem.existsBatch(["too-large"])).toEqual([false]);
  });

  test("rejects symlink entries encountered while listing", async () => {
    const { root, filesystem } = await create();
    await mkdir(join(root, "objects"), { mode: 0o700 });
    await symlink("elsewhere", join(root, "objects", "link"));
    await expect(filesystem.list("objects")).rejects.toMatchObject({ code: "SYMLINK" });
  });
});
