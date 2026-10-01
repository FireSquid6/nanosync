import { describe, expect, test } from "bun:test";
import { planRestore, planRestoreRevision, manifestPaths, parseManifest } from "../src/index.ts";
const a = "11111111-1111-4111-8111-111111111111";
const b = "22222222-2222-4222-8222-222222222222";
const c = "33333333-3333-4333-8333-333333333333";
const d = "44444444-4444-4444-8444-444444444444";
const e = "55555555-5555-4555-8555-555555555555";
const sha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const base = { version: 1, vaultId: a, revisionId: b, parents: [], creatingDeviceId: c,
  entries: [{ id: d, parentId: null, name: "", kind: "directory" },
    { id: e, parentId: d, name: "hello", kind: "file", size: 0, sha256: sha, chunks: [], executable: false }] };
describe("restore planning", () => {
  test("new revision branches from current accepted manifest, preserving identity", () => {
    const historical = parseManifest(base);
    const current = parseManifest({ ...base, revisionId: a, parents: [b], entries: [base.entries[0],
      { ...base.entries[1], name: "hello", executable: true }] });
    const restored = planRestore(current, historical, "hello", c, c, a);
    expect(restored.parents).toEqual([a]);
    expect(restored.entries.find(x => x.id === e)?.executable).toBe(false);
    expect(manifestPaths(restored).get("hello")?.id).toBe(e);
  });
  test("single-file restore retains the current identity's immutable conflict lineage", () => {
    const historical = parseManifest(base);
    const lineage = { sourceEntryId: a, sourceRevisionId: b };
    const current = parseManifest({ ...base, revisionId: a, parents: [b], entries: [base.entries[0],
      { ...base.entries[1], executable: true, conflict: lineage }] });
    const restored = planRestore(current, historical, "hello", c, c, a);
    expect(manifestPaths(restored).get("hello")?.conflict).toEqual(lineage);
    expect(manifestPaths(restored).get("hello")?.executable).toBe(false);
    const earlierLineage = parseManifest({ ...base, entries: [base.entries[0],
      { ...base.entries[1], conflict: { sourceEntryId: c, sourceRevisionId: b } }] });
    expect(manifestPaths(planRestore(current, earlierLineage, "hello", b, c, a)).get("hello")?.conflict).toEqual(lineage);
  });
  test("rejects unsafe path and missing parent", () => {
    expect(() => planRestore(parseManifest(base), parseManifest(base), "../hello", c, c, b)).toThrow();
    expect(() => planRestore(parseManifest(base), parseManifest(base), "hello", c, c, a)).toThrow(/accepted/);
  });
  test("restores a deleted path as a new identity and archives its tombstone without rewinding", () => {
    const historical = parseManifest(base);
    const deleted = parseManifest({ ...base, revisionId: a, parents: [b], entries: [base.entries[0],
      { id: e, parentId: d, name: "hello", kind: "tombstone", deletedKind: "file" }] });
    const planned = planRestore(deleted, historical, "hello", c, c, a);
    const live = manifestPaths(planned).get("hello")!;
    expect(planned.parents).toEqual([a]);
    expect(live.kind).toBe("file");
    expect(live.id).not.toBe(e);
    const archived = planned.entries.find(entry => entry.id === e)!;
    expect(archived.kind).toBe("tombstone");
    expect(archived.name).toBe(`hello (deleted ${e})`);
    expect(planRestore(planned, historical, "hello", a, c, c).entries.find(entry => entry.id === e)?.kind).toBe("tombstone");
  });
  test("archival retries occupied tombstone suffixes and respects 255-byte names", () => {
    const long = "x".repeat(251);
    const historical = parseManifest({ ...base, entries: [base.entries[0], { ...base.entries[1], name: long }] });
    const tombstone = { id: e, parentId: d, name: long, kind: "tombstone", deletedKind: "file" };
    const occupied = `${"x".repeat(255 - ` (deleted ${e})`.length)} (deleted ${e})`;
    const current = parseManifest({ ...base, revisionId: a, parents: [b], entries: [base.entries[0], tombstone,
      { id: c, parentId: d, name: occupied, kind: "tombstone", deletedKind: "file" }] });
    const planned = planRestore(current, historical, long, c, c, a);
    const archived = planned.entries.find(entry => entry.id === e)!;
    expect(archived.name).toContain(`(deleted ${e}-1)`);
    expect(new TextEncoder().encode(archived.name).length).toBeLessThanOrEqual(255);
    expect(manifestPaths(planned).get(long)?.kind).toBe("file");
  });
});

describe("whole-revision restore planning", () => {
  test("replaces the live tree while retaining surviving IDs, old tombstones and conflict lineage", () => {
    const historic = parseManifest({ ...base, entries: [base.entries[0], base.entries[1],
      { id: a, parentId: d, name: "folder", kind: "directory" },
      { id: b, parentId: a, name: "nested", kind: "file", size: 0, sha256: sha, chunks: [], executable: false }] });
    const current = parseManifest({ ...base, revisionId: c, parents: [b], entries: [base.entries[0],
      { ...base.entries[1], name: "renamed", executable: true, conflict: { sourceEntryId: a, sourceRevisionId: b } },
      { id: a, parentId: d, name: "folder", kind: "tombstone", deletedKind: "directory" },
      { id: b, parentId: d, name: "nested", kind: "tombstone", deletedKind: "file" },
      { id: c, parentId: d, name: "added", kind: "file", size: 0, sha256: sha, chunks: [], executable: false }] });
    const restored = planRestoreRevision(current, historic, a, c, c);
    expect(restored.parents).toEqual([c]);
    expect(manifestPaths(restored).get("hello")?.id).toBe(e);
    expect(restored.entries.find(x => x.id === e)?.conflict).toEqual({ sourceEntryId: a, sourceRevisionId: b });
    const folder = manifestPaths(restored).get("folder")!;
    expect(folder.id).not.toBe(a);
    expect(manifestPaths(restored).get("folder/nested")?.id).not.toBe(b);
    expect(restored.entries.find(x => x.id === a)?.kind).toBe("tombstone");
    expect(restored.entries.find(x => x.id === b)?.kind).toBe("tombstone");
    expect(restored.entries.find(x => x.id === c)?.kind).toBe("tombstone");
    expect(manifestPaths(restored).get("added")?.kind).not.toBe("file");
  });
  test("archives colliding tombstones without creating invalid long names", () => {
    const long = "x".repeat(250);
    const historic = parseManifest({ ...base, entries: [base.entries[0], { ...base.entries[1], name: long }] });
    const current = parseManifest({ ...base, revisionId: c, parents: [b], entries: [base.entries[0],
      { id: a, parentId: d, name: long, kind: "tombstone", deletedKind: "file" },
      { id: b, parentId: d, name: `${long.slice(0, 200)} (deleted ${a})`, kind: "tombstone", deletedKind: "file" }] });
    const restored = planRestoreRevision(current, historic, a, c, c);
    expect(manifestPaths(restored).get(long)?.kind).toBe("file");
    expect(restored.entries.find(x => x.id === a)?.name).toContain(`(deleted ${a})`);
    expect(restored.entries.every(x => new TextEncoder().encode(x.name).length <= 255)).toBe(true);
    expect(() => planRestoreRevision(current, historic, a, c, b)).toThrow(/accepted/);
    expect(() => planRestoreRevision(current, { ...historic, vaultId: c }, a, c, c)).toThrow(/vault/);
  });
});
