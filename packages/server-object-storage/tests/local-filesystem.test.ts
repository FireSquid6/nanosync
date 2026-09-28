import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, link, lstat, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
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

async function promptly<T>(operation: Promise<T>): Promise<T> {
  return Promise.race([
    operation,
    Bun.sleep(250).then(() => { throw new Error("operation did not settle promptly"); }),
  ]);
}

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

  test("only publishes a mutated producer chunk when stored bytes match the accepted checksum", async () => {
    const { root, filesystem } = await create();
    const bytes = new Uint8Array(1024 * 1024).fill(65);
    const mutated = new Uint8Array(bytes.byteLength).fill(66);
    const checksum = createHash("sha256").update(mutated).digest("hex");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(bytes);
        queueMicrotask(() => bytes.fill(66));
        controller.close();
      },
    });

    try {
      await filesystem.putIfAbsent("mutated", source, checksum);
      const stored = await readFile(join(root, "mutated"));
      expect(createHash("sha256").update(stored).digest("hex")).toBe(checksum);
    } catch {
      expect(await filesystem.existsBatch(["mutated"])).toEqual([false]);
    }
  });

  test("cannot publish or misreport a Uint8Array that grows during upload", async () => {
    const initialSize = 4 * 1024 * 1024;
    const expandedSize = initialSize * 2;
    let buffer: ArrayBuffer;
    try {
      buffer = new ArrayBuffer(initialSize, { maxByteLength: expandedSize });
      if (!buffer.resizable) return;
    } catch {
      return;
    }

    const { root, filesystem } = await create({ maximumObjectSize: initialSize });
    const expandedChecksum = createHash("sha256").update(new Uint8Array(expandedSize)).digest("hex");
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(buffer));
        queueMicrotask(() => buffer.resize(expandedSize));
        controller.close();
      },
    });

    try {
      const result = await filesystem.putIfAbsent("resizable", source, expandedChecksum);
      const stored = await readFile(join(root, "resizable"));
      expect(stored.byteLength).toBeLessThanOrEqual(initialSize);
      expect(result.size).toBe(stored.byteLength);
      expect(createHash("sha256").update(stored).digest("hex")).toBe(expandedChecksum);
    } catch {
      expect(await filesystem.existsBatch(["resizable"])).toEqual([false]);
    }
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
    await expect(filesystem.existsBatch(["escape/object"])).rejects.toMatchObject({ code: "SYMLINK" });
    await expect(filesystem.delete("escape/object")).rejects.toMatchObject({ code: "SYMLINK" });
  });

  test("rejects a symlink root and reserved temporary path", async () => {
    const actualRoot = await mkdtemp(join(tmpdir(), "nanosync-actual-"));
    const linkRoot = `${actualRoot}-link`;
    roots.push(linkRoot, actualRoot);
    await symlink(actualRoot, linkRoot);
    await expect(new LocalFilesystem(linkRoot).existsBatch(["object"])).rejects.toMatchObject({ code: "SYMLINK" });

    const root = await mkdtemp(join(tmpdir(), "nanosync-temp-link-"));
    const outside = await mkdtemp(join(tmpdir(), "nanosync-temp-outside-"));
    roots.push(root, outside);
    await symlink(outside, join(root, ".nanosync-tmp"));
    await expect(new LocalFilesystem(root).existsBatch(["object"])).rejects.toMatchObject({ code: "SYMLINK" });
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

  test("orders and paginates a flat directory independently of iteration order", async () => {
    const { root, filesystem } = await create();
    await filesystem.existsBatch(["missing"]);
    for (let index = 39; index >= 0; index--) {
      await writeFile(join(root, `flat-${index.toString().padStart(2, "0")}`), "hello", { mode: 0o600 });
    }

    const first = await filesystem.list("flat-", { limit: 3 });
    expect(first).toEqual({ keys: ["flat-00", "flat-01", "flat-02"], cursor: "flat-02" });
    expect(await filesystem.list("flat-", { limit: 3, cursor: first.cursor ?? undefined })).toEqual({
      keys: ["flat-03", "flat-04", "flat-05"],
      cursor: "flat-05",
    });
  });

  test("orders nested and sibling keys by the complete lexical key", async () => {
    const { filesystem } = await create();
    for (const key of ["a/x", "a-", "a/y"]) {
      await filesystem.putIfAbsent(key, stream("hello"), helloChecksum);
    }
    expect(await filesystem.list()).toEqual({ keys: ["a-", "a/x", "a/y"], cursor: null });
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

  test("cleans temporary state before non-settling source cancellation", async () => {
    const { root, filesystem } = await create({ maximumObjectSize: 1 });
    let cancelCalled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array(2));
      },
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(promptly(filesystem.putIfAbsent("oversized", source, "0".repeat(64)))).rejects.toMatchObject({
      code: "SIZE_LIMIT_EXCEEDED",
    });
    expect(cancelCalled).toBe(true);
    expect(await readdir(join(root, ".nanosync-tmp"))).toEqual([]);
  });

  test("cancels an unused idempotent source without awaiting cancellation", async () => {
    const { filesystem } = await create();
    await filesystem.putIfAbsent("existing", stream("hello"), helloChecksum);
    let cancelCalled = false;
    const unused = new ReadableStream<Uint8Array>({
      cancel() {
        cancelCalled = true;
        return new Promise<void>(() => {});
      },
    });

    await expect(promptly(filesystem.putIfAbsent("existing", unused, helloChecksum))).resolves.toMatchObject({
      status: "already-present",
    });
    expect(cancelCalled).toBe(true);
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

  test("creates restrictive directories and objects", async () => {
    const { root, filesystem } = await create();
    await filesystem.putIfAbsent("nested/object", stream("hello"), helloChecksum);
    for (const [path, expected] of [
      [root, 0o700],
      [join(root, ".nanosync-tmp"), 0o700],
      [join(root, "nested"), 0o700],
      [join(root, "nested/object"), 0o600],
    ] as const) {
      expect((await lstat(path)).mode & 0o777).toBe(expected);
    }
  });

  test("rejects unsafe pre-existing directory and file permissions", async () => {
    const unsafeRoot = await mkdtemp(join(tmpdir(), "nanosync-unsafe-root-"));
    roots.push(unsafeRoot);
    await chmod(unsafeRoot, 0o755);
    await expect(new LocalFilesystem(unsafeRoot).existsBatch(["object"])).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    const unsafeTempRoot = await mkdtemp(join(tmpdir(), "nanosync-unsafe-temp-"));
    roots.push(unsafeTempRoot);
    await mkdir(join(unsafeTempRoot, ".nanosync-tmp"), { mode: 0o755 });
    await expect(new LocalFilesystem(unsafeTempRoot).existsBatch(["object"])).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    const unsafeDirectoryRoot = await mkdtemp(join(tmpdir(), "nanosync-unsafe-directory-"));
    roots.push(unsafeDirectoryRoot);
    await mkdir(join(unsafeDirectoryRoot, "unsafe"), { mode: 0o700 });
    await chmod(join(unsafeDirectoryRoot, "unsafe"), 0o755);
    const directoryFilesystem = new LocalFilesystem(unsafeDirectoryRoot);
    await expect(directoryFilesystem.existsBatch(["unsafe/object"])).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    const unsafeFileRoot = await mkdtemp(join(tmpdir(), "nanosync-unsafe-file-"));
    roots.push(unsafeFileRoot);
    const fileFilesystem = new LocalFilesystem(unsafeFileRoot);
    await writeFile(join(unsafeFileRoot, "object"), "hello", { mode: 0o644 });
    await expect(fileFilesystem.existsBatch(["object"])).rejects.toMatchObject({ code: "UNSAFE_PATH" });

    const hardLinkRoot = await mkdtemp(join(tmpdir(), "nanosync-hard-link-"));
    roots.push(hardLinkRoot);
    const hardLinkFilesystem = new LocalFilesystem(hardLinkRoot);
    await writeFile(join(hardLinkRoot, "object"), "hello", { mode: 0o600 });
    await link(join(hardLinkRoot, "object"), join(hardLinkRoot, "alias"));
    await expect(hardLinkFilesystem.existsBatch(["object"])).rejects.toMatchObject({ code: "UNSAFE_PATH" });
  });
});
