import { parseDeviceId, parseRevisionId, type RevisionEnvelope } from "@nanosync/protocol";
import { verifyReferenceSetMac } from "./index.ts";
import { encodeManifest, parseManifest, validateManifestReferences, type ManifestEntry, type ManifestV1 } from "./manifest.ts";
import type { HttpRemote } from "./remote.ts";

/** A revision is only visible after authenticating its envelope and decrypting its bound manifest. */
export async function history(remote: HttpRemote, head: string, master: Uint8Array, path?: string) {
  const result: { revisionId: string; sequence: number | null; entry: ManifestEntry | null }[] = [];
  const seen = new Set<string>(), pending: string[] = [parseRevisionId(head)];
  while (pending.length) {
    const id = pending.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const { manifest, sequence } = await remote.manifest(id, master);
    const entries = manifestPaths(manifest);
    result.push({ revisionId: id, sequence, entry: path === undefined ? null : entries.get(path) ?? null });
    pending.push(...manifest.parents);
  }
  return result;
}

export function manifestPaths(input: ManifestV1): Map<string, ManifestEntry> {
  const manifest = parseManifest(input), byId = new Map(manifest.entries.map(e => [e.id, e]));
  const paths = new Map<string, ManifestEntry>();
  function visit(entry: ManifestEntry): string {
    if (entry.parentId === null) return "";
    const parent = byId.get(entry.parentId)!;
    return [visit(parent), entry.name].filter(Boolean).join("/");
  }
  for (const entry of manifest.entries) paths.set(visit(entry), entry);
  return paths;
}

/** Restore always branches from the currently accepted head; it never rewinds that head. */
export function planRestore(currentInput: ManifestV1, historicalInput: ManifestV1, path: string,
  revisionId: string, deviceId: string, acceptedRevisionId: string): ManifestV1 {
  const current = parseManifest(currentInput), historical = parseManifest(historicalInput);
  if (current.revisionId !== parseRevisionId(acceptedRevisionId)) throw new Error("current manifest is not the accepted head");
  if (current.vaultId !== historical.vaultId || path === "" || !manifestPaths(historical).has(path)) throw new Error("unknown historical path or vault");
  const source = manifestPaths(historical).get(path)!;
  if (source.kind !== "file") throw new Error("restore requires historical file");
  const target = manifestPaths(current).get(path);
  const parentPath = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const parent = manifestPaths(current).get(parentPath);
  if (!parent || parent.kind !== "directory" || target?.kind === "directory") throw new Error("restore parent or target conflict");
  const entries = current.entries.filter(e => e.id !== target?.id);
  if (target?.kind === "tombstone") {
    const occupied = new Set(current.entries.filter(e => e.parentId === parent.id && e.id !== target.id)
      .map(e => e.name.toLowerCase()));
    occupied.add(target.name.toLowerCase()); // the newly restored file owns the original name
    let archived: string | undefined;
    for (let attempt = 0; attempt < 32; attempt++) {
      const suffix = ` (deleted ${target.id}${attempt ? `-${attempt}` : ""})`;
      let stem = "";
      for (const char of target.name) if (new TextEncoder().encode(stem + char + suffix).length <= 255) stem += char;
      const candidate = `${stem.replace(/[. ]+$/u, "") || "entry"}${suffix}`;
      if (!occupied.has(candidate.toLowerCase())) { archived = candidate; break; }
    }
    if (!archived) throw new Error("tombstone archival name collision limit exceeded");
    entries.push({ ...target, name: archived });
  }
  const ids = new Set(current.entries.map(e => e.id));
  let restoredId = target?.kind === "file" ? target.id : "";
  if (!restoredId) {
    for (let attempt = 0; attempt < 32; attempt++) {
      const candidate = crypto.randomUUID();
      if (!ids.has(candidate)) { restoredId = candidate; break; }
    }
    if (!restoredId) throw new Error("restore identity allocation failed");
  }
  const restored: ManifestEntry = { ...source, id: restoredId, parentId: parent.id,
    name: path.slice(parentPath ? parentPath.length + 1 : 0) };
  // A reused identity keeps its current immutable conflict lineage, not the
  // lineage (or lack thereof) of the historical source bytes.
  delete restored.conflict;
  if (target?.kind === "file" && target.conflict) restored.conflict = target.conflict;
  entries.push(restored);
  const planned = parseManifest({ ...current, revisionId: parseRevisionId(revisionId),
    parents: [current.revisionId], creatingDeviceId: parseDeviceId(deviceId), entries });
  encodeManifest(planned);
  return planned;
}

/** Replace the live tree, not history. Tombstoned identities never resurrect. */
export function planRestoreRevision(currentInput: ManifestV1, historicalInput: ManifestV1,
  revisionId: string, deviceId: string, acceptedRevisionId: string): ManifestV1 {
  const current = parseManifest(currentInput), historical = parseManifest(historicalInput);
  if (current.revisionId !== parseRevisionId(acceptedRevisionId)) throw new Error("current manifest is not the accepted head");
  if (current.vaultId !== historical.vaultId) throw new Error("restore vault mismatch");
  const currentRoot = current.entries.find(e => e.parentId === null)!;
  const historicalRoot = historical.entries.find(e => e.parentId === null)!;
  if (currentRoot.id !== historicalRoot.id) throw new Error("restore root identity mismatch");
  const byCurrent = new Map(current.entries.map(e => [e.id, e]));
  const used = new Set(current.entries.map(e => e.id));
  const allocate = () => {
    for (let attempt = 0; attempt < 32; attempt++) {
      const id = crypto.randomUUID();
      if (!used.has(id)) { used.add(id); return id; }
    }
    throw new Error("restore identity allocation failed");
  };
  const mapping = new Map<string, string>([[historicalRoot.id, currentRoot.id]]);
  for (const old of historical.entries.filter(e => e.kind !== "tombstone" && e.parentId !== null)) {
    const existing = byCurrent.get(old.id);
    mapping.set(old.id, existing?.kind === old.kind ? old.id : allocate());
  }
  const entries: ManifestEntry[] = historical.entries.filter(e => e.kind !== "tombstone").map(old => {
    const id = mapping.get(old.id)!;
    const existing = byCurrent.get(id);
    // Conflict lineage is immutable for a reused live identity, even when
    // restoring its historical bytes or location.
    const entry = { ...old, id, parentId: old.parentId === null ? null : mapping.get(old.parentId)! };
    if (existing) {
      delete entry.conflict;
      if (existing.conflict) entry.conflict = existing.conflict;
    }
    return entry;
  });
  const live = new Set(entries.map(e => e.id));
  const currentById = new Map(current.entries.map(e => [e.id, e]));
  // Preserve the nearest surviving directory for deletion markers. Omitting
  // descendants of a removed directory is valid: its tombstone represents
  // removal of the entire subtree, as in the normal scanner.
  for (const old of current.entries) {
    if (old.parentId === null || live.has(old.id)) continue;
    let parentId: string | null = old.parentId;
    while (parentId && !live.has(parentId)) parentId = currentById.get(parentId)?.parentId ?? null;
    if (!parentId) parentId = currentRoot.id;
    if (old.kind !== "tombstone" && parentId !== old.parentId) continue;
    entries.push({ id: old.id, parentId, name: old.name, kind: "tombstone",
      deletedKind: old.kind === "tombstone" ? old.deletedKind : old.kind });
  }
  const occupied = new Set(entries.filter(e => e.kind !== "tombstone" && e.parentId !== null)
    .map(e => `${e.parentId}/${e.name.toLowerCase()}`));
  const encoder = new TextEncoder();
  for (const tombstone of entries.filter(e => e.kind === "tombstone").sort((a, b) => a.id.localeCompare(b.id))) {
    const location = `${tombstone.parentId}/${tombstone.name.toLowerCase()}`;
    if (occupied.has(location)) {
      let archived: string | undefined;
      for (let attempt = 0; attempt < 32; attempt++) {
        const suffix = ` (deleted ${tombstone.id}${attempt ? `-${attempt}` : ""})`;
        let stem = "";
        for (const char of tombstone.name) if (encoder.encode(stem + char + suffix).length <= 255) stem += char;
        const name = `${stem.replace(/[. ]+$/u, "") || "entry"}${suffix}`;
        if (!occupied.has(`${tombstone.parentId}/${name.toLowerCase()}`)) { archived = name; break; }
      }
      if (!archived) throw new Error("tombstone archival name collision limit exceeded");
      tombstone.name = archived;
    }
    occupied.add(`${tombstone.parentId}/${tombstone.name.toLowerCase()}`);
  }
  const planned = parseManifest({ ...current, revisionId: parseRevisionId(revisionId),
    parents: [current.revisionId], creatingDeviceId: parseDeviceId(deviceId), entries });
  encodeManifest(planned);
  return planned;
}

/** Only reuse references authenticated by their own original revision envelope. */
export async function restoreReferences(planned: ManifestV1, envelopes: readonly { manifest: ManifestV1; envelope: RevisionEnvelope }[], master: Uint8Array) {
  const lengths = new Map<string, number>();
  for (const e of planned.entries) for (const c of e.chunks ?? []) lengths.set(c.objectId, c.length);
  const refs = new Map<string, RevisionEnvelope["references"][number]>();
  for (const { manifest, envelope } of envelopes) {
    if (!await verifyReferenceSetMac(envelope, master)) throw new Error("unauthenticated restore envelope");
    validateManifestReferences(manifest, envelope);
    const ids = new Set(parseManifest(manifest).entries.flatMap(e => (e.chunks ?? []).map(c => c.objectId)));
    for (const ref of envelope.references) if (ids.has(ref.objectId) && lengths.get(ref.objectId) === ref.ciphertextLength - 96 && ref.objectType === "chunk") refs.set(ref.objectId, ref);
  }
  if (refs.size !== lengths.size) throw new Error("missing authenticated restore references");
  return [...refs.values()].sort((a, b) => a.objectId.localeCompare(b.objectId));
}
