import { expect, test } from "bun:test";
import { CHUNK_SIZE, type RevisionEnvelope } from "@nanosync/protocol";
import { decodeManifest, decryptManifest, encodeManifest, encryptChunk, encryptManifest, MAX_FILE_BYTES, parseManifest, referenceSetMac, validateManifestReferences, type ManifestEntry, type ManifestV1 } from "../src/index.ts";

const vaultId = "123e4567-e89b-42d3-a456-426614174000";
const revisionId = "123e4567-e89b-42d3-a456-426614174001";
const deviceId = "123e4567-e89b-42d3-a456-426614174002";
const rootId = "123e4567-e89b-42d3-a456-426614174003";
const fileId = "123e4567-e89b-42d3-a456-426614174004";
const master = new Uint8Array(32).fill(7);
const emptyHash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const root: ManifestEntry = { id: rootId, parentId: null, name: "", kind: "directory" };
const file: ManifestEntry = { id: fileId, parentId: rootId, name: "hello.txt", kind: "file", size: 0, sha256: emptyHash, executable: false, chunks: [] };
const base = (): ManifestV1 => ({ version: 1, vaultId, revisionId, parents: [], creatingDeviceId: deviceId, entries: [file, root] });

test("canonical encrypted roundtrip, public MAC first, exact reference set and binding", async () => {
  const manifest = base();
  expect(encodeManifest(manifest)).toEqual(encodeManifest({ ...manifest, entries: [root, file] }));
  const encrypted = await encryptManifest(manifest, master);
  const envelope: RevisionEnvelope = {
    protocolVersion: 1, revisionFormatVersion: 1, vaultId: vaultId as RevisionEnvelope["vaultId"],
    revisionId: revisionId as RevisionEnvelope["revisionId"], parents: [], creatingDeviceId: deviceId as RevisionEnvelope["creatingDeviceId"],
    createdAt: "2026-01-02T03:04:05.006Z", encryptedManifestObjectId: encrypted.reference.objectId,
    references: [encrypted.reference], referenceSetMac: "0".repeat(64) as RevisionEnvelope["referenceSetMac"],
  };
  envelope.referenceSetMac = await referenceSetMac(envelope, master) as RevisionEnvelope["referenceSetMac"];
  expect(await decryptManifest(encrypted.frame, envelope, master)).toEqual(parseManifest(manifest));
  expect(decodeManifest(encodeManifest(manifest))).toEqual(parseManifest(manifest));
  await expect(decryptManifest(new Uint8Array(0), { ...envelope, revisionId: deviceId }, master)).rejects.toThrow(/MAC/);
  const foreign = { ...manifest, revisionId: deviceId };
  const foreignEncrypted = await encryptManifest(foreign, master);
  const foreignEnvelope = { ...envelope, encryptedManifestObjectId: foreignEncrypted.reference.objectId, references: [foreignEncrypted.reference] };
  foreignEnvelope.referenceSetMac = await referenceSetMac(foreignEnvelope, master) as RevisionEnvelope["referenceSetMac"];
  await expect(decryptManifest(foreignEncrypted.frame, foreignEnvelope, master)).rejects.toThrow(/binding/);
  const extra = await encryptChunk(new Uint8Array([5]), master, vaultId);
  const extraEnvelope = { ...envelope, references: [encrypted.reference, extra.reference].sort((a, b) => a.objectId < b.objectId ? -1 : 1) };
  extraEnvelope.referenceSetMac = await referenceSetMac(extraEnvelope, master) as RevisionEnvelope["referenceSetMac"];
  await expect(decryptManifest(encrypted.frame, extraEnvelope, master)).rejects.toThrow(/reference/);
});

test("tombstones, lineage, chunk reference lengths", async () => {
  const encrypted = await encryptChunk(new Uint8Array([9]), master, vaultId);
  const m = base();
  m.entries = [root, { ...file, size: 1, sha256: "0".repeat(64), chunks: [{ objectId: encrypted.reference.objectId, length: 1 }] },
    { id: "123e4567-e89b-42d3-a456-426614174005", parentId: rootId, name: "gone", kind: "tombstone", deletedKind: "file" }];
  const normalized = parseManifest(m);
  expect(normalized.entries[2]?.kind).toBe("tombstone");
  const object = await encryptManifest(m, master);
  const envelope = { protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId, parents: [], creatingDeviceId: deviceId,
    createdAt: "2026-01-02T03:04:05.006Z", encryptedManifestObjectId: object.reference.objectId,
    references: [object.reference, encrypted.reference].sort((a, b) => a.objectId < b.objectId ? -1 : 1), referenceSetMac: "0".repeat(64) };
  validateManifestReferences(m, envelope);
  expect(() => validateManifestReferences(m, { ...envelope, references: [object.reference] })).toThrow();
  expect(() => validateManifestReferences(m, { ...envelope, references: envelope.references.map(r => r.objectType === "chunk" ? { ...r, ciphertextLength: r.ciphertextLength + 1 } : r) })).toThrow();
  expect(() => parseManifest({ ...m, entries: [...m.entries, { ...file, id: "123e4567-e89b-42d3-a456-426614174006", name: "copy", conflict: { sourceEntryId: fileId, sourceRevisionId: revisionId } }] })).not.toThrow();
});

test("rejects invalid trees, metadata, versions and noncanonical JSON", () => {
  const invalid: unknown[] = [
    { ...base(), version: 2 }, { ...base(), extra: true },
    { ...base(), entries: [root, { ...file, name: "../escape" }] },
    { ...base(), entries: [root, { ...file, name: "CON.txt" }] },
    { ...base(), entries: [root, { ...file, name: "a\u0001b" }] },
    { ...base(), entries: [root, { ...file, name: "a\ud800" }] },
    { ...base(), entries: [root, { ...file, name: "a\\b" }] },
    { ...base(), entries: [root, { ...file, id: rootId }] },
    { ...base(), entries: [root, { ...file, parentId: "123e4567-e89b-42d3-a456-426614174099" }] },
    { ...base(), entries: [root, { ...file, parentId: fileId }] },
    { ...base(), entries: [root, { ...file, name: "a" }, { ...file, id: "123e4567-e89b-42d3-a456-426614174006", name: "A" }] },
    { ...base(), entries: [root, { ...file, size: 1 }] },
    { ...base(), entries: [root, { ...file, size: MAX_FILE_BYTES + 1 }] },
    { ...base(), entries: [root, { ...file, executable: "yes" }] },
    { ...base(), entries: [root, { ...file, sha256: "BAD" }] },
    { ...base(), entries: [root, { ...file, kind: "tombstone", deletedKind: "file" }] },
  ];
  for (const input of invalid) expect(() => parseManifest(input)).toThrow();
  const cycle = base();
  cycle.entries = [root, { ...root, id: fileId, parentId: "123e4567-e89b-42d3-a456-426614174006", name: "one" },
    { ...root, id: "123e4567-e89b-42d3-a456-426614174006", parentId: fileId, name: "two" }];
  expect(() => parseManifest(cycle)).toThrow();
  const canonical = new TextDecoder().decode(encodeManifest(base()));
  expect(() => decodeManifest(new TextEncoder().encode(canonical.replace('"version":1', '"version":1,"version":1')))).toThrow();
  expect(() => decodeManifest(new TextEncoder().encode(JSON.stringify(base())))).toThrow();
});

test("50 GB metadata fits 4 MiB with no file buffering; rejects impossible last chunk", async () => {
  const count = Math.ceil(MAX_FILE_BYTES / CHUNK_SIZE);
  const m = base();
  m.entries = [root, { ...file, size: MAX_FILE_BYTES, sha256: "0".repeat(64), chunks: Array.from({ length: count }, (_, i) => ({ objectId: i.toString(16).padStart(64, "0"), length: i === count - 1 ? MAX_FILE_BYTES - i * CHUNK_SIZE : CHUNK_SIZE })) }];
  expect(count).toBe(11_921);
  expect(encodeManifest(m).length).toBeLessThan(4 * 1024 * 1024);
  const encrypted = await encryptManifest(m, master);
  expect(encrypted.reference.objectType).toBe("manifest");
  m.entries[1]!.chunks![count - 1]!.length--;
  expect(() => parseManifest(m)).toThrow();
});
