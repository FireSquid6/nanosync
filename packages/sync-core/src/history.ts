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
  entries.push({ ...source, id: restoredId, parentId: parent.id,
    name: path.slice(parentPath ? parentPath.length + 1 : 0) });
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
