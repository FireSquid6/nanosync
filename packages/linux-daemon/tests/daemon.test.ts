import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalizePersistedRevisionEnvelope, parsePersistedRevisionEnvelope } from "@nanosync/protocol";
import { encryptManifest, referenceSetMac } from "@nanosync/sync-core";
import { createServerHandler, objectKey } from "../../server-core/src/index.ts";
import { ObjectCatalogRepository, RevisionRepository, ServerMetadataDatabase } from "../../server-metadata/src/index.ts";
import { LocalFilesystem } from "../../server-object-storage/src/index.ts";
import { daemonCommand, startDaemon, type LinuxDaemon } from "../src/index.ts";

const vault = "123e4567-e89b-42d3-a456-426614174000";
const device = "123e4567-e89b-42d3-a456-426614174002";
const secondDevice = "123e4567-e89b-42d3-a456-426614174008";
const rootId = "123e4567-e89b-42d3-a456-426614174003";
const genesis = "123e4567-e89b-42d3-a456-426614174001";
const token = "a".repeat(43);
const secondToken = "b".repeat(43);
const master = new Uint8Array(32).fill(7);
const dirs: string[] = [];
const daemons: LinuxDaemon[] = [];
afterEach(async () => { for (const daemon of daemons.splice(0)) await daemon.stop(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

async function setup() {
  const root = mkdtempSync(join(tmpdir(), "nanosync-daemon-")); dirs.push(root);
  const database = new ServerMetadataDatabase(":memory:");
  database.writeTransaction(tx => tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [vault]));
  const filesystem = new LocalFilesystem(join(root, "objects"));
  const encrypted = await encryptManifest({ version: 1, vaultId: vault, revisionId: genesis, parents: [], creatingDeviceId: device,
    entries: [{ id: rootId, parentId: null, name: "", kind: "directory" }] }, master);
  await filesystem.putIfAbsent(objectKey("manifest", encrypted.reference.objectId), new ReadableStream({ start(c) { c.enqueue(encrypted.frame); c.close(); } }), encrypted.reference.ciphertextChecksum);
  const revision = parsePersistedRevisionEnvelope({ protocolVersion: 1, revisionFormatVersion: 1, vaultId: vault,
    revisionId: genesis, parents: [], creatingDeviceId: device, createdAt: "2026-01-01T00:00:00.000Z",
    encryptedManifestObjectId: encrypted.reference.objectId, references: [encrypted.reference], referenceSetMac: "0".repeat(64) });
  revision.referenceSetMac = await referenceSetMac(revision, master) as typeof revision.referenceSetMac;
  database.writeTransaction(tx => {
    tx.run("INSERT INTO object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms) VALUES (?, ?, 'manifest', ?, ?, 1, 1)", [vault, encrypted.reference.objectId, encrypted.reference.ciphertextChecksum, encrypted.reference.ciphertextLength]);
    tx.run("INSERT INTO revisions(vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, accepted_sequence, server_created_at_ms) VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?, ?, 1, 1)", [vault, genesis, device, revision.createdAt, encrypted.reference.objectId, revision.referenceSetMac, canonicalizePersistedRevisionEnvelope(revision), "0".repeat(64)]);
    tx.run("INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version) VALUES (?, ?, ?, 'manifest', ?, ?, 1)", [vault, genesis, encrypted.reference.objectId, encrypted.reference.ciphertextChecksum, encrypted.reference.ciphertextLength]);
    tx.run("UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE singleton = 1", [genesis]);
  });
  let revoked = false;
  const handler = createServerHandler({ filesystem, catalog: new ObjectCatalogRepository(database), revisions: new RevisionRepository(database),
    authorize: async request => {
      const bearer = request.headers.get("authorization");
      if (revoked || bearer !== `Bearer ${token}` && bearer !== `Bearer ${secondToken}`) throw new Error("unauthorized");
      return { vaultId: vault, deviceId: bearer === `Bearer ${secondToken}` ? secondDevice : device, principalId: rootId };
    } });
  const client = (name: string, deviceId: string) => {
    const clientDirectory = join(root, name, "state"), syncDirectory = join(root, name, "files");
    mkdirSync(clientDirectory, { recursive: true, mode: 0o700 }); mkdirSync(syncDirectory, { recursive: true, mode: 0o700 });
    return { clientDirectory, syncDirectory, vaultId: vault, deviceId, masterKey: master, baseUrl: "http://local",
      token: deviceId === secondDevice ? secondToken : token,
      pollMs: 60000, scan: { debounceMs: 0, stabilityMs: 0 }, fetch: async (input: RequestInfo | URL) => handler(input as Request) };
  };
  return { client, revoke: () => { revoked = true; } };
}

test("two directories publish, download, pause, restart and reject revoked credentials", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first);
  expect(lstatSync(first.socketPath).mode & 0o777).toBe(0o600);
  expect(lstatSync(first.credentialPath).mode & 0o777).toBe(0o600);
  const denied = await fetch("http://localhost/status", { unix: first.socketPath, method: "POST", headers: { "content-type": "application/json" }, body: "{}" } as RequestInit & { unix: string });
  expect(denied.status).toBe(401);
  const invalid = await fetch("http://localhost/status", { unix: first.socketPath, method: "POST", headers: {
    authorization: `Bearer ${readFileSync(first.credentialPath, "utf8")}`, "content-type": "application/json"
  }, body: `{"extra":"${"x".repeat(2000)}"}` } as RequestInit & { unix: string });
  expect(invalid.status).toBe(413);
  await first.sync();
  expect((await daemonCommand(a.clientDirectory, "status")).applied.sequence).toBe(1);
  await expect(startDaemon(a)).rejects.toThrow();
  writeFileSync(join(a.syncDirectory, "note"), "one", { mode: 0o600 });
  expect((await daemonCommand(a.clientDirectory, "sync")).applied.sequence).toBe(2);
  const other = await startDaemon(b); daemons.push(other);
  await daemonCommand(b.clientDirectory, "sync");
  expect(readFileSync(join(b.syncDirectory, "note"), "utf8")).toBe("one");
  await daemonCommand(b.clientDirectory, "pause");
  writeFileSync(join(a.syncDirectory, "note"), "two");
  await daemonCommand(a.clientDirectory, "sync");
  expect(readFileSync(join(b.syncDirectory, "note"), "utf8")).toBe("one");
  await other.stop(); daemons.splice(daemons.indexOf(other), 1);
  const restarted = await startDaemon(b); daemons.push(restarted);
  await daemonCommand(b.clientDirectory, "sync");
  expect(readFileSync(join(b.syncDirectory, "note"), "utf8")).toBe("two");
  env.revoke();
  await expect(daemonCommand(b.clientDirectory, "sync")).rejects.toThrow();
  expect((await daemonCommand(b.clientDirectory, "status")).phase).toBe("error");
});

test("concurrent starts have one owner and stop preserves a replacement socket", async () => {
  const env = await setup(), options = env.client("a", device);
  const attempts = await Promise.allSettled([startDaemon(options), startDaemon(options)]);
  expect(attempts.filter(result => result.status === "fulfilled")).toHaveLength(1);
  expect(attempts.filter(result => result.status === "rejected")).toHaveLength(1);
  const winner = (attempts.find(result => result.status === "fulfilled") as PromiseFulfilledResult<LinuxDaemon>).value;
  daemons.push(winner);
  expect(existsSync(join(options.clientDirectory, ".daemon-startup"))).toBe(false);
  const moved = join(options.clientDirectory, "old.sock");
  renameSync(winner.socketPath, moved);
  const replacement = Bun.serve({ unix: winner.socketPath, fetch: () => new Response("replacement") });
  try {
    const inode = lstatSync(winner.socketPath).ino;
    await winner.stop(); daemons.splice(daemons.indexOf(winner), 1);
    expect(lstatSync(winner.socketPath).ino).toBe(inode);
    const response = await fetch("http://localhost/", { unix: winner.socketPath } as RequestInit & { unix: string });
    expect(await response.text()).toBe("replacement");
  } finally { replacement.stop(true); }
});

test("daemon start recovers an absent-PID gate and refuses a live one", async () => {
  const env = await setup(), options = env.client("a", device);
  const gate = join(options.clientDirectory, ".daemon-startup");
  writeFileSync(gate, "2147483647:1\n", { mode: 0o600 });
  const daemon = await startDaemon(options); daemons.push(daemon);
  expect(existsSync(gate)).toBe(false);
  await daemon.stop(); daemons.splice(daemons.indexOf(daemon), 1);
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  writeFileSync(gate, `${process.pid}:${stat.slice(stat.lastIndexOf(") ") + 2).split(/\s+/)[19]}\n`, { mode: 0o600 });
  await expect(startDaemon(options)).rejects.toThrow(/live process/);
  expect(existsSync(gate)).toBe(true);
});

test("offline conflicting edits are retained after stale-head merge", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first);
  await first.sync();
  writeFileSync(join(a.syncDirectory, "note"), "initial");
  await first.sync();
  const second = await startDaemon(b); daemons.push(second); await second.sync();
  writeFileSync(join(b.syncDirectory, "note"), "offline");
  writeFileSync(join(a.syncDirectory, "note"), "online");
  await first.sync();
  await second.sync();
  const files = (await import("node:fs")).readdirSync(b.syncDirectory);
  expect(files.length).toBe(2);
  expect(files.map(name => readFileSync(join(b.syncDirectory, name), "utf8")).sort()).toEqual(["offline", "online"]);
  expect(second.status().applied.sequence).toBe(4);
});

test("offline deletion versus remote edit retains edited conflict copy and tombstone", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first); await first.sync();
  writeFileSync(join(a.syncDirectory, "note"), "initial"); await first.sync();
  const second = await startDaemon(b); daemons.push(second); await second.sync();
  unlinkSync(join(b.syncDirectory, "note"));
  writeFileSync(join(a.syncDirectory, "note"), "edited"); await first.sync();
  await second.sync();
  const names = (await import("node:fs")).readdirSync(b.syncDirectory);
  expect(names).toHaveLength(1);
  expect(readFileSync(join(b.syncDirectory, names[0]!), "utf8")).toBe("edited");
  expect(second.status().applied.sequence).toBe(4);
});

test("offline edits merge across multiple authenticated remote revisions", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first); await first.sync();
  writeFileSync(join(a.syncDirectory, "note"), "base"); await first.sync();
  const second = await startDaemon(b); daemons.push(second); await second.sync();
  writeFileSync(join(b.syncDirectory, "note"), "offline");
  writeFileSync(join(a.syncDirectory, "note"), "remote-one"); await first.sync();
  writeFileSync(join(a.syncDirectory, "another"), "remote-two"); await first.sync();
  await second.sync();
  const names = (await import("node:fs")).readdirSync(b.syncDirectory);
  expect(names).toHaveLength(3);
  expect(names.map(name => readFileSync(join(b.syncDirectory, name), "utf8")).sort()).toEqual(["offline", "remote-one", "remote-two"]);
  expect(second.status().applied.sequence).toBeGreaterThan(4);
});

test("a lost accepted response is replayed byte-for-byte after restart", async () => {
  const env = await setup(), options = env.client("a", device);
  const first = await startDaemon(options); daemons.push(first); await first.sync();
  await first.stop(); daemons.splice(daemons.indexOf(first), 1);
  writeFileSync(join(options.syncDirectory, "note"), "durable");
  let lost = false;
  const failing = await startDaemon({ ...options, fetch: async input => {
    const response = await options.fetch(input);
    if (new URL((input as Request).url).pathname === "/v1/head/advance") {
      lost = true; await response.arrayBuffer(); throw new Error("lost response");
    }
    return response;
  } });
  daemons.push(failing);
  await expect(failing.sync()).rejects.toThrow("lost response");
  expect(lost).toBe(true);
  expect(failing.status().pendingProposal).toBe(true);
  await failing.stop(); daemons.splice(daemons.indexOf(failing), 1);
  const restarted = await startDaemon(options); daemons.push(restarted); await restarted.sync();
  expect(restarted.status().pendingProposal).toBe(false);
  expect(restarted.status().applied.sequence).toBe(2);
});

test("prepared proposal survives a crash before first advance", async () => {
  const env = await setup(), options = env.client("a", device);
  const first = await startDaemon(options); daemons.push(first); await first.sync();
  await first.stop(); daemons.splice(daemons.indexOf(first), 1);
  writeFileSync(join(options.syncDirectory, "note"), "prepared");
  const blocked = await startDaemon({ ...options, fetch: async input => {
    if (new URL((input as Request).url).pathname === "/v1/head/advance") throw new Error("offline during advance");
    return options.fetch(input);
  } });
  daemons.push(blocked);
  await expect(blocked.sync()).rejects.toThrow("offline during advance");
  expect(blocked.status().pendingProposal).toBe(true);
  await blocked.stop(); daemons.splice(daemons.indexOf(blocked), 1);
  const resumed = await startDaemon(options); daemons.push(resumed); await resumed.sync();
  expect(resumed.status().applied.sequence).toBe(2);
  expect(resumed.status().pendingProposal).toBe(false);
});

test("prepared offline proposal survives restart into a stale-head merge", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first); await first.sync();
  writeFileSync(join(a.syncDirectory, "note"), "base"); await first.sync();
  const second = await startDaemon(b); daemons.push(second); await second.sync();
  await second.stop(); daemons.splice(daemons.indexOf(second), 1);
  writeFileSync(join(b.syncDirectory, "note"), "offline");
  const blocked = await startDaemon({ ...b, fetch: async input => {
    if (new URL((input as Request).url).pathname === "/v1/head/advance") throw new Error("offline during advance");
    return b.fetch(input);
  } }); daemons.push(blocked);
  await expect(blocked.sync()).rejects.toThrow("offline during advance");
  await blocked.stop(); daemons.splice(daemons.indexOf(blocked), 1);
  writeFileSync(join(a.syncDirectory, "note"), "remote"); await first.sync();
  const resumed = await startDaemon(b); daemons.push(resumed); await resumed.sync();
  const names = (await import("node:fs")).readdirSync(b.syncDirectory);
  expect(names.map(name => readFileSync(join(b.syncDirectory, name), "utf8")).sort()).toEqual(["offline", "remote"]);
  expect(resumed.status().pendingProposal).toBe(false);
});

test("accepted merge survives a lost response and replays local-branch metadata", async () => {
  const env = await setup(), a = env.client("a", device), b = env.client("b", secondDevice);
  const first = await startDaemon(a); daemons.push(first); await first.sync();
  writeFileSync(join(a.syncDirectory, "note"), "base"); await first.sync();
  const second = await startDaemon(b); daemons.push(second); await second.sync();
  await second.stop(); daemons.splice(daemons.indexOf(second), 1);
  writeFileSync(join(b.syncDirectory, "note"), "offline");
  writeFileSync(join(a.syncDirectory, "note"), "remote"); await first.sync();
  let advances = 0;
  const interrupted = await startDaemon({ ...b, fetch: async input => {
    const response = await b.fetch(input);
    if (new URL((input as Request).url).pathname === "/v1/head/advance" && ++advances === 2) {
      await response.arrayBuffer(); throw new Error("lost merge acceptance");
    }
    return response;
  } }); daemons.push(interrupted);
  await expect(interrupted.sync()).rejects.toThrow("lost merge acceptance");
  expect(interrupted.status().pendingProposal).toBe(true);
  await interrupted.stop(); daemons.splice(daemons.indexOf(interrupted), 1);
  const resumed = await startDaemon(b); daemons.push(resumed); await resumed.sync();
  const names = (await import("node:fs")).readdirSync(b.syncDirectory);
  expect(names.map(name => readFileSync(join(b.syncDirectory, name), "utf8")).sort()).toEqual(["offline", "remote"]);
  expect(resumed.status().headsConverged).toBe(true);
});
