import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, chmodSync, rmSync, writeFileSync, readFileSync, symlinkSync, unlinkSync, existsSync, lstatSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";
import { runServer } from "../src/server.ts";
import { secureInstall, secureRead } from "../src/security.ts";
import { api, bootstrapWorkflow, enroll, login, saveCredentials, joinVault } from "../src/client.ts";
import { encryptManifest, generateRecoverySecret, generateVaultMasterKey, wrapMasterKey, referenceSetMac, displayRecoverySecret, HttpRemote } from "@nanosync/sync-core";
import { startDaemon, stopDaemon, daemonCommand } from "@nanosync/linux-daemon";
import { hydrateFile } from "../../linux-client/src/hydration.ts";
import { parsePersistedRevisionEnvelope } from "@nanosync/protocol";
import { ClientLocal } from "../../client-local/src/index.ts";

const roots: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "nanosync-cli-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("CLI rejects unknown flags and missing args", async () => {
  expect(await main(["--help"])).toBe(0);
  expect(await main(["--bogus", "status"])).toBe(2);
  expect(await main(["restore"])).toBe(2);
  expect(await main(["evict"])).toBe(2);
  expect(await main(["download"])).toBe(2);
  expect(await main(["resolve", "copy"])).toBe(2);
  expect(await main(["resolve", "copy", "--confirm-discard", "--confirm-discard"])).toBe(2);
});

test("CLI maps typed local daemon failures to stable process codes", async () => {
  const root = directory(); chmodSync(root, 0o700);
  writeFileSync(join(root, "ipc.secret"), "a".repeat(64), { mode: 0o600 });
  let state = "auth_required";
  const server = Bun.serve({ unix: join(root, "daemon.sock"), fetch: () => Response.json({ error: "arbitrary message", state }, { status: 409 }) });
  try {
    for (const [category, code] of [["auth_required", 3], ["offline", 5], ["integrity_failure", 6],
      ["capacity_incomplete", 7], ["conflict_blocked", 8]] as const) {
      state = category;
      expect(await main(["status", "--client-dir", root, "--json"])).toBe(code);
    }
  } finally { server.stop(true); }
  expect(await main(["status", "--client-dir", root])).toBe(5);
});

test("server init provisions owner-only secrets and refuses overwrite", async () => {
  const root = directory(); chmodSync(root, 0o700);
  expect(await main(["server", "init", "--server-dir", root])).toBe(0);
  expect(secureRead(join(root, "pepper.hex"))).toHaveLength(64);
  expect(secureRead(join(root, "bootstrap.hex"))).toHaveLength(64);
  expect(await main(["server", "init", "--server-dir", root])).toBe(2);
});

test("credential installation is no-replace, including a preexisting destination", () => {
  const root = directory(), path = join(root, "client.json");
  secureInstall(path, "original");
  expect(() => secureInstall(path, "replacement")).toThrow(/EEXIST/);
  expect(secureRead(path).toString("utf8")).toBe("original");
  expect(lstatSync(path).mode & 0o777).toBe(0o600);
});

test("server requires provisioned pepper and rejects unsafe credentials", async () => {
  const root = directory(); chmodSync(root, 0o700);
  await expect(runServer({ directory: root, port: 7538 })).rejects.toThrow();
  writeFileSync(join(root, "pepper.hex"), "a".repeat(64), { mode: 0o644 });
  await expect(runServer({ directory: root, port: 7538 })).rejects.toThrow(/secret file/);
  chmodSync(join(root, "pepper.hex"), 0o600);
  const server = await runServer({ directory: root, port: 7538, scanIntervalMs: 20 });
  try {
    expect(server.url).toContain("127.0.0.1");
    expect((await (await fetch(`${server.url}v1/bootstrap/status`)).json()).status).toBe("uninitialized");
    expect(secureRead(join(root, "bootstrap.hex"))).toHaveLength(64);
    const denied = await fetch(`${server.url}v1/bootstrap/initialize`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(denied.status).toBe(401);
  } finally { await server.stop(); }
});

test("non-loopback exposure requires acknowledgement", async () => {
  const root = directory(); chmodSync(root, 0o700);
  writeFileSync(join(root, "pepper.hex"), "a".repeat(64), { mode: 0o600 });
  await expect(runServer({ directory: root, host: "0.0.0.0", port: 7539 })).rejects.toThrow(/acknowledgement/);
});

for (const [route, port] of [["/v1/bootstrap/initialize", 7541], ["/v1/bootstrap/complete", 7542], ["/v1/bootstrap/objects/manifest/", 7543]] as const) {
  test(`bootstrap checkpoint replays identical genesis after dropped ${route} response`, async () => {
    const serverDir = directory(); chmodSync(serverDir, 0o700);
    writeFileSync(join(serverDir, "pepper.hex"), randomBytes(32).toString("hex"), { mode: 0o600 });
    const server = await runServer({ directory: serverDir, port });
    const clientDir = directory(), password = "checkpoint-test-password", proof = join(serverDir, "bootstrap.hex");
    let confirmations = 0, lost = false;
    const nativeFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (!lost && String(input).includes(route) && init?.method === (route.includes("objects") ? "PUT" : "POST")) { lost = true; throw new TypeError("injected lost bootstrap response"); }
      return response;
    }) as typeof fetch;
    try {
      await expect(bootstrapWorkflow(clientDir, server.url, proof, password, async display => {
        expect(display).toMatch(/^[a-z2-7-]+$/); confirmations++;
      })).rejects.toThrow(/lost bootstrap response/);
      expect(lost).toBe(true);
      const checkpointPath = join(clientDir, "bootstrap.checkpoint");
      expect(lstatSync(checkpointPath).mode & 0o777).toBe(0o600);
      const checkpoint = JSON.parse(secureRead(checkpointPath, 16384).toString("utf8"));
      expect(JSON.stringify(checkpoint)).not.toContain(password);
      expect(Object.keys(checkpoint).some(key => /password|verifier|digest|mac/i.test(key))).toBe(false);
      globalThis.fetch = nativeFetch;
      await expect(bootstrapWorkflow(clientDir, server.url, proof, "wrong password", async () => { throw new Error("unexpected confirmation"); }))
        .rejects.toThrow(/server 401/);
      expect(JSON.parse(secureRead(checkpointPath, 16384).toString("utf8")).genesisRevision.revisionId).toBe(checkpoint.genesisRevision.revisionId);
      expect((await api(server.url, "/v1/bootstrap/status")).status).toBe("sealed");
      const result = await bootstrapWorkflow(clientDir, server.url, proof, password, async () => { confirmations++; throw new Error("recovery shown twice"); });
      expect(result).toEqual({ vaultId: checkpoint.vaultId, deviceId: checkpoint.deviceId });
      expect(confirmations).toBe(1);
      expect(existsSync(checkpointPath)).toBe(false);
      expect((await api(server.url, "/v1/bootstrap/status")).status).toBe("sealed");
      expect(JSON.parse(secureRead(join(clientDir, "client.json")).toString("utf8")).masterKey).toBe(checkpoint.masterKey);
    } finally { globalThis.fetch = nativeFetch; await server.stop(); }
  });
}

test("runtime server accepts encrypted genesis, approves second device, and revokes it", async () => {
  const root = directory(); chmodSync(root, 0o700);
  writeFileSync(join(root, "pepper.hex"), randomBytes(32).toString("hex"), { mode: 0o600 });
  const server = await runServer({ directory: root, port: 7540, scanIntervalMs: 100 });
  const url = server.url, proof = secureRead(join(root, "bootstrap.hex")).toString("utf8");
  const vaultId = randomUUID(), principalId = randomUUID(), deviceId = randomUUID(), revisionId = randomUUID();
  const master = generateVaultMasterKey(), recovery = generateRecoverySecret(), password = "test-only-password";
  const manifest = { version: 1 as const, vaultId, revisionId, parents: [], creatingDeviceId: deviceId,
    entries: [{ id: randomUUID(), parentId: null, name: "", kind: "directory" as const }] };
  const encrypted = await encryptManifest(manifest, master);
  const unsigned = { protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId, parents: [], creatingDeviceId: deviceId,
    createdAt: new Date().toISOString(), encryptedManifestObjectId: encrypted.reference.objectId, references: [encrypted.reference], referenceSetMac: "0".repeat(64) };
  try {
    await api(url, "/v1/bootstrap/initialize", { method: "POST", body: JSON.stringify({ protocolVersion: 1, principalId, vaultId,
      initialDeviceId: deviceId, password, recoveryWrap: await wrapMasterKey(master, recovery, vaultId) }) }, undefined, proof);
    const frame = encrypted.frame;
    const upload = await fetch(`${url}v1/bootstrap/objects/manifest/${encrypted.reference.objectId}`, { method: "PUT", headers: {
      "x-nanosync-bootstrap-authorization": proof, "x-nanosync-protocol-version": "1", "x-nanosync-object-format-version": "1",
      "x-nanosync-ciphertext-sha256": createHash("sha256").update(frame).digest("hex"), "idempotency-key": randomBytes(32).toString("hex"),
      "content-length": String(frame.length) }, body: Buffer.from(frame) });
    expect(upload.status).toBe(201);
    const genesisRevision = { ...unsigned, referenceSetMac: await referenceSetMac(parsePersistedRevisionEnvelope(unsigned), master) };
    expect((await api(url, "/v1/bootstrap/complete", { method: "POST", body: JSON.stringify({ protocolVersion: 1, vaultId, genesisRevision }) }, undefined, proof)).sequence).toBe(1);
    const adminToken = await login(url, password);
    expect((await enroll(url, adminToken, deviceId, proof)).status).toBe("approved");
    const adminDir = directory();
    saveCredentials(adminDir, { baseUrl: url, vaultId, deviceId, token: adminToken, masterKey: Buffer.from(master).toString("hex") });
    for (const command of ["storage", "retention-dry-run", "gc-dry-run", "scan", "diagnostics"]) {
      expect(await main(["admin", command, "--client-dir", adminDir, "--json"])).toBe(0);
    }
    expect(await main(["admin", "collect", "--client-dir", adminDir])).toBe(2);
    const second = randomUUID(), secondDir = directory();
    const nativeFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (!dropped && String(input).includes("/v1/auth/enrollments") && init?.method === "POST") {
        dropped = true; throw new TypeError("injected lost enrollment response");
      }
      return response;
    }) as typeof fetch;
    try { await expect(joinVault(secondDir, url, second, password)).rejects.toThrow(/lost enrollment response/); }
    finally { globalThis.fetch = nativeFetch; }
    const pending = JSON.parse(secureRead(join(secondDir, "enrollment.json")).toString("utf8"));
    expect((await joinVault(secondDir, url, second, undefined)).status).toBe("pending");
    expect(JSON.parse(secureRead(join(secondDir, "enrollment.json")).toString("utf8"))).toEqual(pending);
    expect((await api(url, "/v1/admin/enrollments", {}, adminToken)).enrollments).toHaveLength(1);
    await api(url, `/v1/admin/enrollments/${second}/approve`, { method: "POST", body: JSON.stringify({ protocolVersion: 1 }) }, adminToken);
    expect((await joinVault(secondDir, url, second, undefined, await displayRecoverySecret(recovery))).status).toBe("approved");
    const client = directory(), sync = directory();
    saveCredentials(client, { baseUrl: url, vaultId, deviceId, token: adminToken, masterKey: Buffer.from(master).toString("hex") });
    const daemonOptions = { clientDirectory: client, syncDirectory: sync, vaultId, deviceId, masterKey: master, baseUrl: url, token: adminToken, pollMs: 3_600_000 };
    let daemon = await startDaemon(daemonOptions);
    try {
      expect((await daemonCommand(client, "sync")).applied.sequence).toBe(1);
      expect((await daemonCommand(client, "history")).length).toBe(1);
      expect((await daemonCommand(client, "conflicts"))).toEqual([]);
      writeFileSync(join(sync, "note.txt"), "original", { mode: 0o600 }); chmodSync(join(sync, "note.txt"), 0o600);
      await daemonCommand(client, "sync");
      const first = (await daemonCommand(client, "status")).applied.revisionId;
      writeFileSync(join(sync, "note.txt"), "updated");
      await daemonCommand(client, "sync");
      const unchangedHead = (await daemonCommand(client, "status")).applied;
      chmodSync(join(sync, "note.txt"), 0o622);
      await expect(daemonCommand(client, "evict", { path: "note.txt" })).rejects.toThrow(/unsafe hydration file/);
      expect(readFileSync(join(sync, "note.txt"), "utf8")).toBe("updated");
      chmodSync(join(sync, "note.txt"), 0o600);
      const finish = ClientLocal.prototype.finishHydration;
      ClientLocal.prototype.finishHydration = function (...args) { ClientLocal.prototype.finishHydration = finish; throw new Error("injected crash before hydration metadata commit"); };
      try { await expect(daemonCommand(client, "evict", { path: "note.txt" })).rejects.toThrow(/injected crash/); }
      finally { ClientLocal.prototype.finishHydration = finish; }
      await stopDaemon(daemon); daemon = await startDaemon(daemonOptions);
      await daemonCommand(client, "sync");
      expect((await daemonCommand(client, "status")).remoteOnlyFiles).toBe(1);
      expect((await daemonCommand(client, "status")).applied).toEqual(unchangedHead);
      symlinkSync("/etc/passwd", join(sync, "note.txt"));
      try { await expect(daemonCommand(client, "download", { path: "note.txt" })).rejects.toThrow(/unsafe filesystem entry|already exists/); }
      finally { unlinkSync(join(sync, "note.txt")); }
      await stopDaemon(daemon);
      const local = new ClientLocal(client, vaultId, deviceId);
      try {
        const remote = new HttpRemote({ baseUrl: url, token: adminToken, fetch, journal: local });
        const authenticated = await remote.manifest(unchangedHead.revisionId, master);
        await expect(hydrateFile(sync, local, remote, authenticated.manifest, authenticated.revision, master,
          "download", "note.txt", undefined, { afterLink: () => { throw new Error("injected process exit with two links"); } }))
          .rejects.toThrow(/two links/);
        expect(lstatSync(join(sync, "note.txt")).nlink).toBe(2);
      } finally { local.close(); }
      daemon = await startDaemon(daemonOptions); // Replay before watcher rejects the nlink=2 stage.
      await daemonCommand(client, "sync");
      expect((await daemonCommand(client, "status")).downloadedFiles).toBe(1);
      await daemonCommand(client, "evict", { path: "note.txt" });
      ClientLocal.prototype.finishHydration = function (...args) { ClientLocal.prototype.finishHydration = finish; throw new Error("injected crash after downloaded file installation"); };
      try { await expect(daemonCommand(client, "download", { path: "note.txt" })).rejects.toThrow(/injected crash/); }
      finally { ClientLocal.prototype.finishHydration = finish; }
      await stopDaemon(daemon); daemon = await startDaemon(daemonOptions);
      await daemonCommand(client, "sync");
      expect((await daemonCommand(client, "status")).downloadedFiles).toBe(1);
      expect(readFileSync(join(sync, "note.txt"), "utf8")).toBe("updated");
      expect((await daemonCommand(client, "status")).applied).toEqual(unchangedHead);
      await expect(daemonCommand(client, "evict", { path: "../unsafe" })).rejects.toThrow(/invalid relative path/);
      const accept = ClientLocal.prototype.acceptProposal;
      ClientLocal.prototype.acceptProposal = function (sequence) { accept.call(this, sequence); ClientLocal.prototype.acceptProposal = accept; throw new Error("injected crash after restore acceptance"); };
      try { await expect(daemonCommand(client, "restore", { revision: first, path: "note.txt" })).rejects.toThrow(/injected crash/); }
      finally { ClientLocal.prototype.acceptProposal = accept; }
      await stopDaemon(daemon); daemon = await startDaemon(daemonOptions);
      await daemonCommand(client, "sync");
      expect((await daemonCommand(client, "status")).applied.sequence).toBeGreaterThan(2);
      expect(readFileSync(join(sync, "note.txt"), "utf8")).toBe("original");
      writeFileSync(join(sync, "empty.txt"), "", { mode: 0o600 }); chmodSync(join(sync, "empty.txt"), 0o600);
      await daemonCommand(client, "sync");
      const emptyHead = (await daemonCommand(client, "status")).applied;
      expect(await main(["evict", "empty.txt", "--client-dir", client])).toBe(0);
      expect(await main(["download", "empty.txt", "--client-dir", client])).toBe(0);
      expect(readFileSync(join(sync, "empty.txt"), "utf8")).toBe("");
      expect((await daemonCommand(client, "status")).applied).toEqual(emptyHead);
    } finally { await stopDaemon(daemon); }
    const other = JSON.parse(secureRead(join(secondDir, "client.json")).toString("utf8"));
    expect((await api(url, "/v1/head", {}, other.token)).sequence).toBe(5);
    expect(await main(["admin", "storage", "--client-dir", secondDir])).toBe(3);
    await api(url, `/v1/admin/devices/${second}/revoke`, { method: "POST", body: JSON.stringify({ protocolVersion: 1 }) }, adminToken);
    expect(await main(["admin", "storage", "--client-dir", secondDir])).toBe(3);
    await expect(api(url, "/v1/head", {}, other.token)).rejects.toThrow(/401/);
  } finally { await server.stop(); }
});
