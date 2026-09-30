import { expect, test } from "bun:test";
import { encodeManifest, mergeManifests, parseManifest, type ManifestEntry, type ManifestV1 } from "../src/index.ts";

const id = (n: number) => `123e4567-e89b-42d3-a456-${n.toString(16).padStart(12, "0")}`;
const vaultId = id(1), rootId = id(2), fileId = id(3);
const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const root: ManifestEntry = { id: rootId, parentId: null, name: "", kind: "directory" };
const file: ManifestEntry = { id: fileId, parentId: rootId, name: "notes.txt", kind: "file", size: 0, sha256: hash, executable: false, chunks: [] };
const base = (): ManifestV1 => ({ version: 1, vaultId, revisionId: id(4), parents: [], creatingDeviceId: id(5), entries: [root, file] });
const side = (b: ManifestV1, revision: number, device: number, entries: ManifestEntry[]): ManifestV1 =>
  ({ ...b, revisionId: id(revision), parents: [b.revisionId], creatingDeviceId: id(device), entries });
const opts = { revisionId: id(10), creatingDeviceId: id(11), localCreatedAt: "2026-01-02T03:04:05.006Z", remoteCreatedAt: "2026-02-03T04:05:06.007Z" };
const merge = (b: ManifestV1, l: ManifestV1, r: ManifestV1) => mergeManifests(b, l, r, opts);
const edit = (e: ManifestEntry, n: number): ManifestEntry => ({ ...e, size: 1, chunks: [{ objectId: n.toString(16).padStart(64, "0"), length: 1 }], sha256: n.toString(16).padStart(64, "0"), executable: !!(n % 2) });
const find = (entries: ManifestEntry[], entryId: string) => entries.find(e => e.id === entryId)!;

test("offline concurrent edits preserve remote identity, local content and deterministic conflict lineage", async () => {
  const b = base(), l = side(b, 6, 7, [root, edit(file, 1)]), r = side(b, 8, 9, [root, edit(file, 2)]);
  const first = await merge(b, l, r), second = await merge(b, l, r);
  expect(first).toEqual(second);
  expect(first.manifest.parents).toEqual([l.revisionId, r.revisionId].sort());
  expect(first.manifest.creatingDeviceId).toBe(opts.creatingDeviceId);
  expect(find(first.manifest.entries, fileId).sha256).toBe(edit(file, 2).sha256);
  const copy = first.manifest.entries.find(e => e.conflict?.sourceEntryId === fileId)!;
  expect(copy.id).not.toBe(fileId);
  expect(copy.sha256).toBe(edit(file, 1).sha256);
  expect(copy.conflict?.sourceRevisionId).toBe(l.revisionId);
  expect(copy.name).toContain("conflict");
  expect(copy.name).toContain("20260102T030405006Z");
  expect(() => parseManifest(first.manifest)).not.toThrow();
});

test("delete/edit retains original tombstone and edited conflict copy regardless of side", async () => {
  const b = base(), gone: ManifestEntry = { id: fileId, parentId: rootId, name: file.name, kind: "tombstone", deletedKind: "file" };
  for (const localDeletes of [true, false]) {
    const result = await merge(b, side(b, 6, 7, [root, localDeletes ? gone : edit(file, 1)]),
      side(b, 8, 9, [root, localDeletes ? edit(file, 2) : gone]));
    expect(find(result.manifest.entries, fileId)).toEqual(gone);
    const copy = result.manifest.entries.find(e => e.conflict?.sourceEntryId === fileId)!;
    expect(copy.kind).toBe("file");
    expect(copy.sha256).toBe(edit(file, localDeletes ? 2 : 1).sha256);
    expect(copy.name).not.toBe(file.name);
  }
});

test("delete against an unchanged file does not restore it or create a false conflict", async () => {
  const b = base(), tomb: ManifestEntry = { id: fileId, parentId: rootId, name: file.name, kind: "tombstone", deletedKind: "file" };
  const result = await merge(b, side(b, 6, 7, [root, tomb]), side(b, 8, 9, [root, file]));
  expect(result.manifest.entries).toEqual(parseManifest({ ...result.manifest, entries: [root, tomb] }).entries);
  expect(result.conflicts).toEqual([]);
});

test("deleting a conflict copy drops its lineage only on the tombstone", async () => {
  const conflicted: ManifestEntry = { ...file, conflict: { sourceEntryId: id(16), sourceRevisionId: id(17) } };
  const b = base(); b.entries = [root, conflicted];
  const tomb: ManifestEntry = { id: fileId, parentId: rootId, name: file.name, kind: "tombstone", deletedKind: "file" };
  const result = await merge(b, side(b, 6, 7, [root, tomb]), side(b, 8, 9, [root, conflicted]));
  expect(find(result.manifest.entries, fileId)).toEqual(tomb);
  expect(result.conflicts).toEqual([]);
  await expect(merge(b, side(b, 6, 7, [root, { ...file }]), side(b, 8, 9, [root, conflicted])))
    .rejects.toThrow(/ambiguous identity lineage/);
});

test("rename and modify combine on one identity, independent changes combine", async () => {
  const b = base(), other: ManifestEntry = { ...file, id: id(12), name: "other" };
  b.entries.push(other);
  const result = await merge(b, side(b, 6, 7, [root, { ...file, name: "moved" }, other]),
    side(b, 8, 9, [root, edit(file, 1), edit(other, 2)]));
  expect(result.conflicts).toEqual([]);
  expect(find(result.manifest.entries, fileId)).toMatchObject({ id: fileId, name: "moved", sha256: edit(file, 1).sha256 });
  expect(find(result.manifest.entries, other.id).sha256).toBe(edit(other, 2).sha256);
});

test("divergent moves surface a location conflict, collisions rename without overwriting", async () => {
  const b = base(), other: ManifestEntry = { ...file, id: id(12), name: "another" };
  b.entries.push(other);
  const result = await merge(b, side(b, 6, 7, [root, { ...file, name: "local" }, { ...other, name: "remote" }]),
    side(b, 8, 9, [root, { ...file, name: "remote" }, other]));
  expect(find(result.manifest.entries, fileId).name).toBe("remote");
  expect(find(result.manifest.entries, other.id).name).toContain("conflict");
  expect(result.conflicts.map(c => c.kind)).toContain("location");
  expect(result.conflicts.map(c => c.kind)).toContain("name");
});

test("directory deletion preserves descendants modified offline in a rescue directory", async () => {
  const b = base(), directory: ManifestEntry = { id: id(13), parentId: rootId, name: "folder", kind: "directory" };
  b.entries = [root, directory, { ...file, parentId: directory.id }];
  const tomb: ManifestEntry = { ...directory, kind: "tombstone", deletedKind: "directory" };
  const result = await merge(b, side(b, 6, 7, [root, tomb]),
    side(b, 8, 9, [root, directory, { ...edit(file, 1), parentId: directory.id, name: "renamed" }]));
  expect(find(result.manifest.entries, directory.id).kind).toBe("tombstone");
  const rescued = result.manifest.entries.find(e => e.conflict?.sourceEntryId === directory.id)!;
  expect(rescued.kind).toBe("directory");
  expect(find(result.manifest.entries, fileId).parentId).toBe(rescued.id);
  expect(() => encodeManifest(result.manifest)).not.toThrow();
  const unchanged = await merge(b, side(b, 6, 7, [root, tomb]), side(b, 8, 9, b.entries));
  expect(unchanged.manifest.entries.map(e => e.id).sort()).toEqual([rootId, directory.id].sort());
  expect(unchanged.conflicts).toEqual([]);
});

test("delete versus directory rename/move preserves the entire surviving subtree in both side orders", async () => {
  const b = base(), folder: ManifestEntry = { id: id(35), parentId: rootId, name: "folder", kind: "directory" };
  const nested: ManifestEntry = { id: id(14), parentId: folder.id, name: "nested", kind: "directory" };
  const oldFile = { ...file, parentId: nested.id };
  const historical: ManifestEntry = { id: id(15), parentId: nested.id, name: "old", kind: "tombstone", deletedKind: "file" };
  const destination: ManifestEntry = { id: id(16), parentId: rootId, name: "destination", kind: "directory" };
  const added: ManifestEntry = { ...file, id: id(17), parentId: nested.id, name: "added" };
  b.entries = [root, folder, nested, oldFile, historical, destination];
  const tomb: ManifestEntry = { ...folder, kind: "tombstone", deletedKind: "directory" };
  const moved = { ...folder, parentId: destination.id, name: "renamed" };
  for (const localDeletes of [true, false]) {
    const left = side(b, 6, 7, localDeletes ? [root, tomb, destination] : [root, moved, nested, oldFile, historical, destination, added]);
    const right = side(b, 8, 9, localDeletes ? [root, moved, nested, oldFile, historical, destination, added] : [root, tomb, destination]);
    const result = await merge(b, left, right);
    expect(find(result.manifest.entries, folder.id)).toEqual(tomb);
    const rescue = result.manifest.entries.find(e => e.conflict?.sourceEntryId === folder.id)!;
    expect(rescue).toMatchObject({ kind: "directory", parentId: destination.id, name: "renamed",
      conflict: { sourceRevisionId: localDeletes ? right.revisionId : left.revisionId } });
    expect(rescue.id).not.toBe(folder.id);
    expect(find(result.manifest.entries, nested.id)).toMatchObject({ parentId: rescue.id, name: "nested" });
    expect(find(result.manifest.entries, fileId)).toMatchObject(oldFile);
    expect(find(result.manifest.entries, historical.id)).toMatchObject(historical);
    expect(find(result.manifest.entries, added.id)).toMatchObject(added);
    expect(result.conflicts.filter(c => c.kind === "directory-delete" && c.entryId === folder.id)).toEqual([
      { kind: "directory-delete", entryId: folder.id, copyId: rescue.id },
    ]);
    expect(result).toEqual(await merge(b, left, right));
  }
});

test("delete versus new child rescues unchanged siblings even without renaming the directory", async () => {
  const b = base(), folder: ManifestEntry = { id: id(35), parentId: rootId, name: "folder", kind: "directory" };
  const existing = { ...file, parentId: folder.id };
  const added = { ...file, id: id(37), parentId: folder.id, name: "new" };
  b.entries = [root, folder, existing];
  const tomb: ManifestEntry = { ...folder, kind: "tombstone", deletedKind: "directory" };
  for (const localDeletes of [true, false]) {
    const deleting = [root, tomb], surviving = [root, folder, existing, added];
    const result = await merge(b, side(b, 6, 7, localDeletes ? deleting : surviving), side(b, 8, 9, localDeletes ? surviving : deleting));
    const rescue = result.manifest.entries.find(e => e.conflict?.sourceEntryId === folder.id)!;
    expect(find(result.manifest.entries, folder.id)).toEqual(tomb);
    expect(find(result.manifest.entries, fileId).parentId).toBe(rescue.id);
    expect(find(result.manifest.entries, added.id).parentId).toBe(rescue.id);
    expect(rescue.name).toContain("conflict");
  }
});

test("delete versus directory rename into occupied name never overwrites and uses source conflict label", async () => {
  const b = base(), folder: ManifestEntry = { id: id(35), parentId: rootId, name: "folder", kind: "directory" };
  const occupant: ManifestEntry = { id: id(36), parentId: rootId, name: "target", kind: "directory" };
  b.entries = [root, folder, { ...file, parentId: folder.id }];
  for (const localDeletes of [true, false]) {
    const deleting = [root, { ...folder, kind: "tombstone" as const, deletedKind: "directory" as const }, occupant];
    const moving = [root, { ...folder, name: "target" }, { ...file, parentId: folder.id }];
    const result = await merge(b, side(b, 6, 7, localDeletes ? deleting : moving), side(b, 8, 9, localDeletes ? moving : deleting));
    const rescue = result.manifest.entries.find(e => e.conflict?.sourceEntryId === folder.id)!;
    const renamed = localDeletes ? find(result.manifest.entries, occupant.id) : rescue;
    expect(renamed.name).toContain("conflict");
    expect(renamed.name).toContain("20260102T030405006Z");
    expect(localDeletes ? rescue.name : find(result.manifest.entries, occupant.id).name).toBe("target");
    expect(find(result.manifest.entries, fileId).parentId).toBe(rescue.id);
  }
});

test("tombstones omitted under deleted ancestors survive, including when both branches delete the ancestor", async () => {
  const b = base(), folder: ManifestEntry = { id: id(35), parentId: rootId, name: "folder", kind: "directory" };
  const nested: ManifestEntry = { id: id(14), parentId: folder.id, name: "nested", kind: "directory" };
  const previous: ManifestEntry = { id: id(15), parentId: nested.id, name: "gone", kind: "tombstone", deletedKind: "file" };
  b.entries = [root, folder, nested, previous];
  const tomb: ManifestEntry = { ...folder, kind: "tombstone", deletedKind: "directory" };
  const left = side(b, 6, 7, [root, tomb]);
  const right = side(b, 8, 9, [root, tomb]);
  const result = await merge(b, left, right);
  expect(find(result.manifest.entries, previous.id).kind).toBe("tombstone");
  const rescue = result.manifest.entries.find(e => e.conflict?.sourceEntryId === folder.id)!;
  expect(find(result.manifest.entries, nested.id)).toMatchObject({ kind: "tombstone", parentId: rescue.id });
  expect(find(result.manifest.entries, previous.id).parentId).toBe(result.manifest.entries.find(e => e.conflict?.sourceEntryId === nested.id)!.id);
});

test("long NFC names fit 255 bytes and occupied conflict suffixes retry deterministically", async () => {
  const b = base(), longName = "é".repeat(120) + ".txt";
  b.entries[1] = { ...file, name: longName };
  const local = side(b, 6, 7, [root, edit(b.entries[1]!, 1)]);
  const remote = side(b, 8, 9, [root, edit(b.entries[1]!, 2)]);
  const first = await merge(b, local, remote);
  const conflictName = first.manifest.entries.find(e => e.id !== rootId && e.id !== fileId)!.name;
  expect(new TextEncoder().encode(conflictName).length).toBeLessThanOrEqual(255);
  const occupying: ManifestEntry = { ...file, id: id(30), name: conflictName };
  const again = await merge(b, local, { ...remote, entries: [...remote.entries, occupying] });
  expect(again.manifest.entries.find(e => e.conflict?.sourceEntryId === fileId)?.name).not.toBe(conflictName);
  expect(again.manifest.entries.find(e => e.id === occupying.id)?.name).toBe(conflictName);
  expect(again).toEqual(await merge(b, local, { ...remote, entries: [...remote.entries, occupying] }));
});

test("rejects malformed ancestry, vault, root, missing identities, resurrection and invalid names", async () => {
  const b = base(), l = side(b, 6, 7, [root, file]), r = side(b, 8, 9, [root, file]);
  const bad: [ManifestV1, ManifestV1, ManifestV1][] = [
    [b, { ...l, vaultId: id(22) }, r], [b, { ...l, parents: [] }, r],
    [b, { ...l, entries: [root] }, r],
    [b, { ...l, entries: [{ ...root, id: id(31) }, file] }, r],
    [b, { ...l, entries: [root, { ...file, name: "e\u0301" }] }, r],
    [b, { ...l, entries: [root, { id: fileId, parentId: rootId, name: file.name, kind: "directory" }] }, r],
    [b, { ...l, entries: [root, { ...file, conflict: { sourceEntryId: id(39), sourceRevisionId: b.revisionId } }] }, r],
  ];
  for (const args of bad) await expect(merge(...args)).rejects.toThrow();
  const old = { ...b, entries: [root, { id: fileId, parentId: rootId, name: "notes.txt", kind: "tombstone" as const, deletedKind: "file" as const }] };
  await expect(merge(old, side(old, 6, 7, [root, file]), side(old, 8, 9, old.entries))).rejects.toThrow(/identity kind transition/);
});
