import {
  enrollServer, authenticatedServer, key, unlockVault, type ServerRegistration, createConnection,
  discoverConnection, api,
} from '@nanosync/client-service';
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID, randomBytes } from "node:crypto";
import { initializeServerOwner, approveLocalDevice, runServer } from "../src/server.ts";
import { main } from "../src/main.ts";

import { OWNER_GENESIS_AUTHOR_ID, parsePersistedRevisionEnvelope } from '@nanosync/protocol';
import { encryptManifest, referenceSetMac, generateRecoverySecret, displayRecoverySecret, wrapMasterKey } from '@nanosync/sync-core';

async function browserOwner(url: string, password: string) {
  const origin = new URL(url).origin;
  const login = await fetch(`${origin}/admin/api/session`, { method: 'POST', headers: { origin, 'x-nanosync-csrf':'login', 'content-type':'application/json' }, body: JSON.stringify({ password }) });
  expect(login.status).toBe(200);
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const { csrfToken } = await login.json() as any;
  return async (path: string, value: unknown, expectedStatus = 200) => {
    const response = await fetch(`${origin}/admin/api${path}`, { method:'POST', headers: { origin, cookie, 'x-nanosync-csrf':csrfToken, 'content-type':'application/json' }, body:JSON.stringify(value) });
    expect(response.status).toBe(expectedStatus); return response.json();
  };
}
async function createOwnerVault(root: string, info: ServerRegistration, name: string,
  owner: Awaited<ReturnType<typeof browserOwner>>, deliver: (secret: string) => Promise<void>) {
  const vaultId = randomUUID(), revisionId = randomUUID(), master = randomBytes(32), recovery = generateRecoverySecret();
  try {
    const secret = await displayRecoverySecret(recovery);
    const encrypted = await encryptManifest({ version:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
      entries:[{ id:randomUUID(), parentId:null, name:'', kind:'directory' }] }, master);
    const genesis = parsePersistedRevisionEnvelope({ protocolVersion:1, revisionFormatVersion:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
      createdAt:new Date().toISOString(), encryptedManifestObjectId:encrypted.reference.objectId, references:[encrypted.reference], referenceSetMac:'0'.repeat(64) });
    genesis.referenceSetMac = await referenceSetMac(genesis, master) as typeof genesis.referenceSetMac;
    const request = { vaultId, name, recoveryWrap:await wrapMasterKey(master, recovery, vaultId), genesisRevision:genesis, frame:Buffer.from(encrypted.frame).toString('base64url') };
    expect(JSON.stringify(request)).not.toContain(secret);
    expect(JSON.stringify(request)).not.toContain(master.toString("hex"));
    await deliver(secret);
    await owner('/vaults', request);
    await owner('/vaults', request); // Lost-response retry uses identical encrypted creation.
    await unlockVault(root, info, vaultId, secret);
    return { vaultId, name };
  } finally { master.fill(0); recovery.fill(0); }
}
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
test("password-only server, local device approval, two isolated vaults and two replicas", async () => {
  const base = mkdtempSync(join(tmpdir(), "nanosync-multi-")); roots.push(base);
  const serverRoot = join(base, "server"), clientRoot = join(base, "client"), first = join(base, "first"), second = join(base, "second");
  mkdirSync(serverRoot, { mode: 0o700 }); mkdirSync(clientRoot, { mode: 0o700 });
  mkdirSync(first, { mode: 0o700 }); mkdirSync(second, { mode: 0o700 });
  writeFileSync(join(serverRoot, "pepper.hex"), randomBytes(32).toString("hex"), { mode: 0o600 });
  await initializeServerOwner(serverRoot, "correct horse battery staple");
  const running = await runServer({ directory: serverRoot, port: 7555, webUi:true });
  try {
    expect(await enrollServer(clientRoot, running.url, "correct horse battery staple", "desktop", 0, {credentialMode:"protected-file"})).toMatchObject({status:"pending"});
    approveLocalDevice(serverRoot, (await import('@nanosync/client-service')).pendingEnrollments(clientRoot)[0]!.deviceId);
    expect(await enrollServer(clientRoot, running.url, undefined, "desktop", 0)).toMatchObject({status:"approved"});
    const info = await authenticatedServer(clientRoot);
    expect(info).toBeDefined();
    const owner = await browserOwner(running.url, "correct horse battery staple");
    const secrets: string[] = [];
    const pictures = await createOwnerVault(clientRoot, info!, "pictures", owner, async value => { secrets.push(value); });
    const documents = await createOwnerVault(clientRoot, info!, "documents", owner, async value => { secrets.push(value); });
    const archive = await createOwnerVault(clientRoot, info!, 'archive', owner, async () => {});
    expect(archive.name).toBe('archive');
    expect(secrets[0]).not.toBe(secrets[1]);
    expect((await api(info!.baseUrl, "/v1/vaults", {}, info!.token)).vaults.map((v: {name:string}) => v.name)).toEqual(["archive","documents","pictures"]);
    await expect(api(info!.baseUrl, `/v1/vaults/${documents.vaultId}/rename`, { method:'POST', body:JSON.stringify({name:'forbidden'}) }, info!.token)).rejects.toThrow(/404/);
    await owner(`/vaults/${documents.vaultId}/rename`, { name:'notes' });
    await owner(`/vaults/${archive.vaultId}/delete`, {confirmName:'wrong',password:'correct horse battery staple'}, 409);
    expect((await api(info!.baseUrl, '/v1/vaults', {}, info!.token)).vaults).toHaveLength(3);
    await owner(`/vaults/${archive.vaultId}/delete`, {confirmName:'archive',password:'wrong'}, 401);
    await owner(`/vaults/${archive.vaultId}/delete`, {confirmName:'archive',password:'correct horse battery staple'});
    await expect(api(info!.baseUrl, '/v1/head', {headers:{'x-nanosync-vault-id':archive.vaultId}}, info!.token)).rejects.toThrow(/410/);
    expect((await api(info!.baseUrl, '/v1/vaults', {}, info!.token)).vaults).toHaveLength(2);
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
    expect(await main(["client", "sync", "--client-dir", clientRoot, "--path", first])).toBe(0);
    expect(await main(["client", "sync", "--client-dir", clientRoot, "--path", second])).toBe(0);
    expect(readFileSync(join(second, "hello"), "utf8")).toBe("world");
    writeFileSync(join(first, "from-first"), "one", { mode: 0o600 });
    writeFileSync(join(second, "from-second"), "two", { mode: 0o600 });
    expect(await Promise.all([main(["client", "sync", "--client-dir", clientRoot, "--path", first]),
      main(["client", "sync", "--client-dir", clientRoot, "--path", second])])).toEqual([0, 0]);
    expect(await main(["client", "sync", "--client-dir", clientRoot, "--path", first])).toBe(0);
    expect(await main(["client", "sync", "--client-dir", clientRoot, "--path", second])).toBe(0);
    expect(readFileSync(join(first, "from-second"), "utf8")).toBe("two");
    expect(readFileSync(join(second, "from-first"), "utf8")).toBe("one");
    expect(existsSync(join(second, ".nanosync"))).toBe(true);
    expect((await api(info!.baseUrl, "/v1/head", { headers: { "x-nanosync-vault-id": documents.vaultId } }, info!.token)).revisionId).toBe(headB.revisionId);
    // Losing a local key does not affect the other vault's key or the server's
    // ability to authorize an enrolled device. Recovery is per-vault.
    rmSync(join(clientRoot, "keys", `${info!.serverId}-${pictures.vaultId}.json`));
    expect(await key(clientRoot, info!.serverId, pictures.vaultId)).toBeNull();
    await unlockVault(clientRoot, info!, pictures.vaultId, secrets[0]!);
    expect(await key(clientRoot, info!.serverId, pictures.vaultId)).toHaveLength(32);
  } finally { await running.stop(); }
});

test("CLI env workflow creates and selects named vaults without exposing secrets in arguments", async () => {
  const base = mkdtempSync(join(tmpdir(), "nanosync-cli-workflow-")); roots.push(base);
  const serverRoot = join(base,"server"), root = join(base,"global"), files = join(base,"files"), recovery = join(base,"private-recovery.txt");
  mkdirSync(serverRoot,{mode:0o700}); mkdirSync(root,{mode:0o700}); mkdirSync(files,{mode:0o700});
  const previous = { ...process.env };
  try {
    process.env.NANOSYNC_PASSWORD = "test-owner-password";
    expect(await main(["server","init","--server-dir",serverRoot])).toBe(0);
    const running = await runServer({directory:serverRoot,port:7556,webUi:true});
    try {
      process.env.NANOSYNC_SERVER = running.url;
      process.env.NANOSYNC_DEVICE_NAME = "desktop";
      expect(await main(["client","connections","add","--credential-mode","protected-file","--alias","house","--url",running.url,"--device-name","desktop","--wait-ms","0","--client-dir",root])).toBe(3);
      expect(await main(["server","devices","approve","--device-id",(await import('@nanosync/client-service')).pendingEnrollments(root)[0]!.deviceId,"--server-dir",serverRoot])).toBe(0);
      expect(await main(["client","connections","add","--credential-mode","protected-file","--alias","house","--url",running.url,"--device-name","desktop","--wait-ms","0","--client-dir",root])).toBe(0);
      // Provisioning belongs to the owner API; device CLI mutations are unavailable.
      expect(await main(["vault","create","--client-dir",root,"--name","notes","--recovery-output",recovery])).toBe(2);
      const owner = await browserOwner(running.url, process.env.NANOSYNC_PASSWORD!);
      const info = await authenticatedServer(root);
      const created = await createOwnerVault(root, info, 'notes', owner, async secret => { writeFileSync(recovery, secret, {mode:0o600}); });
      expect(await main(["server","vaults","view","--server-dir",serverRoot])).toBe(0);
      expect(await main(["vault","rename","notes","--client-dir",root,"--name","documents"])).toBe(2);
      await owner(`/vaults/${created.vaultId}/rename`, {name:"documents"});
      writeFileSync(join(files,"existing"),"safe",{mode:0o600});
      expect(await main(["client","vaults","connect","--server","house","--client-dir",root,"--path",files,"--vault","documents"])).toBe(2);
      expect(await main(["client","vaults","connect","--server","house","--client-dir",root,"--path",files,"--vault","documents","--confirm-nonempty"])).toBe(0);
      expect(await main(["client", "sync","--client-dir",root,"--path",files])).toBe(0);
      expect(readFileSync(join(files,"existing"),"utf8")).toBe("safe");
      expect(await main(["client", "sync","--client-dir",root,"--path",join(files,"missing")])).toBe(2);
      expect(await main(["vault","create","--client-dir",root,"--name","notes"])).toBe(2); // No TTY or private output.
    } finally { await running.stop(); }
  } finally { process.env = previous; }
});
