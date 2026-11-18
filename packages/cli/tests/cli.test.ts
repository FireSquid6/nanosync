import { secureInstall, secureRead, api, login } from '@nanosync/client-service';
import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, chmodSync, rmSync, writeFileSync, existsSync, lstatSync } from "node:fs";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/main.ts";
import { runServer } from "../src/server.ts";
import { bootstrapWorkflow, enroll, saveCredentials, joinVault } from "./support/legacy-fixture.ts";
import { encryptManifest, generateRecoverySecret, generateVaultMasterKey, wrapMasterKey, referenceSetMac, displayRecoverySecret } from "@nanosync/sync-core";
import { parsePersistedRevisionEnvelope } from "@nanosync/protocol";

const roots: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), "nanosync-cli-")); roots.push(path); return path; }
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }); });

test("CLI help lists foreground sync and rejects removed local service commands", async () => {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await main(["--help"])).toBe(0);
    const help = stdout.mock.calls.flat().join("");
    for (const name of ["server", "client"]) {
      expect(help).toContain(name);
    }
    expect(await main(["client", "sync", "--help"])).toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("--watch");
    for (const name of ["daemon", "status", "pause", "resume", "history", "restore", "resolve", "conflicts", "doctor", "evict", "download"]) {
      expect(help).not.toMatch(new RegExp(`^\\s+${name}\\s`, "m"));
      expect(await main([name, '--json'])).toBe(2);
      expect(JSON.parse(String(stderr.mock.lastCall?.[0]))).toMatchObject({ ok: false, exitCode: 2 });
    }
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});

test("Commander help and validation preserve structured errors across repeated main calls", async () => {
  const stdout = spyOn(process.stdout, "write").mockImplementation(() => true);
  const stderr = spyOn(console, "error").mockImplementation(() => {});
  try {
    expect(await main(["server", "run", "--help"])).toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("--acknowledge-exposure");
    expect(await main(["client", "connections", "add", "--help"])).toBe(0);
    expect(stdout.mock.calls.flat().join("")).toContain("--client-dir");
    expect(await main(["help"])).toBe(0);
    for (const args of [
      ["devices", "--unexpected"], ["devices", "--json", "--json"],
      ["--client-dir", "/unused", "devices", "--client-dir", "/unused"],
      ["admin", "scan", "--client-dir"], ["approve"], ["revoke", "one", "two"]
    ]) {
      expect(await main(args.includes('--json') ? args : [...args, '--json'])).toBe(2);
      expect(JSON.parse(String(stderr.mock.lastCall?.[0]))).toMatchObject({ ok: false, exitCode: 2 });
    }
    const prior = process.env.NANOSYNC_PASSWORD;
    process.env.NANOSYNC_PASSWORD = "owner-password-for-tests";
    try {
      expect(await main(["--server-dir", directory(), "server", "init", "--json"])).toBe(0);
      expect(await main(["server", "--server-dir", directory(), "init"])).toBe(0);
    } finally { if (prior === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = prior; }
    expect(await main(["--bogus", "devices"])).toBe(2);
  } finally { stdout.mockRestore(); stderr.mockRestore(); }
});

test("server init provisions owner-only secrets and refuses overwrite", async () => {
  const root = directory(); chmodSync(root, 0o700);
  const prior = process.env.NANOSYNC_PASSWORD;
  process.env.NANOSYNC_PASSWORD = "owner-password-for-tests";
  try {
  expect(await main(["server", "init", "--server-dir", root])).toBe(0);
  expect(secureRead(join(root, "pepper.hex"))).toHaveLength(64);
  expect(existsSync(join(root, "bootstrap.hex"))).toBe(false);
  expect(await main(["server", "init", "--server-dir", root])).toBe(2);
  } finally { if (prior === undefined) delete process.env.NANOSYNC_PASSWORD; else process.env.NANOSYNC_PASSWORD = prior; }
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
  let server = await runServer({ directory: root, port: 7540, scanIntervalMs: 100 });
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
    // Local report setup recovers object storage; it requires offline ownership.
    await server.stop();
    for (const command of ["storage", "retention-dry-run", "gc-dry-run", "scan", "diagnostics"]) {
      expect(await main(["server", "admin", command, "--server-dir", root, "--json"])).toBe(0);
    }
    server = await runServer({ directory: root, port: 7540, scanIntervalMs: 100 });
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
    expect(await main(["server", "devices", "view", "--server-dir", root])).toBe(0);
    expect((await api(url, "/v1/admin/enrollments", {}, adminToken)).enrollments).toHaveLength(1);
    expect(await main(["server", "devices", "approve", "--device-id", second, "--server-dir", root])).toBe(0);
    expect((await joinVault(secondDir, url, second, undefined, await displayRecoverySecret(recovery))).status).toBe("approved");
    const other = JSON.parse(secureRead(join(secondDir, "client.json")).toString("utf8"));
    expect((await api(url, "/v1/head", {}, other.token)).sequence).toBe(1);
    expect(await main(["admin", "storage", "--client-dir", secondDir])).toBe(2);
    expect(await main(["server", "devices", "revoke", "--device-id", second, "--server-dir", root, "--yes"])).toBe(0);
    expect(await main(["admin", "storage", "--client-dir", secondDir])).toBe(2);
    await expect(api(url, "/v1/head", {}, other.token)).rejects.toThrow(/401/);
  } finally { await server.stop(); }
});
