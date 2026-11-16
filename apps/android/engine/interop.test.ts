import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { bootstrapWorkflow, credentials, joinVault } from "../../../packages/cli/src/client.ts";
import { main } from "../../../packages/cli/src/main.ts";
import { runServer } from "../../../packages/cli/src/server.ts";
import { HttpRemote } from "../../../packages/sync-core/src/index.ts";
import { TestHost } from "./host.test-helper.ts";
import type { RunContext } from "./runtime.ts";
const dirs: string[] = [], servers: { stop(): Promise<void> }[] = [];
afterEach(async () => { for (const s of servers.splice(0)) await s.stop(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function temp() { const dir = mkdtempSync(join(tmpdir(), "nanosync-android-")); dirs.push(dir); return dir; }
async function fixture() {
  const listener = createServer(); await new Promise<void>(r => listener.listen(0, "127.0.0.1", r));
  const port = (listener.address() as { port: number }).port; await new Promise<void>(r => listener.close(() => r()));
  const serverDir = temp(), cliDir = temp(), cliFiles = temp(), androidFiles = temp(), androidPrivate = temp(), enrollment = temp();
  writeFileSync(join(serverDir, "pepper.hex"), "a".repeat(64), { mode: 0o600 });
  const server = await runServer({ directory: serverDir, port, scanIntervalMs: 3600000 }); servers.push(server);
  let recovery = "";
  await bootstrapWorkflow(cliDir, server.url, join(serverDir, "bootstrap.hex"), "test password", async text => { recovery = text; });
  const androidId = crypto.randomUUID();
  await joinVault(enrollment, server.url, androidId, "test password");
  expect(await main(["approve", androidId, "--client-dir", cliDir])).toBe(0);
  await joinVault(enrollment, server.url, androidId, undefined, recovery);
  const creds = credentials(enrollment);
  const context: RunContext = { server: { baseUrl: server.url, token: creds.token, deviceId: creds.deviceId }, vault: { id: crypto.randomUUID(), vaultId: creds.vaultId, rootPath: androidFiles, masterKeyHex: creds.masterKey, effectiveMobileAllowed: false }, allowHttp: true };
  const host = new TestHost(androidFiles, androidPrivate, fetch, server.url);
  const cli = async () => { expect(await main(["sync", "--client-dir", cliDir, "--sync-dir", cliFiles])).toBe(0); };
  const remote = new HttpRemote({ baseUrl: server.url, token: creds.token, vaultId: creds.vaultId, fetch });
  return { host, context, cli, cliFiles, androidFiles, androidPrivate, remote, recovery };
}

test("Android populated-folder import interoperates both ways with CLI; exclusions and rename identity survive", async () => {
  const e = await fixture();
  writeFileSync(join(e.cliFiles, "desktop"), "from CLI"); await e.cli();
  writeFileSync(join(e.androidFiles, "phone"), "from Android");
  writeFileSync(join(e.androidFiles, ".nanosyncignore"), "ignored/\n");
  mkdirSync(join(e.androidFiles, "ignored")); symlinkSync("missing", join(e.androidFiles, "ignored", "link"));
  const result = await e.host.run(e.context);
  expect(result.exclusionsActive).toBe(true); expect(result.pendingDownloads).toBe(0);
  expect(readFileSync(join(e.androidFiles, "desktop"), "utf8")).toBe("from CLI");
  expect(e.host.calls.some(c => c.args.path === "ignored" && c.method === "listDirectory")).toBe(false);
  await e.cli(); expect(readFileSync(join(e.cliFiles, "phone"), "utf8")).toBe("from Android");
  const initial = await e.remote.manifest(result.revisionId, Buffer.from(e.context.vault.masterKeyHex!, "hex"));
  const id = initial.manifest.entries.find(e => e.name === "phone")!.id;
  renameSync(join(e.androidFiles, "phone"), join(e.androidFiles, "renamed"));
  const renamed = await e.host.run(e.context); await e.cli();
  expect(readFileSync(join(e.cliFiles, "renamed"), "utf8")).toBe("from Android");
  const next = await e.remote.manifest(renamed.revisionId, Buffer.from(e.context.vault.masterKeyHex!, "hex"));
  expect(next.manifest.entries.find(e => e.name === "renamed")!.id).toBe(id);
  expect(next.manifest.entries.some(e => e.name === "ignored")).toBe(false);
}, 30000);

test("concurrent CLI and Android edits preserve both conflict versions", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "note"), "base"); await e.cli(); await e.host.run(e.context);
  writeFileSync(join(e.cliFiles, "note"), "desktop edit"); await e.cli();
  writeFileSync(join(e.androidFiles, "note"), "phone edit");
  const result = await e.host.run(e.context); expect(result.conflicts.length).toBe(1);
  const copies = [readFileSync(join(e.androidFiles, "note"), "utf8"), ...result.conflicts.map((p: string) => readFileSync(join(e.androidFiles, p), "utf8"))];
  expect(new Set(copies)).toEqual(new Set(["phone edit", "desktop edit"])); await e.cli();
}, 30000);

test("durable apply resumes after crash without redownloading a completed chunk; permission errors block", async () => {
  const e = await fixture(); await e.host.run(e.context);
  const bytes = Buffer.alloc(4194304 + 19, 6); writeFileSync(join(e.cliFiles, "big"), bytes); await e.cli();
  let writes = 0;
  e.host.failure = (method, args) => { if (method === "stageWrite" && args.offset > 0 && ++writes === 1) throw new Error("injected crash"); };
  await expect(e.host.run(e.context)).rejects.toThrow("injected crash");
  const before = e.host.calls.filter(c => c.method === "http" && c.args.method === "GET" && c.args.path.includes("/objects/chunk/")).length;
  const state = JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8"));
  const stage = Object.values(state.applies[0].files)[0] as { id: string };
  writeFileSync(join(e.androidPrivate, stage.id), Buffer.alloc(4194304, 7));
  const corrupted = new TestHost(e.androidFiles, e.androidPrivate, fetch, e.context.server.baseUrl);
  await expect(corrupted.run(e.context)).rejects.toThrow("persisted stage chunk corrupted");
  writeFileSync(join(e.androidPrivate, stage.id), bytes.subarray(0, 4194304));
  const resumed = new TestHost(e.androidFiles, e.androidPrivate, fetch, e.context.server.baseUrl);
  await resumed.run(e.context);
  expect(readFileSync(join(e.androidFiles, "big"))).toEqual(bytes);
  const finished = JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8"));
  expect(finished.garbage).toHaveLength(0);
  expect(readdirSync(e.androidPrivate).sort()).toEqual(["state", ...Object.values(finished.chunks).map((c: any) => c.id)].sort());
  expect(before).toBe(2);
  expect(resumed.calls.filter(c => c.method === "http" && c.args.method === "GET" && c.args.path.includes("/objects/chunk/"))).toHaveLength(0);
  resumed.failure = method => { if (method === "listDirectory") throw new Error("permission denied"); };
  await expect(resumed.run(e.context)).rejects.toThrow("permission denied");
  expect(readFileSync(join(e.androidFiles, "big"))).toEqual(bytes);
}, 30000);

test("recovery unwrap returns only the master key and does not create a synchronization journal", async () => {
  const e = await fixture();
  const result = await e.host.run({ ...e.context, vault: { ...e.context.vault, masterKeyHex: undefined, recoveryKey: e.recovery } });
  expect(result).toEqual({ masterKeyHex: e.context.vault.masterKeyHex });
  expect(e.host.calls.every(c => c.method === "http")).toBe(true);
}, 30000);

test("capacity and guarded commit failures retain the old file and applied head", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "note"), "old"); await e.cli();
  const original = await e.host.run(e.context);
  writeFileSync(join(e.cliFiles, "note"), "new data"); await e.cli();
  e.host.availableBytes = 0;
  await expect(e.host.run(e.context)).rejects.toThrow("insufficient storage");
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("old");
  expect(JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8")).heads.applied.revisionId).toBe(original.revisionId);
  e.host.availableBytes = 1e12;
  e.host.failure = method => { if (method === "stageCommit") throw new Error("atomic replacement denied"); };
  await expect(e.host.run(e.context)).rejects.toThrow("atomic replacement denied");
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("old");
  e.host.failure = undefined; await e.host.run(e.context);
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("new data");
}, 30000);

test("local edits during download cancel an unmutated apply and retry merges both versions", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "note"), "old"); await e.cli(); await e.host.run(e.context);
  writeFileSync(join(e.cliFiles, "note"), "new remote content"); await e.cli();
  let edited = false;
  e.host.failure = method => { if (method === "stageDigest" && !edited) { edited = true; writeFileSync(join(e.androidFiles, "note"), "concurrent local content"); } };
  await expect(e.host.run(e.context)).rejects.toThrow("local path changed");
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("concurrent local content");
  expect(JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8")).applies).toHaveLength(0);
  e.host.failure = undefined;
  const recovered = await e.host.run(e.context);
  const contents = [readFileSync(join(e.androidFiles, "note"), "utf8"), ...recovered.conflicts.map((p: string) => readFileSync(join(e.androidFiles, p), "utf8"))];
  expect(new Set(contents)).toEqual(new Set(["concurrent local content", "new remote content"]));
}, 30000);

test("tracked exclusions remain remote and do not become deletions when another file uploads", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "excluded"), "remote content"); await e.cli(); await e.host.run(e.context);
  writeFileSync(join(e.androidFiles, ".nanosyncignore"), "excluded\n");
  writeFileSync(join(e.androidFiles, "excluded"), "private edit");
  writeFileSync(join(e.androidFiles, "public"), "visible");
  await e.host.run(e.context); await e.cli();
  expect(readFileSync(join(e.cliFiles, "excluded"), "utf8")).toBe("remote content");
  expect(readFileSync(join(e.androidFiles, "excluded"), "utf8")).toBe("private edit");
  expect(readFileSync(join(e.cliFiles, "public"), "utf8")).toBe("visible");
}, 30000);

test("nested directory rename and deletion converge without recursively deleting untracked files", async () => {
  const e = await fixture(); mkdirSync(join(e.androidFiles, "dir")); writeFileSync(join(e.androidFiles, "dir", "file"), "content");
  await e.host.run(e.context); await e.cli();
  renameSync(join(e.androidFiles, "dir"), join(e.androidFiles, "moved"));
  await e.host.run(e.context); await e.cli();
  expect(readFileSync(join(e.cliFiles, "moved", "file"), "utf8")).toBe("content");
  rmSync(join(e.androidFiles, "moved"), { recursive: true });
  await e.host.run(e.context); await e.cli();
}, 30000);

test("async scan commit catches edits after publication acceptance before advancing applied head", async () => {
  const e = await fixture(); const original = await e.host.run(e.context);
  writeFileSync(join(e.androidFiles, "note"), "published version");
  let changed = false;
  const host = new TestHost(e.androidFiles, e.androidPrivate, async request => {
    const response = await fetch(request);
    if (!changed && new URL(request.url).pathname === "/v1/head/advance" && response.status === 200) {
      changed = true; writeFileSync(join(e.androidFiles, "note"), "edited after acceptance");
    }
    return response;
  }, e.context.server.baseUrl);
  await expect(host.run(e.context)).rejects.toThrow("changed before scan commit");
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("edited after acceptance");
  const state = JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8"));
  expect(state.heads.applied.revisionId).toBe(original.revisionId);
  expect(state.proposal.state).toBe("accepted");
}, 30000);

test("file-directory-file topology transitions stage content before guarded removal", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "node"), "old file"); await e.cli(); await e.host.run(e.context);
  rmSync(join(e.cliFiles, "node")); mkdirSync(join(e.cliFiles, "node")); writeFileSync(join(e.cliFiles, "node", "child"), "nested"); await e.cli();
  const start = e.host.calls.length; await e.host.run(e.context);
  expect(readFileSync(join(e.androidFiles, "node", "child"), "utf8")).toBe("nested");
  const calls = e.host.calls.slice(start);
  expect(calls.findIndex(c => c.method === "stageDigest")).toBeLessThan(calls.findIndex(c => c.method === "remove"));
  rmSync(join(e.cliFiles, "node"), { recursive: true }); writeFileSync(join(e.cliFiles, "node"), "replacement file"); await e.cli();
  await e.host.run(e.context); expect(readFileSync(join(e.androidFiles, "node"), "utf8")).toBe("replacement file");
}, 30000);

test("directory-to-file replacement never removes ignored or untracked child content", async () => {
  const e = await fixture(); mkdirSync(join(e.cliFiles, "node")); writeFileSync(join(e.cliFiles, "node", "tracked"), "tracked"); await e.cli(); await e.host.run(e.context);
  writeFileSync(join(e.androidFiles, ".nanosyncignore"), "node/private\n"); writeFileSync(join(e.androidFiles, "node", "private"), "never delete");
  rmSync(join(e.cliFiles, "node"), { recursive: true }); writeFileSync(join(e.cliFiles, "node"), "replacement"); await e.cli();
  await expect(e.host.run(e.context)).rejects.toThrow();
  expect(readFileSync(join(e.androidFiles, "node", "private"), "utf8")).toBe("never delete");
}, 30000);

test("partial-apply edit has actionable move-aside recovery without clearing the journal", async () => {
  const e = await fixture();
  for (const name of ["a", "b"]) writeFileSync(join(e.cliFiles, name), "old");
  await e.cli(); await e.host.run(e.context);
  for (const name of ["a", "b"]) writeFileSync(join(e.cliFiles, name), "remote replacement");
  await e.cli();
  let editedPath = "";
  e.host.failure = (method, args) => {
    if (method === "stageCommit" && !editedPath) {
      editedPath = args.path === "a" ? "b" : "a";
      writeFileSync(join(e.androidFiles, editedPath), "precious concurrent edit");
    }
  };
  await expect(e.host.run(e.context)).rejects.toThrow("Move the edited path outside this vault, then retry");
  expect(readFileSync(join(e.androidFiles, editedPath), "utf8")).toBe("precious concurrent edit");
  e.host.failure = undefined;
  const saved = join(temp(), "saved-edit"); renameSync(join(e.androidFiles, editedPath), saved);
  await e.host.run(e.context);
  expect(readFileSync(saved, "utf8")).toBe("precious concurrent edit");
  for (const name of ["a", "b"]) expect(readFileSync(join(e.androidFiles, name), "utf8")).toBe("remote replacement");
  expect(JSON.parse(readFileSync(join(e.androidPrivate, "state"), "utf8")).applies).toHaveLength(0);
}, 30000);

test("Android deduplicates repeated file content frames during publication", async () => {
  const e = await fixture();
  for (const name of ["copy-a", "copy-b"]) writeFileSync(join(e.androidFiles, name), "identical content");
  await e.host.run(e.context); await e.cli();
  for (const name of ["copy-a", "copy-b"]) expect(readFileSync(join(e.cliFiles, name), "utf8")).toBe("identical content");
}, 30000);

test("ignore policy changed during staging blocks overwrite and safely replans on retry", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "note"), "old local bytes"); await e.cli(); await e.host.run(e.context);
  writeFileSync(join(e.cliFiles, "note"), "new remote bytes"); await e.cli();
  e.host.failure = method => { if (method === "stageDigest") writeFileSync(join(e.androidFiles, ".nanosyncignore"), "note\n"); };
  await expect(e.host.run(e.context)).rejects.toThrow("ignore policy changed");
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("old local bytes");
  e.host.failure = undefined; const result = await e.host.run(e.context);
  expect(result.exclusionsActive).toBe(true);
  expect(readFileSync(join(e.androidFiles, "note"), "utf8")).toBe("old local bytes");
}, 30000);

test("ignore policy is revalidated before every commit and pinned across partial apply restart", async () => {
  const e = await fixture();
  for (const name of ["a", "b"]) writeFileSync(join(e.cliFiles, name), "old");
  await e.cli(); await e.host.run(e.context);
  for (const name of ["a", "b"]) writeFileSync(join(e.cliFiles, name), "remote replacement");
  await e.cli(); let excluded = "";
  e.host.failure = (method, args) => {
    if (method === "stageCommit" && !excluded) { excluded = args.path === "a" ? "b" : "a"; writeFileSync(join(e.androidFiles, ".nanosyncignore"), `${excluded}\n`); }
  };
  await expect(e.host.run(e.context)).rejects.toThrow("Restore the previous .nanosyncignore rules");
  expect(readFileSync(join(e.androidFiles, excluded), "utf8")).toBe("old");
  e.host.failure = undefined;
  const resumed = new TestHost(e.androidFiles, e.androidPrivate, fetch, e.context.server.baseUrl);
  await expect(resumed.run(e.context)).rejects.toThrow("Restore the previous .nanosyncignore rules");
  rmSync(join(e.androidFiles, ".nanosyncignore")); await resumed.run(e.context);
  for (const name of ["a", "b"]) expect(readFileSync(join(e.androidFiles, name), "utf8")).toBe("remote replacement");
}, 30000);

test("legacy Request without body streams still downloads and publishes through the real server", async () => {
  const e = await fixture(); writeFileSync(join(e.cliFiles, "desktop"), "remote bytes"); await e.cli();
  const ModernRequest = globalThis.Request;
  class LegacyRequest extends ModernRequest {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
      if (init?.body instanceof ReadableStream) throw new Error("legacy Request cannot accept streams");
      super(input, init); Object.defineProperty(this, "body", { value: undefined });
    }
  }
  globalThis.Request = LegacyRequest as typeof Request;
  try {
    await e.host.run(e.context);
    expect(readFileSync(join(e.androidFiles, "desktop"), "utf8")).toBe("remote bytes");
    writeFileSync(join(e.androidFiles, "phone"), new Uint8Array([0, 255, 128, 1]));
    await e.host.run(e.context);
  } finally { globalThis.Request = ModernRequest; }
  await e.cli(); expect(readFileSync(join(e.cliFiles, "phone"))).toEqual(Buffer.from([0, 255, 128, 1]));
}, 30000);
