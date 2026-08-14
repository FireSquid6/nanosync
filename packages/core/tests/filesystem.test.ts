import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BunFilesystem, MockFilesystem, type Filesystem } from "./filesystem";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true })));
});

describe.each([
  ["mock", async (): Promise<Filesystem> => new MockFilesystem()],
  ["Bun", async (): Promise<Filesystem> => {
    const path = await mkdtemp(join(tmpdir(), "nanosync-"));
    temporaryDirectories.push(path);
    return new BunFilesystem(path);
  }],
])("%s filesystem", (_, createFilesystem) => {
  test("reads, writes, lists, stats, hashes, and checks existence", async () => {
    const filesystem = await createFilesystem();

    await filesystem.writeFile("notes/today.txt", "hello");

    expect(await new Response(await filesystem.readFile("notes/today.txt")).text()).toBe("hello");
    expect(await filesystem.listDirectory("notes")).toEqual(["today.txt"]);
    expect(await filesystem.exists("notes")).toBe(true);
    expect(await filesystem.exists("missing")).toBe(false);
    expect(await filesystem.getHash("notes/today.txt")).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );

    const file = await filesystem.stat("notes/today.txt");
    expect(file.size).toBe(5);
    expect(file.isFile()).toBe(true);
    expect(file.isDirectory()).toBe(false);

    const directory = await filesystem.stat("notes");
    expect(directory.isDirectory()).toBe(true);
  });

  test("writes streams", async () => {
    const filesystem = await createFilesystem();
    const data = new Blob(["streamed"]).stream();

    await filesystem.writeFile("stream.txt", data);

    expect(await new Response(await filesystem.readFile("stream.txt")).text()).toBe("streamed");
  });

  test("does not replace a directory with a file", async () => {
    const filesystem = await createFilesystem();
    await filesystem.writeFile("directory/child.txt", "child");

    await expect(filesystem.writeFile("directory", "file")).rejects.toMatchObject({ code: "EISDIR" });
  });
});

test("Bun filesystem confines paths to its root", async () => {
  const root = await mkdtemp(join(tmpdir(), "nanosync-root-"));
  const outside = await mkdtemp(join(tmpdir(), "nanosync-outside-"));
  temporaryDirectories.push(root, outside);
  const filesystem = new BunFilesystem(root);

  await expect(filesystem.writeFile("../outside.txt", "nope")).rejects.toThrow("escapes filesystem root");
  await expect(filesystem.writeFile("../../home/outside.txt", "nope")).rejects.toThrow("escapes filesystem root");

  await filesystem.writeFile("/usr/bin/tool", "inside");
  expect(await readFile(join(root, "usr/bin/tool"), "utf8")).toBe("inside");

  await writeFile(join(outside, "secret.txt"), "secret");
  await symlink(outside, join(root, "escape"));

  await expect(filesystem.readFile("escape/secret.txt")).rejects.toThrow("symbolic link");
  await expect(filesystem.writeFile("escape/new.txt", "nope")).rejects.toThrow("symbolic link");
  expect(await Bun.file(join(outside, "new.txt")).exists()).toBe(false);

  await symlink(root, join(outside, "back"));
  await rm(join(root, "escape"));
  await symlink(join(outside, "back"), join(root, "escape"));
  await expect(filesystem.writeFile("escape/round-trip.txt", "nope")).rejects.toThrow("symbolic link");
  expect(await Bun.file(join(root, "round-trip.txt")).exists()).toBe(false);
});
