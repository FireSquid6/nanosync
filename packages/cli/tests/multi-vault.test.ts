import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { initializeServerOwner, approveLocalDevice, runServer } from "../src/server.ts";
import { enrollServer, servers, createVault, key, unlockVault } from "../src/vault-client.ts";
import { createConnection, discoverConnection } from "../src/connections.ts";
import { main } from "../src/main.ts";
import { api } from "../src/client.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("password-only server, local device approval, two isolated vaults and two replicas", async () => {
  const base = mkdtempSync(join(tmpdir(), "nanosync-multi-")); roots.push(base);
  const serverRoot = join(base, "server"), clientRoot = join(base, "client"), first = join(base, "first"), second = join(base, "second");
  mkdirSync(serverRoot, { mode: 0o700 }); mkdirSync(clientRoot, { mode: 0o700 });
  mkdirSync(first, { mode: 0o700 }); mkdirSync(second, { mode: 0o700 });
  writeFileSync(join(serverRoot, "pepper.hex"), randomBytes(32).toString("hex"), { mode: 0o600 });
  await initializeServerOwner(serverRoot, "correct horse battery staple");
  const running = await runServer({ directory: serverRoot, port: 7555 });
  try {
    expect(await enrollServer(clientRoot, running.url, "correct horse battery staple", "desktop", 1)).toMatchObject({status:"pending"});
    approveLocalDevice(serverRoot, "desktop");
    expect(await enrollServer(clientRoot, running.url, undefined, "desktop", 1)).toMatchObject({status:"approved"});
    const [info] = servers(clientRoot);
    expect(info).toBeDefined();
    const secrets: string[] = [];
    const pictures = await createVault(clientRoot, info!, "pictures", async value => { secrets.push(value); });
    const documents = await createVault(clientRoot, info!, "documents", async value => { secrets.push(value); });
    const nativeFetch = globalThis.fetch;
    let dropped = false;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await nativeFetch(input, init);
      if (!dropped && String(input).includes("/v1/vaults") && init?.method === "POST") {
        dropped = true; throw new TypeError("lost vault creation response");
      }
      return response;
    }) as typeof fetch;
    let retrySecret = "";
    try {
      await expect(createVault(clientRoot, info!, "archive", async secret => { retrySecret = secret; })).rejects.toThrow(/lost vault/);
    } finally { globalThis.fetch = nativeFetch; }
    expect(existsSync(join(clientRoot,"vault-creation.json"))).toBe(true);
    const retry = await createVault(clientRoot, info!, "archive", async secret => { expect(secret).toBe(retrySecret); });
    expect(retry.name).toBe("archive");
    expect(existsSync(join(clientRoot,"vault-creation.json"))).toBe(false);
    expect(secrets[0]).not.toBe(secrets[1]);
    expect((await api(info!.baseUrl, "/v1/vaults", {}, info!.token)).vaults.map((v: {name:string}) => v.name)).toEqual(["archive","documents","pictures"]);
    expect((await api(info!.baseUrl, `/v1/vaults/${documents.vaultId}/rename`, {
      method: "POST", body: JSON.stringify({ name: "notes" }) }, info!.token)).name).toBe("notes");
    const headA = await api(info!.baseUrl, "/v1/head", { headers: { "x-nanosync-vault-id": pictures.vaultId } }, info!.token);
    const headB = await api(info!.baseUrl, "/v1/head", { headers: { "x-nanosync-vault-id": documents.vaultId } }, info!.token);
    expect(headA.revisionId).not.toBe(headB.revisionId);
    const revisionA = (await api(info!.baseUrl, `/v1/revisions/${headA.revisionId}`, {
      headers: { "x-nanosync-vault-id": pictures.vaultId } }, info!.token)).revision;
    await expect(api(info!.baseUrl, `/v1/revisions/${headA.revisionId}`, {
      headers: { "x-nanosync-vault-id": documents.vaultId } }, info!.token)).rejects.toThrow(/404/);
    await expect(api(info!.baseUrl, `/v1/objects/manifest/${revisionA.encryptedManifestObjectId}`, {
      headers: { "x-nanosync-vault-id": documents.vaultId } }, info!.token)).rejects.toThrow(/404/);
    const presence = await api(info!.baseUrl, "/v1/objects/presence", { method: "POST",
      headers: { "x-nanosync-vault-id": documents.vaultId }, body: JSON.stringify({ protocolVersion: 1,
        objectType: "manifest", objectIds: [revisionA.encryptedManifestObjectId] }) }, info!.token);
    expect(presence.objects[0].present).toBe(false);
    const forged = await api(info!.baseUrl, "/v1/head/advance", { method: "POST",
      headers: { "x-nanosync-vault-id": documents.vaultId }, body: JSON.stringify({ protocolVersion: 1,
        vaultId: pictures.vaultId, expectedRevisionId: headB.revisionId, proposedRevision: revisionA,
        idempotencyKey: "cross-vault-test" }) }, info!.token).catch(error => error);
    expect(forged.status).toBeGreaterThanOrEqual(400);
    await expect(api(info!.baseUrl, "/v1/head", {}, info!.token)).rejects.toThrow(/400/);
    await expect(api(info!.baseUrl, "/v1/head", { headers: { "x-nanosync-vault-id": "00000000-0000-4000-8000-000000000000" } }, info!.token)).rejects.toThrow(/403/);
    const connectionA = createConnection(clientRoot, first, info!.serverId, pictures.vaultId, info!.deviceId);
    const connectionB = createConnection(clientRoot, second, info!.serverId, pictures.vaultId, info!.deviceId);
    expect(connectionA.connectionId).not.toBe(connectionB.connectionId);
    mkdirSync(join(first, "nested"), { mode: 0o700 });
    expect(discoverConnection(clientRoot, join(first, "nested"))).toEqual(connectionA);
    writeFileSync(join(first, "hello"), "world", { mode: 0o600 });
    expect(await main(["sync", "--client-dir", clientRoot, "--path", first])).toBe(0);
    expect(await main(["sync", "--client-dir", clientRoot, "--path", second])).toBe(0);
    expect(readFileSync(join(second, "hello"), "utf8")).toBe("world");
    writeFileSync(join(first, "from-first"), "one", { mode: 0o600 });
    writeFileSync(join(second, "from-second"), "two", { mode: 0o600 });
    expect(await Promise.all([main(["sync", "--client-dir", clientRoot, "--path", first]),
      main(["sync", "--client-dir", clientRoot, "--path", second])])).toEqual([0, 0]);
    expect(await main(["sync", "--client-dir", clientRoot, "--path", first])).toBe(0);
    expect(await main(["sync", "--client-dir", clientRoot, "--path", second])).toBe(0);
    expect(readFileSync(join(first, "from-second"), "utf8")).toBe("two");
    expect(readFileSync(join(second, "from-first"), "utf8")).toBe("one");
    expect(existsSync(join(second, ".nanosync"))).toBe(true);
    expect((await api(info!.baseUrl, "/v1/head", { headers: { "x-nanosync-vault-id": documents.vaultId } }, info!.token)).revisionId).toBe(headB.revisionId);
    // Losing a local key does not affect the other vault's key or the server's
    // ability to authorize an enrolled device. Recovery is per-vault.
    rmSync(join(clientRoot, "keys", `${info!.serverId}-${pictures.vaultId}.json`));
    expect(key(clientRoot, info!.serverId, pictures.vaultId)).toBeNull();
    await unlockVault(clientRoot, info!, pictures.vaultId, secrets[0]!);
    expect(key(clientRoot, info!.serverId, pictures.vaultId)).toHaveLength(32);
  } finally { await running.stop(); }
});

test("CLI env workflow creates and selects named vaults without exposing secrets in arguments", async () => {
  const base = mkdtempSync(join(tmpdir(), "nanosync-cli-workflow-")); roots.push(base);
  const serverRoot = join(base,"server"), root = join(base,"global"), files = join(base,"files"), recovery = join(base,"private-recovery.txt");
  mkdirSync(serverRoot,{mode:0o700}); mkdirSync(root,{mode:0o700}); mkdirSync(files,{mode:0o700});
  const previous = { ...process.env };
  try {
    process.env.NANOSYNC_PASSWORD = "test-owner-password";
    expect(await main(["server","init","--env","--server-dir",serverRoot])).toBe(0);
    const running = await runServer({directory:serverRoot,port:7556});
    try {
      process.env.NANOSYNC_SERVER = running.url;
      process.env.NANOSYNC_DEVICE_NAME = "desktop";
      expect(await main(["enroll","--env","--wait-ms","0","--client-dir",root])).toBe(3);
      expect(await main(["approve","desktop","--server-dir",serverRoot])).toBe(0);
      expect(await main(["enroll","--env","--wait-ms","0","--client-dir",root])).toBe(0);
      expect(await main(["vault","create","--client-dir",root,"--name","notes","--recovery-output",recovery])).toBe(0);
      expect(await main(["vault","list","--client-dir",root])).toBe(0);
      expect(await main(["vault","rename","notes","--client-dir",root,"--name","documents"])).toBe(0);
      writeFileSync(join(files,"existing"),"safe",{mode:0o600});
      expect(await main(["setup","--env","--client-dir",root,"--path",files,"--vault","documents"])).toBe(2);
      expect(await main(["setup","--env","--client-dir",root,"--path",files,"--vault","documents","--confirm-nonempty"])).toBe(0);
      expect(await main(["sync","--client-dir",root,"--path",files])).toBe(0);
      expect(readFileSync(join(files,"existing"),"utf8")).toBe("safe");
      expect(await main(["sync","--client-dir",root,"--path",join(files,"missing")])).toBe(2);
      expect(await main(["vault","create","--client-dir",root,"--name","notes"])).toBe(2); // No TTY or private output.
    } finally { await running.stop(); }
  } finally { process.env = previous; }
});
