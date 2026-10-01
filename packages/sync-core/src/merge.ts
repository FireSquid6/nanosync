import { parseDeviceId, parseRevisionId } from "@nanosync/protocol";
import { encodeManifest, parseManifest, type ManifestEntry, type ManifestV1 } from "./manifest.ts";

export interface MergeConflict {
  kind: "content" | "delete-edit" | "location" | "name" | "directory-delete";
  entryId: string;
  copyId?: string;
}
export interface MergeOptions {
  revisionId: string;
  creatingDeviceId: string;
  localCreatedAt: string;
  remoteCreatedAt: string;
}
export interface MergeResult { manifest: ManifestV1; conflicts: MergeConflict[] }

const encoder = new TextEncoder();
const byId = (m: ManifestV1) => new Map(m.entries.map(e => [e.id, e]));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const position = (e: ManifestEntry) => [e.parentId, e.name];
const content = (e: ManifestEntry) => e.kind === "file" ? [e.kind, e.size, e.sha256, e.executable, e.chunks] : [e.kind, e.deletedKind];
const changed = (a: ManifestEntry, b: ManifestEntry) => !same(position(a), position(b)) || !same(content(a), content(b));
const live = (e: ManifestEntry) => e.kind !== "tombstone";
const key = (e: ManifestEntry) => `${e.parentId}/${e.name.toLowerCase()}`;

function timestamp(value: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) throw new Error("invalid merge timestamp");
  return value;
}
function hex(bytes: Uint8Array): string { return Array.from(bytes, b => b.toString(16).padStart(2, "0")).join(""); }
async function stableId(seed: string): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(`nanosync/v1/merge/${seed}`)));
  bytes[6] = (bytes[6]! & 15) | 64;
  bytes[8] = (bytes[8]! & 63) | 128;
  const h = hex(bytes.subarray(0, 16));
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
function shorten(value: string, max: number): string {
  let out = "";
  for (const ch of value) {
    if (encoder.encode(out + ch).length > max) break;
    out += ch;
  }
  return out.replace(/[. ]+$/u, "") || "entry";
}

/** Merge authenticated/decrypted v1 manifests. Does not publish or inspect ciphertext. */
export async function mergeManifests(baseInput: unknown, localInput: unknown, remoteInput: unknown, options: MergeOptions): Promise<MergeResult> {
  const base = parseManifest(baseInput), local = parseManifest(localInput), remote = parseManifest(remoteInput);
  const revisionId = parseRevisionId(options.revisionId), creatingDeviceId = parseDeviceId(options.creatingDeviceId);
  const times = { local: timestamp(options.localCreatedAt), remote: timestamp(options.remoteCreatedAt) };
  if (base.vaultId !== local.vaultId || base.vaultId !== remote.vaultId ||
      !local.parents.includes(base.revisionId) || !remote.parents.includes(base.revisionId) ||
      new Set([base.revisionId, local.revisionId, remote.revisionId, revisionId]).size !== 4) throw new Error("merge ancestry or vault mismatch");
  const b = byId(base), l = byId(local), r = byId(remote);
  for (const branch of [l, r]) for (const [id, previous] of b) {
    const current = branch.get(id);
    // Tombstones cannot carry lineage in the v1 manifest format. Deleting a
    // conflict copy legitimately drops that field; live identities cannot.
    if (current && current.kind !== "tombstone" && !same(current.conflict, previous.conflict))
      throw new Error(`ambiguous identity lineage: ${id}`);
    if (current && current.kind !== previous.kind &&
        !(current.kind === "tombstone" && previous.kind !== "tombstone" && current.deletedKind === previous.kind))
      throw new Error(`invalid identity kind transition: ${id}`);
    if (previous.kind === "tombstone" && current && current.deletedKind !== previous.deletedKind)
      throw new Error(`invalid tombstone transition: ${id}`);
  }
  const root = base.entries.find(e => e.parentId === null)!;
  if (!same(l.get(root.id), root) || !same(r.get(root.id), root)) throw new Error("root identity changed");
  for (const side of [local, remote]) if (side.entries.find(e => e.parentId === null)!.id !== root.id) throw new Error("root identity changed");
  const entries = new Map<string, ManifestEntry>();
  const conflicts: MergeConflict[] = [];
  const origins = new Map<string, "local" | "remote">();
  const rescues = new Map<string, string>();
  const forced = new Set<string>();
  const rescueRequired = new Set<string>();
  const ids = new Set([...b.keys(), ...l.keys(), ...r.keys()]);
  // IDs from all inputs are reserved, including entries omitted by a directory deletion.
  async function allocate(seed: string): Promise<string> {
    for (let i = 0; i < 32; i++) {
      const id = await stableId(`${base.vaultId}/${base.revisionId}/${local.revisionId}/${remote.revisionId}/${seed}/${i}`);
      if (!ids.has(id)) { ids.add(id); return id; }
    }
    throw new Error("merge identity collision limit exceeded");
  }
  function deletion(id: string, side: Map<string, ManifestEntry>): ManifestEntry | undefined {
    const explicit = side.get(id);
    if (explicit) return explicit;
    let ancestor = b.get(id);
    while (ancestor?.parentId) {
      ancestor = b.get(ancestor.parentId);
      if (ancestor && side.get(ancestor.id)?.kind === "tombstone") return undefined;
    }
    throw new Error(`entry missing without directory tombstone: ${id}`);
  }
  function descendants(side: Map<string, ManifestEntry>, directoryId: string): void {
    for (const entry of side.values()) {
      let parentId = entry.parentId;
      while (parentId !== null) {
        if (parentId === directoryId) { forced.add(entry.id); break; }
        parentId = side.get(parentId)?.parentId ?? null;
      }
    }
  }
  function changedAncestors(side: Map<string, ManifestEntry>): Set<string> {
    const ancestors = new Set<string>();
    for (const entry of side.values()) {
      const old = b.get(entry.id);
      if (old && !changed(old, entry)) continue;
      let parentId = entry.parentId;
      while (parentId !== null) {
        if (ancestors.has(parentId)) break;
        ancestors.add(parentId);
        parentId = side.get(parentId)?.parentId ?? null;
      }
    }
    return ancestors;
  }
  const changedLocalAncestors = changedAncestors(l), changedRemoteAncestors = changedAncestors(r);
  for (const [id, previous] of b) {
    if (previous.kind !== "directory") continue;
    if (l.get(id)?.kind === "tombstone" && r.get(id)?.kind === "directory" && (changed(previous, r.get(id)!) || changedRemoteAncestors.has(id)) ||
        r.get(id)?.kind === "tombstone" && l.get(id)?.kind === "directory" && (changed(previous, l.get(id)!) || changedLocalAncestors.has(id))) {
      rescueRequired.add(id);
      descendants(l.get(id)?.kind === "tombstone" ? r : l, id);
    }
  }
  for (const id of [...ids].sort()) {
    const old = b.get(id), a = old ? deletion(id, l) : l.get(id), z = old ? deletion(id, r) : r.get(id);
    if (!old) {
      if (a && z && !same(a, z)) throw new Error(`concurrent reuse of new identity: ${id}`);
      if (a || z) { entries.set(id, (a ?? z)!); origins.set(id, a ? "local" : "remote"); }
      continue;
    }
    if (old.kind === "tombstone") {
      if (a && z && !same(position(a), position(z)) &&
          !same(position(a), position(old)) && !same(position(z), position(old)))
        throw new Error(`ambiguous tombstone location: ${id}`);
      entries.set(id, a && !same(position(a), position(old)) ? a : z ?? a ?? old);
      continue;
    }
    if (forced.has(id) && !a && z) { entries.set(id, z); origins.set(id, "remote"); continue; }
    if (forced.has(id) && !z && a) { entries.set(id, a); origins.set(id, "local"); continue; }
    if ((!a && z && !changed(old, z) && !forced.has(id)) ||
        (!z && a && !changed(old, a) && !forced.has(id))) continue;
    if (!a && !z) continue; // both deleted it within a deleted directory
    const left = a ?? { ...old, kind: "tombstone" as const, deletedKind: old.kind as "file" | "directory", chunks: undefined };
    const right = z ?? { ...old, kind: "tombstone" as const, deletedKind: old.kind as "file" | "directory", chunks: undefined };
    // The synthesized deletion is only used for decisions, never emitted with undefined members.
    if (a?.kind === "tombstone" && a.deletedKind !== old.kind ||
        z?.kind === "tombstone" && z.deletedKind !== old.kind) throw new Error(`invalid deletion kind: ${id}`);
    if (!live(left) || !live(right)) {
      const modified = live(left) ? left : right;
      entries.set(id, a && a.kind === "tombstone" ? a : z && z.kind === "tombstone" ? z :
        { id, parentId: old.parentId, name: old.name, kind: "tombstone", deletedKind: old.kind as "file" | "directory" });
      if (live(modified) && (changed(old, modified) || rescueRequired.has(id))) {
        if (modified.kind === "directory") {
          const source = live(left) ? "local" : "remote";
          const copyId = await allocate(`deleted/${id}/${source}`);
          entries.set(copyId, { ...modified, id: copyId,
            conflict: { sourceEntryId: id, sourceRevisionId: source === "local" ? local.revisionId : remote.revisionId } });
          origins.set(copyId, source);
          rescues.set(id, copyId);
          descendants(source === "local" ? l : r, id);
          conflicts.push({ kind: "directory-delete", entryId: id, copyId });
        } else {
          const source = live(left) ? "local" : "remote";
          const copyId = await allocate(`deleted/${id}/${source}`);
          entries.set(copyId, { ...modified, id: copyId, conflict: { sourceEntryId: id, sourceRevisionId: source === "local" ? local.revisionId : remote.revisionId } });
          origins.set(copyId, source);
          conflicts.push({ kind: "delete-edit", entryId: id, copyId });
        }
      }
      continue;
    }
    if (a && z && !changed(old, a)) { entries.set(id, z); origins.set(id, "remote"); continue; }
    if (a && z && !changed(old, z)) { entries.set(id, a); origins.set(id, "local"); continue; }
    if (left.kind !== right.kind || left.kind !== old.kind) throw new Error(`incompatible kind change: ${id}`);
    const leftMoved = !same(position(left), position(old)), rightMoved = !same(position(right), position(old));
    const leftEdited = !same(content(left), content(old)), rightEdited = !same(content(right), content(old));
    const location = rightMoved ? right : left;
    if (leftMoved && rightMoved && !same(position(left), position(right))) conflicts.push({ kind: "location", entryId: id });
    const main = rightEdited ? right : left;
    entries.set(id, { ...main, parentId: location.parentId, name: location.name });
    origins.set(id, rightEdited || rightMoved ? "remote" : "local");
    if (leftEdited && rightEdited && !same(content(left), content(right))) {
      if (left.kind !== "file") throw new Error(`unrepresentable directory edit: ${id}`);
      const copyId = await allocate(`edited/${id}/local`);
      entries.set(copyId, { ...left, id: copyId, parentId: location.parentId, name: location.name,
        conflict: { sourceEntryId: id, sourceRevisionId: local.revisionId } });
      origins.set(copyId, "local");
      conflicts.push({ kind: "content", entryId: id, copyId });
    }
  }

  async function conflictName(entry: ManifestEntry, source: "local" | "remote", attempt: number): Promise<string> {
    const manifest = source === "local" ? local : remote;
    const stamp = times[source].replace(/[-:.]/g, "");
    const suffix = ` (conflict ${manifest.creatingDeviceId.slice(0, 8)} ${stamp} ${manifest.revisionId.slice(0, 8)} ${entry.id.slice(0, 8)}-${attempt})`;
    const dot = entry.kind === "file" ? entry.name.lastIndexOf(".") : -1;
    const extension = dot > 0 ? entry.name.slice(dot) : "";
    const tail = encoder.encode(extension).length < 48 ? extension : "";
    return shorten(entry.name.slice(0, tail ? -tail.length : undefined), 255 - encoder.encode(suffix + tail).length) + suffix + tail;
  }
  // Deleted directories cannot parent entries. Retain their tombstones and rescue
  // surviving children to a new conflict directory under the nearest live ancestor.
  async function validParent(id: string, active = new Set<string>()): Promise<string> {
    if (active.has(id)) throw new Error("merged directory cycle");
    active.add(id);
    let parent = entries.get(id);
    if (!parent && b.get(id)?.kind === "directory") {
      const prior = b.get(id)!;
      parent = { id, parentId: prior.parentId, name: prior.name, kind: "tombstone", deletedKind: "directory" };
      entries.set(id, parent);
    }
    if (!parent) throw new Error(`merged orphan: ${id}`);
    if (parent.kind === "directory") {
      if (parent.parentId) parent.parentId = await validParent(parent.parentId, active);
      return id;
    }
    if (parent.kind !== "tombstone" || parent.deletedKind !== "directory") throw new Error(`merged non-directory parent: ${id}`);
    if (rescues.has(id)) {
      const rescue = entries.get(rescues.get(id)!)!;
      if (rescue.parentId) rescue.parentId = await validParent(rescue.parentId, active);
      return rescue.id;
    }
    const ancestor = await validParent(parent.parentId!, active);
    const rescueId = await allocate(`rescue/${id}`);
    entries.set(rescueId, { id: rescueId, parentId: ancestor, name: parent.name, kind: "directory",
      conflict: { sourceEntryId: id, sourceRevisionId: remote.revisionId } });
    origins.set(rescueId, "remote");
    rescues.set(id, rescueId);
    conflicts.push({ kind: "directory-delete", entryId: id, copyId: rescueId });
    return rescueId;
  }
  for (const entry of entries.values()) if (entry.parentId) entry.parentId = await validParent(entry.parentId);
  // Prioritize the remote head at a contested location; always rename, never overwrite.
  const occupied = new Set<string>();
  const ordered = [...entries.values()].sort((a, b) => {
    const rank = (e: ManifestEntry) => e.kind === "tombstone" ? 0 : origins.get(e.id) === "remote" ? 1 : 2;
    return rank(a) - rank(b) || a.id.localeCompare(b.id);
  });
  for (const entry of ordered) {
    if (entry.parentId === null) continue;
    if (occupied.has(key(entry))) {
      if (entry.kind === "tombstone") throw new Error(`unrepresentable tombstone collision: ${entry.id}`);
      let found = false;
      for (let i = 1; i <= 32; i++) {
        const candidate = await conflictName(entry, origins.get(entry.id) ?? "remote", i);
        if (!occupied.has(`${entry.parentId}/${candidate.toLowerCase()}`)) {
          entry.name = candidate; found = true; break;
        }
      }
      if (!found) throw new Error("merge name collision limit exceeded");
      conflicts.push({ kind: "name", entryId: entry.id });
    }
    occupied.add(key(entry));
  }
  const manifest = parseManifest({ version: 1, vaultId: base.vaultId, revisionId,
    parents: [local.revisionId, remote.revisionId].sort(), creatingDeviceId, entries: [...entries.values()] });
  encodeManifest(manifest); // also enforce the encrypted manifest's 4 MiB bound
  return { manifest, conflicts };
}
