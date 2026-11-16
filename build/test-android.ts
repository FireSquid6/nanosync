import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { runServer } from "../packages/cli/src/server.ts";
import { api, bootstrapWorkflow, credentials, joinVault } from "../packages/cli/src/client.ts";
import { main } from "../packages/cli/src/main.ts";
import { SyncRunner } from "../packages/cli/src/sync-runner.ts";
import { createVault, key as vaultKey } from "../packages/cli/src/vault-client.ts";

// Explicit device selection prevents accidentally installing a test APK on a different phone.
const serial = process.env.ANDROID_SERIAL;
if (!serial) throw new Error("Set ANDROID_SERIAL to the disposable emulator/device to test. No device was modified.");
for (const tool of ["adb", "gradle", "bun"]) {
  if (!Bun.which(tool)) throw new Error(`Required tool missing: ${tool}. Enter the documented Nix Android environment first.`);
}
async function command(args: string[], quiet = false): Promise<string> {
  const child = Bun.spawn(args, { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (!quiet) process.stdout.write(stdout + stderr);
  if (code) throw new Error(`${args[0]} failed (${code}): ${stderr || stdout}`);
  return stdout;
}
const adb = (...args: string[]) => command(["adb", "-s", serial, ...args], true);
await adb("get-state");
const wifiBefore = (await adb("shell", "settings", "get", "global", "wifi_on")).trim();
const mobileBefore = (await adb("shell", "settings", "get", "global", "mobile_data")).trim();
await command(["gradle", "-p", "apps/android", ":app:assembleDebug", ":app:assembleDebugAndroidTest"]);
await adb("install", "-r", "apps/android/app/build/outputs/apk/debug/app-debug.apk");
await adb("install", "-r", "apps/android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk");
await adb("shell", "appops", "set", "org.nanosync.mobile", "MANAGE_EXTERNAL_STORAGE", "allow");
if (Number((await adb("shell", "getprop", "ro.build.version.sdk")).trim()) >= 33) {
  await adb("shell", "pm", "grant", "org.nanosync.mobile", "android.permission.POST_NOTIFICATIONS");
}

const directory = mkdtempSync(join(tmpdir(), "nanosync-android-e2e-"));
const serverDirectory = join(directory, "server"), owner = join(directory, "owner"), mobile = join(directory, "mobile"), files = join(directory, "files");
for (const dir of [serverDirectory, owner, mobile, files]) mkdirSync(dir, { mode: 0o700 });
const listener = createServer();
await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
const address = listener.address();
if (!address || typeof address === "string") throw new Error("Could not allocate test server port");
const port = address.port;
await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
writeFileSync(join(serverDirectory, "pepper.hex"), randomBytes(32).toString("hex"), { mode: 0o600 });
const server = await runServer({ directory: serverDirectory, port, scanIntervalMs: 3_600_000 });
const deviceRoot = `/sdcard/Download/nanosync-test-${randomUUID()}`;
const coordinatorRoot = `/sdcard/Download/nanosync-coordinator-test-${randomUUID()}`;
let reversed = false;
try {
  let recovery = "";
  const password = randomBytes(24).toString("base64url");
  await bootstrapWorkflow(owner, server.url, join(serverDirectory, "bootstrap.hex"), password, async value => { recovery = value; });
  const deviceId = randomUUID();
  if ((await joinVault(mobile, server.url, deviceId, password)).status !== "pending") throw new Error("Test enrollment was not pending");
  if (await main(["approve", deviceId, "--client-dir", owner])) throw new Error("Could not approve disposable test device");
  if ((await joinVault(mobile, server.url, deviceId, undefined, recovery)).status !== "approved") throw new Error("Test enrollment failed");
  const first = credentials(owner), second = credentials(mobile);
  // Bootstrap's legacy singleton is not an entry in the multi-vault listing.
  // Exercise a real registered vault, as the native Connect vault flow does.
  const registration = { version: 1 as const, serverId: randomUUID(), baseUrl: server.url,
    deviceId: first.deviceId, name: "Android fixture owner", token: first.token };
  const created = await createVault(owner, registration, "Android fixture", async secret => { recovery = secret; });
  const masterKey = vaultKey(owner, registration.serverId, created.vaultId);
  if (!masterKey) throw new Error("Could not recover disposable fixture vault key");
  const options = { clientDirectory: owner, syncDirectory: files, vaultId: created.vaultId, deviceId: first.deviceId,
    masterKey, baseUrl: server.url, token: first.token,
    scan: { debounceMs: 100, stabilityMs: 100 } };
  writeFileSync(join(files, "remote.txt"), "from second client\n");
  const seed = SyncRunner.start(options);
  try { await seed.syncOnce(); } finally { await seed.stop(); }
  await adb("reverse", `tcp:${port}`, `tcp:${port}`);
  reversed = true;
  await adb("shell", "mkdir", "-p", deviceRoot, coordinatorRoot);
  const deviceName = `android-e2e-${randomUUID()}`;
  const fixture = Buffer.from(JSON.stringify({
    deviceName, enrollmentPassword: password, coordinatorRoot,
    server: { baseUrl: `http://127.0.0.1:${port}`, token: second.token, deviceId: second.deviceId },
    vault: { id: randomUUID(), vaultId: created.vaultId, rootPath: deviceRoot, recoveryKey: recovery,
      effectiveMobileAllowed: false, mobilePolicy: "wifi" },
  })).toString("base64");
  let approving = true;
  const approval = (async () => {
    const deadline = Date.now() + 180_000;
    while (approving && Date.now() < deadline) {
      const pending = await api(server.url, "/v1/admin/enrollments", {}, first.token);
      for (const enrollment of pending.enrollments) {
        if (enrollment.displayName === deviceName) {
          await api(server.url, `/v1/admin/enrollments/${enrollment.deviceId}/approve`,
            { method: "POST", body: JSON.stringify({ protocolVersion: 1 }) }, first.token);
        }
      }
      await Bun.sleep(100);
    }
  })();
  let output: string;
  try {
    output = await adb("shell", "am", "instrument", "-w", "-e", "class",
      "org.nanosync.mobile.EngineIntegrationTest,org.nanosync.mobile.CoordinatorIntegrationTest", "-e", "fixture", fixture,
      "org.nanosync.mobile.test/androidx.test.runner.AndroidJUnitRunner");
  } finally { approving = false; await approval; }
  process.stdout.write(output);
  if (!/OK \(2 tests\)/u.test(output) || /FAILURES|INSTRUMENTATION_FAILED|Process crashed/u.test(output)) {
    throw new Error("Android real-server instrumentation did not pass");
  }
  const verify = SyncRunner.start(options);
  try { await verify.syncOnce(); } finally { await verify.stop(); }
  if (readFileSync(join(files, "android.txt"), "utf8") !== "from Android\n") throw new Error("Android upload did not converge on the second client");
  if (readFileSync(join(files, "coordinator.txt"), "utf8") !== "from native coordinator\n") throw new Error("Native coordinator upload did not converge on the second client");
  if (readFileSync(join(files, "background.txt"), "utf8") !== "screen-off background sync\n") throw new Error("Screen-off background upload did not converge on the second client");
  if (readFileSync(join(files, "job.txt"), "utf8") !== "bounded scheduled job\n") throw new Error("Bounded JobService upload did not converge on the second client");
  if (readFileSync(join(files, "mobile.txt"), "utf8") !== "one-time mobile exception\n") throw new Error("One-time mobile-data upload did not converge on the second client");
  console.log("PASS: native enrollment/approval, recovery, connection, external saves, paused manual upload, Wi-Fi-only/cellular exception, screen-off foreground/background job sync, disconnect preservation, and second-client convergence.");
} finally {
  if (wifiBefore === "0" || wifiBefore === "1") await adb("shell", "svc", "wifi", wifiBefore === "1" ? "enable" : "disable").catch(() => {});
  if (mobileBefore === "0" || mobileBefore === "1") await adb("shell", "svc", "data", mobileBefore === "1" ? "enable" : "disable").catch(() => {});
  if (reversed) await adb("reverse", "--remove", `tcp:${port}`).catch(() => {});
  await adb("shell", "rm", "-rf", deviceRoot, coordinatorRoot).catch(() => {});
  await server.stop();
  rmSync(directory, { recursive: true, force: true });
}
