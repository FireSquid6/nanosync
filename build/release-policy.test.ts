import { expect, test } from "bun:test";
import { assetNames, isLatestStable, parseTag, verifyAssets, writeChecksums } from "./release-policy";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("only strict SemVer version tags are accepted", () => {
  expect(parseTag("v1.2.3").prerelease).toBe(false);
  expect(parseTag("v1.2.3-beta.1+build.01").prerelease).toBe(true);
  for (const tag of [
    "1.2.3", "v01.2.3", "v1.02.3", "v1.2.03", "v1.2",
    "v1.2.3-01", "v1.2.3-", "v1.2.3+", "v1.2.3\n",
  ]) {
    expect(() => parseTag(tag)).toThrow();
  }
});

test("latest is the highest public stable version, not publication order", () => {
  const releases = [
    { tag_name: "v2.0.0", draft: false, prerelease: false },
    { tag_name: "v99.0.0", draft: true, prerelease: false },
    { tag_name: "v100.0.0-beta", draft: false, prerelease: true },
    { tag_name: "nonsense", draft: false, prerelease: false },
  ];
  expect(isLatestStable("v1.9.9", releases)).toBe(false);
  expect(isLatestStable("v2.0.1", releases)).toBe(true);
  expect(isLatestStable("v3.0.0-beta", releases)).toBe(false);
  expect(isLatestStable("v9007199254740993.0.0", [
    { tag_name: "v9007199254740992.0.0", draft: false, prerelease: false },
  ])).toBe(true);
});

test("exactly four CLI executables, a debug APK, and matching checksums are required", async () => {
  const directory = await mkdtemp(join(tmpdir(), "release-policy-"));
  try {
    for (const name of assetNames) await writeFile(join(directory, name), "abc");
    await writeChecksums(directory);
    expect(await Bun.file(join(directory, "nanosync-linux-x64.sha256")).text()).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  nanosync-linux-x64\n",
    );
    await verifyAssets(directory);
    await writeFile(join(directory, "secret"), "must not upload");
    await expect(verifyAssets(directory)).rejects.toThrow();
    await rm(join(directory, "secret"));
    await writeFile(join(directory, "nanosync-linux-x64.sha256"), "BA7816BF  nanosync-linux-x64\n");
    await expect(verifyAssets(directory)).rejects.toThrow();
    await writeChecksums(directory);
    await writeFile(join(directory, "nanosync-linux-x64"), "corrupt");
    await expect(verifyAssets(directory)).rejects.toThrow();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("publication verifies drafts and never overwrites public assets", async () => {
  const { publishRelease, releaseAssetNames } = await import("./release-policy");
  const directory = await mkdtemp(join(tmpdir(), "release-publish-"));
  const calls: string[][] = [];
  let publicRelease = false;
  let wrongAssets = false;
  let absent = false;
  let corruptDownload = false;
  const run = async (args: string[]) => {
    calls.push(args);
    if (args[0] === "api" && absent) return "[[]]";
    if (args[0] === "api") return JSON.stringify([[{
      tag_name: "v1.0.0", draft: !publicRelease, prerelease: false,
    }, { tag_name: "v2.0.0", draft: false, prerelease: false }]]);
    if (args[1] === "view") return JSON.stringify({
      assets: (wrongAssets ? [] : releaseAssetNames).map(name => ({ name })),
    });
    if (args[1] === "download") {
      const destination = args[args.indexOf("--dir") + 1]!;
      for (const name of releaseAssetNames) {
        await Bun.write(join(destination, name), Bun.file(join(directory, name)));
      }
      if (corruptDownload) await Bun.write(join(destination, assetNames[0]!), "corrupt");
    }
    return "";
  };
  try {
    for (const name of assetNames) await writeFile(join(directory, name), "abc");
    await writeChecksums(directory);
    await publishRelease("v1.0.0", directory, run);
    expect(calls.at(-1)?.slice(0, 6)).toEqual([
      "release", "edit", "v1.0.0", "--draft=false", "--prerelease=false", "--latest=false",
    ]);
    expect(calls.findIndex(args => args[1] === "download")).toBeLessThan(
      calls.findIndex(args => args[1] === "edit"),
    );

    calls.length = 0;
    publicRelease = true;
    await publishRelease("v1.0.0", directory, run);
    expect(calls.map(args => args[1])).toEqual(["--paginate", "view", "download"]);

    calls.length = 0;
    publicRelease = false;
    wrongAssets = true;
    await expect(publishRelease("v1.0.0", directory, run)).rejects.toThrow();
    expect(calls.some(args => args[1] === "edit")).toBe(false);

    calls.length = 0;
    wrongAssets = false;
    corruptDownload = true;
    await expect(publishRelease("v1.0.0", directory, run)).rejects.toThrow();
    expect(calls.some(args => args[1] === "edit")).toBe(false);

    calls.length = 0;
    corruptDownload = false;
    absent = true;
    await publishRelease("v3.0.0-beta.1", directory, run);
    expect(calls.find(args => args[1] === "create")).toContain("--draft");
    expect(calls.find(args => args[1] === "create")).toContain("--prerelease");
    expect(calls.at(-1)).toContain("--prerelease=true");
    expect(calls.at(-1)).toContain("--latest=false");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("release publication queues tags and waits for CLI, macOS installer, and Android checks", async () => {
  const file = new URL("../.github/workflows/release.yml", import.meta.url);
  const workflow = Bun.YAML.parse(await Bun.file(file).text()) as {
    jobs: {
      publish: { needs: string[]; concurrency: Record<string, unknown> };
      android: { uses: string };
      build: { steps: { name?: string; if?: string; run?: string }[] };
    };
  };
  expect(workflow.jobs.publish.needs).toEqual(["checks", "build", "android"]);
  expect(workflow.jobs.publish.concurrency).toEqual({
    group: "nanosync-release-publication", queue: "max", "cancel-in-progress": false,
  });
  expect(workflow.jobs.android.uses).toBe("./.github/workflows/android.yml");
  expect(workflow.jobs.build.steps).toContainEqual({
    name: "Installer fixtures on macOS Bash 3.2",
    if: "matrix.target == 'darwin-arm64'",
    run: "/bin/bash build/test-install.sh",
  });
});

test("binary builder preserves its default and rejects unsafe targets/outputs before building", async () => {
  const { chmod } = await import("node:fs/promises");
  const directory = await mkdtemp(join(tmpdir(), "release-builder-"));
  try {
    await writeFile(join(directory, "bun"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$BUILD_LOG"\n');
    await chmod(join(directory, "bun"), 0o755);
    const log = join(directory, "calls");
    const invoke = (args: string[]) => Bun.spawnSync(["bash", "build/binary.sh", ...args], {
      env: { ...process.env, PATH: `${directory}:${process.env.PATH}`, BUILD_LOG: log },
    });
    expect(invoke([]).exitCode).toBe(0);
    expect(await Bun.file(log).text()).toContain(
      "--target=bun-linux-x64 packages/cli/src/main.ts --outfile dist/nanosync\n",
    );
    for (const target of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64"]) {
      expect(invoke([target, `dist/nanosync-${target}`]).exitCode).toBe(0);
    }
    const before = await Bun.file(log).text();
    for (const args of [
      ["windows-x64"], ["linux-x64", "../secret"],
      ["linux-x64", "dist/nanosync-arm64"], ["linux-x64", "dist/nanosync", "extra"],
    ]) {
      expect(invoke(args).exitCode).not.toBe(0);
    }
    expect(await Bun.file(log).text()).toBe(before);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
