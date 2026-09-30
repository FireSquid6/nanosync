import { describe, expect, test } from "bun:test";
import { CHUNK_SIZE, parseObjectFrameHeader, type RevisionEnvelope } from "@nanosync/protocol";
import {
  decodeRecoverySecret, decryptObject, deriveVaultKeys, displayRecoverySecret, encryptChunk,
  encryptFileChunks, encryptRandomized, referenceSetMac, verifyReferenceSetMac, unwrapMasterKey, wrapMasterKey,
} from "../src/index.ts";

const vault = "123e4567-e89b-42d3-a456-426614174000";
const otherVault = "123e4567-e89b-42d3-a456-426614174001";
const master = Uint8Array.from({ length: 32 }, (_, i) => i);
const secret = Uint8Array.from({ length: 32 }, (_, i) => 255 - i);
const badKey = new Uint8Array(32);
const data = new TextEncoder().encode("portable chunk vector");

describe("recovery and hierarchy", () => {
  test("fixed vectors, canonical display and checksum", async () => {
    const encoded = await displayRecoverySecret(secret);
    expect(encoded).toBe("777p3-7h37l-47r57-w6x2p-h4xr6-dx653-pm5pv-ot2hh-43s6j-y7c4h-qawzq-rbtq");
    expect(encoded).toMatch(/^(?:[a-z2-7]{5}-){11}[a-z2-7]{4}$/);
    expect(await decodeRecoverySecret(encoded)).toEqual(secret);
    expect(await deriveVaultKeys(master, vault)).toEqual(await deriveVaultKeys(master, vault));
    expect(Array.from((await deriveVaultKeys(master, vault)).chunkEncryptionRoot, b => b.toString(16).padStart(2, "0")).join("")).toBe("7e7b8167aaa4d049fc56d34f270bab44a2d1903995b0901265d0261331ba996a");
    expect((await deriveVaultKeys(master, vault)).chunkEncryptionRoot).not.toEqual((await deriveVaultKeys(master, otherVault)).chunkEncryptionRoot);
    await expect(decodeRecoverySecret(encoded.toUpperCase())).rejects.toThrow();
    await expect(decodeRecoverySecret(encoded.slice(0, -1) + (encoded.endsWith("a") ? "b" : "a"))).rejects.toThrow();
    await expect(decodeRecoverySecret(encoded.replace(/.$/, "7"))).rejects.toThrow(); // nonzero discarded bits
    await expect(decodeRecoverySecret(encoded.replaceAll("-", ""))).rejects.toThrow();
  });
  test("wrap is opaque and locally authenticated", async () => {
    const wrap = await wrapMasterKey(master, secret, vault);
    expect(wrap.version).toBe(1);
    expect(await unwrapMasterKey(wrap, secret, vault)).toEqual(master);
    await expect(unwrapMasterKey(wrap, badKey, vault)).rejects.toThrow();
    await expect(unwrapMasterKey(wrap, secret, otherVault)).rejects.toThrow();
    await expect(unwrapMasterKey({ ...wrap, version: 2 }, secret, vault)).rejects.toThrow();
    await expect(unwrapMasterKey({ ...wrap, nonce: wrap.nonce + "=" }, secret, vault)).rejects.toThrow();
  });
  test("caller mutation after wrap/unwrap calls cannot change their inputs", async () => {
    const mutableMaster = master.slice(), mutableSecret = secret.slice();
    const pending = wrapMasterKey(mutableMaster, mutableSecret, vault);
    mutableMaster.fill(0); mutableSecret.fill(0);
    const wrap = await pending;
    const input = { ...wrap }, restoredSecret = secret.slice();
    const unwrapping = unwrapMasterKey(input, restoredSecret, vault);
    input.ciphertext = "garbage"; input.nonce = "garbage"; restoredSecret.fill(0);
    expect(await unwrapping).toEqual(master);
    const pendingKeys = deriveVaultKeys(master.slice(), vault);
    expect((await pendingKeys).manifestKey).toEqual((await deriveVaultKeys(master, vault)).manifestKey);
  });
});

describe("v1 framed objects", () => {
  test("deterministic chunk, exact header and authenticated metadata", async () => {
    const first = await encryptChunk(data, master, vault), second = await encryptChunk(data, master, vault);
    expect(first).toEqual(second);
    expect(String(first.reference.objectId)).toBe("824e2c4eee04e4ee77686fc05498fed2449dd653d893247df97e45d267bed17d");
    expect(String(first.reference.ciphertextChecksum)).toBe("903128993d5ebdea0abe1f15a0eebcb4bf3afa06f283fd79709e24f6d1315879");
    expect(new TextDecoder().decode(first.frame.subarray(0, 8))).toBe("NSOBJ001");
    expect(first.frame.length).toBe(80 + data.length + 16);
    expect(parseObjectFrameHeader(first.frame.subarray(0, 80)).objectId).toBe(first.reference.objectId);
    expect(await decryptObject(first.frame, master, vault, first.reference)).toEqual(data);
    await expect(decryptObject(first.frame, badKey, vault, first.reference)).rejects.toThrow();
    await expect(decryptObject(first.frame, master, otherVault, first.reference)).rejects.toThrow();
    const tampered = first.frame.slice(); tampered[80] = tampered[80]! ^ 1;
    await expect(decryptObject(tampered, master, vault, first.reference)).rejects.toThrow();
    await expect(decryptObject(first.frame.subarray(0, -1), master, vault, first.reference)).rejects.toThrow();
    await expect(decryptObject(new Uint8Array([...first.frame, 0]), master, vault, first.reference)).rejects.toThrow();
    const version = first.frame.slice(); version[9] = 2;
    await expect(decryptObject(version, master, vault, first.reference)).rejects.toThrow();
    const nonce = first.frame.slice(); nonce[13] = 12;
    await expect(decryptObject(nonce, master, vault, first.reference)).rejects.toThrow();
    const huge = first.frame.slice(); huge.fill(255, 64, 72);
    await expect(decryptObject(huge, master, vault, first.reference)).rejects.toThrow();
    const flags = first.frame.slice(); flags[15] = 1;
    await expect(decryptObject(flags, master, vault, first.reference)).rejects.toThrow();
    await expect(encryptChunk(new Uint8Array(0), master, vault)).rejects.toThrow();
    await expect(encryptChunk(new Uint8Array(CHUNK_SIZE + 1), master, vault)).rejects.toThrow();
  });
  test("public reference-set MAC binds identities and references", async () => {
    const obj = await encryptRandomized("manifest", data, master, vault);
    const envelope: RevisionEnvelope = {
      protocolVersion: 1, revisionFormatVersion: 1, vaultId: vault as RevisionEnvelope["vaultId"],
      revisionId: "123e4567-e89b-42d3-a456-426614174002" as RevisionEnvelope["revisionId"],
      parents: [], creatingDeviceId: "123e4567-e89b-42d3-a456-426614174003" as RevisionEnvelope["creatingDeviceId"],
      createdAt: "2026-01-02T03:04:05.006Z", encryptedManifestObjectId: obj.reference.objectId,
      references: [obj.reference], referenceSetMac: "0".repeat(64) as RevisionEnvelope["referenceSetMac"],
    };
    envelope.referenceSetMac = await referenceSetMac(envelope, master) as RevisionEnvelope["referenceSetMac"];
    expect(await verifyReferenceSetMac(envelope, master)).toBe(true);
    expect(await verifyReferenceSetMac({ ...envelope, createdAt: "2026-01-02T03:04:05.007Z" }, master)).toBe(false);
    expect(await verifyReferenceSetMac(envelope, badKey)).toBe(false);
  });
  test("manifest and revision-private use random nonce and independent keys", async () => {
    const a = await encryptRandomized("manifest", data, master, vault);
    const b = await encryptRandomized("manifest", data, master, vault);
    const c = await encryptRandomized("revision-private", data, master, vault);
    expect(a.frame.length).toBe(80 + 12 + data.length + 16);
    expect(a.reference.objectId).not.toBe(b.reference.objectId);
    expect(a.frame).not.toEqual(b.frame);
    expect(await decryptObject(a.frame, master, vault, a.reference)).toEqual(data);
    expect(await decryptObject(c.frame, master, vault, c.reference)).toEqual(data);
    await expect(decryptObject(a.frame, master, vault, { ...a.reference, objectType: "revision-private" })).rejects.toThrow();
    const altered = a.frame.slice(); altered[92] = altered[92]! ^ 1;
    await expect(decryptObject(altered, master, vault, a.reference)).rejects.toThrow();
  });
  test("object inputs and reference are snapped before any asynchronous crypto", async () => {
    const original = data.slice(), plaintext = data.slice(), key = master.slice();
    const pending = encryptChunk(plaintext, key, vault);
    plaintext.fill(0); key.fill(0);
    const obj = await pending;
    expect(await decryptObject(obj.frame, master, vault, obj.reference)).toEqual(original);
    const randomPlaintext = data.slice(), randomKey = master.slice();
    const pendingRandom = encryptRandomized("manifest", randomPlaintext, randomKey, vault);
    randomPlaintext.fill(0); randomKey.fill(0);
    const randomized = await pendingRandom;
    expect(await decryptObject(randomized.frame, master, vault, randomized.reference)).toEqual(original);
    const frame = randomized.frame.slice(), decryptKey = master.slice(), reference = { ...randomized.reference };
    const pendingDecrypt = decryptObject(frame, decryptKey, vault, reference);
    frame.fill(0); decryptKey.fill(0); reference.ciphertextChecksum = "0".repeat(64) as typeof reference.ciphertextChecksum;
    reference.objectId = "0".repeat(64) as typeof reference.objectId;
    expect(await pendingDecrypt).toEqual(original);
    const corrupted = randomized.frame.slice(); corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 1;
    await expect(decryptObject(corrupted, master, vault, randomized.reference)).rejects.toThrow();
    await expect(decryptObject(randomized.frame, master, vault, { ...randomized.reference, ciphertextChecksum: "0".repeat(64) as typeof reference.ciphertextChecksum })).rejects.toThrow();
    await expect(decryptObject(randomized.frame, master, vault, { ...randomized.reference, extraneous: true } as typeof reference)).rejects.toThrow();
  });
  test("streaming chunk split across boundaries and empty file", async () => {
    const input = new Uint8Array(CHUNK_SIZE + 3).fill(42);
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(input.subarray(0, 1)); controller.enqueue(input.subarray(1, CHUNK_SIZE - 1));
      controller.enqueue(input.subarray(CHUNK_SIZE - 1)); controller.close();
    } });
    const chunks = [];
    for await (const chunk of encryptFileChunks(stream, master, vault)) chunks.push(chunk);
    expect(chunks.map(c => c.frame.length)).toEqual([CHUNK_SIZE + 96, 99]);
    expect(await decryptObject(chunks[0]!.frame, master, vault, chunks[0]!.reference)).toEqual(input.subarray(0, CHUNK_SIZE));
    expect(await decryptObject(chunks[1]!.frame, master, vault, chunks[1]!.reference)).toEqual(input.subarray(CHUNK_SIZE));
    const empty = new ReadableStream<Uint8Array>({ start(c) { c.close(); } });
    expect((await Array.fromAsync(encryptFileChunks(empty, master, vault))).length).toBe(0);
    const exact = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(input.subarray(0, CHUNK_SIZE)); c.close(); } });
    expect((await Array.fromAsync(encryptFileChunks(exact, master, vault))).length).toBe(1);
  });
  test("early consumer break cancels source and releases reader", async () => {
    let cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      start(c) { c.enqueue(new Uint8Array(CHUNK_SIZE)); },
      cancel() { cancelled = true; return new Promise<void>(() => {}); },
    });
    const mutableKey = master.slice();
    for await (const obj of encryptFileChunks(source, mutableKey, vault)) {
      expect(obj.frame.length).toBe(CHUNK_SIZE + 96);
      mutableKey.fill(0);
      break;
    }
    expect(cancelled).toBe(true);
    expect(source.locked).toBe(false);
  });
  test("50 GB virtual source is pulled in bounded natural order, not buffered or fully uploaded", async () => {
    const virtualBytes = 50_000_000_000;
    const segment = new Uint8Array(64 * 1024);
    let produced = 0, peakSegment = 0, cancelled = false;
    const source = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (produced === virtualBytes) { controller.close(); return; }
        const length = Math.min(segment.length, virtualBytes - produced);
        segment.fill(Math.floor(produced / CHUNK_SIZE) + 1);
        controller.enqueue(segment.slice(0, length));
        produced += length;
        peakSegment = Math.max(peakSegment, length);
      },
      cancel() { cancelled = true; }
    }, { highWaterMark: 0 });
    const iterator = encryptFileChunks(source, master, vault);
    const first = (await iterator.next()).value!;
    const second = (await iterator.next()).value!;
    expect(first.frame.length).toBe(CHUNK_SIZE + 96);
    expect(second.frame.length).toBe(CHUNK_SIZE + 96);
    expect(first.reference.objectId).not.toBe(second.reference.objectId);
    expect((await decryptObject(first.frame, master, vault, first.reference))[0]).toBe(1);
    expect((await decryptObject(second.frame, master, vault, second.reference))[0]).toBe(2);
    expect(produced).toBeLessThanOrEqual(3 * CHUNK_SIZE);
    expect(peakSegment).toBeLessThanOrEqual(64 * 1024);
    await iterator.return(undefined);
    expect(cancelled).toBe(true);
    expect(produced).toBeLessThan(virtualBytes);
  });
  test("stream keeps the key from first pull while awaiting a source fragment", async () => {
    let feed!: (chunk: Uint8Array) => void;
    const source = new ReadableStream<Uint8Array>({ start(controller) {
      feed = chunk => { controller.enqueue(chunk); controller.close(); };
    } });
    const key = master.slice();
    const iterator = encryptFileChunks(source, key, vault);
    const pending = iterator.next();
    key.fill(0);
    feed(data.slice());
    const { value } = await pending;
    expect(value).toBeDefined();
    expect(await decryptObject(value!.frame, master, vault, value!.reference)).toEqual(data);
    expect((await iterator.next()).done).toBe(true);
  });
});
