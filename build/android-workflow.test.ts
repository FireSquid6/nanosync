import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Step = { name?: string; run?: string; uses?: string; with?: { name?: string; path?: string; "if-no-files-found"?: string } };
const workflow = Bun.YAML.parse(await Bun.file(new URL("../.github/workflows/android.yml", import.meta.url)).text()) as {
  on: Record<string, unknown>;
  concurrency: { group: string; "cancel-in-progress": string };
  jobs: { android: { steps: Step[] } };
};

test("Android validation is reusable without dropping existing entry points or pinned checks", () => {
  for (const event of ["workflow_call", "pull_request", "push", "workflow_dispatch"]) {
    expect(Object.hasOwn(workflow.on, event)).toBe(true);
  }
  expect(workflow.concurrency.group).toStartWith("android-validation-");
  expect(workflow.concurrency["cancel-in-progress"]).toBe("${{ github.event_name == 'pull_request' }}");
  const build = workflow.jobs.android.steps.find((step) => step.run?.includes("nix develop"))!.run!;
  for (const command of [
    "nix develop .#android-build", "bun install --frozen-lockfile", "bun test",
    "bun run typecheck", "bun run typecheck:android", ":app:assembleDebug",
    ":app:assembleDebugAndroidTest", ":app:lintDebug",
  ]) expect(build).toContain(command);
  expect(build).not.toContain("assembleRelease");
});

test("debug distribution contains only the renamed APK and a standard verified checksum", async () => {
  const steps = workflow.jobs.android.steps;
  const artifact = steps.find((step) => step.with?.name === "nanosync-android-debug")!;
  expect(artifact.with?.path).toBe("dist/android-debug/*");
  expect(artifact.with?.["if-no-files-found"]).toBe("error");
  const testArtifact = steps.find((step) => step.with?.name === "nanosync-android-test")!;
  expect(testArtifact.with?.path).toBe("apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk");
  expect(testArtifact.with?.["if-no-files-found"]).toBe("error");
  const prepare = steps.find((step) => step.name === "Prepare debug-signed APK (not production signed)")!;
  expect(prepare.run).toBeDefined();
  const directory = await mkdtemp(join(tmpdir(), "android-artifact-"));
  try {
    const apkDirectory = join(directory, "apps/android/app/build/outputs/apk/debug");
    await mkdir(apkDirectory, { recursive: true });
    await writeFile(join(apkDirectory, "app-debug.apk"), "abc");
    const result = Bun.spawnSync(["bash", "-euc", prepare.run!], { cwd: directory });
    expect(result.exitCode).toBe(0);
    const output = join(directory, "dist/android-debug");
    expect((await readdir(output)).sort()).toEqual([
      "nanosync-android-debug.apk", "nanosync-android-debug.apk.sha256",
    ]);
    expect(await readFile(join(output, "nanosync-android-debug.apk"), "utf8")).toBe("abc");
    expect(await readFile(join(output, "nanosync-android-debug.apk.sha256"), "utf8")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  nanosync-android-debug.apk\n",
    );
    await rm(join(apkDirectory, "app-debug.apk"));
    expect(Bun.spawnSync(["bash", "-euc", prepare.run!], { cwd: directory }).exitCode).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
