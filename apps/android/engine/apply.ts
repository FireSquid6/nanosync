import { encryptChunk, manifestPaths, type HttpRemote, type ManifestV1 } from "../../../packages/sync-core/src/index.ts";
import { Bridge, fromBase64, toBase64 } from "./bridge.ts";
import { Journal, type ApplyIntent, type Metadata, type SavedEntry } from "./journal.ts";
import { Scanner, sameMetadata } from "./scanner.ts";

/** Durable, guarded per-file apply. Unsupported topology transitions block rather than
 * deleting directories recursively or overwriting untracked/concurrently edited data. */
export class Applier {
  constructor(readonly bridge: Bridge, readonly journal: Journal, readonly scanner: Scanner, readonly remote: HttpRemote) {}
  private async guard(path: string, baseline: SavedEntry | undefined): Promise<Metadata | null> {
    const stat = await this.bridge.call<Metadata | { missing: true }>("stat", { path });
    if ("missing" in stat) return null;
    if (!baseline?.metadata || (stat.directory ? !baseline.metadata.directory || !!baseline.metadata.fileKey && baseline.metadata.fileKey !== stat.fileKey : !sameMetadata(baseline.metadata, stat))) throw new Error(`local path changed or untracked: ${path}`);
    if (!stat.directory && baseline.sha256 && await this.scanner.digest({ ...stat, path }) !== baseline.sha256) throw new Error(`local content changed: ${path}`);
    return stat;
  }
  async apply(manifest: ManifestV1, sequence: number, key: Uint8Array) {
    await this.scanner.refresh(); // Complete inventory and current ignore policy, even on resume.
    let intent = this.journal.state.applies.find(i => i.revision === manifest.revisionId);
    if (this.journal.state.applies.length && !intent) throw new Error("different apply already pending");
    const target = manifestPaths(manifest);
    if (!intent) {
      intent = { id: crypto.randomUUID(), revision: manifest.revisionId, sequence, state: "applying", files: {}, baseline: structuredClone(this.journal.state.entries) };
      this.journal.state.applies.push(intent); this.journal.save();
    }
    const baseline = new Map(Object.values(intent.baseline).map(e => [e.path, e]));
    const verified = await this.remote.manifest(manifest.revisionId, key);
    if (verified.sequence !== sequence) throw new Error("apply revision sequence mismatch");
    const refs = new Map<string, typeof verified.revision.references[number]>(verified.revision.references.map(r => [r.objectId, r]));
    let privateRequired = 0, sharedRequired = 0;
    const missingCache = new Set<string>();
    for (const [path, entry] of target) {
      if (entry.kind !== "file" || this.scanner.matcher.ignores(path) || intent.files[entry.id]?.done) continue;
      const prior = baseline.get(path);
      if (prior && prior.sha256 === entry.sha256 && prior.metadata?.size === entry.size) continue;
      privateRequired += entry.size! - (intent.files[entry.id]?.offset ?? 0);
      sharedRequired += entry.size!; // same-volume commit copy
      for (const chunk of entry.chunks!) {
        const ref = refs.get(chunk.objectId)!;
        const cacheKey = `${manifest.vaultId}:${ref.objectId}:${ref.ciphertextChecksum}`;
        if (!this.journal.state.chunks[cacheKey] && !missingCache.has(cacheKey)) { privateRequired += chunk.length; missingCache.add(cacheKey); }
      }
    }
    const capacity = await this.bridge.call<{ availableBytes: number; privateAvailableBytes?: number }>("capacity");
    const privateAvailable = capacity.privateAvailableBytes ?? capacity.availableBytes;
    // With no separate private-volume report, conservatively reserve both on one filesystem.
    if (!Number.isFinite(capacity.availableBytes) || !Number.isFinite(privateAvailable) || privateAvailable < privateRequired || capacity.availableBytes < sharedRequired + (capacity.privateAvailableBytes === undefined ? privateRequired : 0)) throw new Error("insufficient storage for safe apply");
    // Directories first. Existing non-directory targets are blocked safely.
    for (const [path, entry] of [...target].sort((a, b) => a[0].split("/").length - b[0].split("/").length)) {
      if (!path || entry.kind !== "directory" || this.scanner.matcher.ignores(path, true)) continue;
      const stat = await this.bridge.call<Metadata | { missing: true }>("stat", { path });
      if ("missing" in stat) await this.bridge.call("mkdir", { path });
      else if (!stat.directory) throw new Error(`type transition requires manual resolution: ${path}`);
    }
    for (const [path, entry] of target) {
      if (entry.kind !== "file" || this.scanner.matcher.ignores(path)) continue;
      let file = intent.files[entry.id];
      const stat = await this.bridge.call<Metadata | { missing: true }>("stat", { path });
      if (!("missing" in stat) && !stat.directory && stat.size === entry.size && await this.scanner.digest({ ...stat, path }) === entry.sha256) {
        // Also recovers a crash after atomic commit but before checkpoint.
        if (file) { file.done = true; this.journal.save(); }
        continue;
      }
      if (file?.done) throw new Error(`local edit after apply commit: ${path}`);
      if (!file) {
        const current = await this.guard(path, baseline.get(path));
        if (current?.directory) throw new Error(`directory-to-file transition blocked: ${path}`);
        file = { id: crypto.randomUUID(), path, offset: 0, expected: current ? { size: current.size, modified: current.modified } : { missing: true } };
        intent.files[entry.id] = file; this.journal.save();
      } else await this.guard(path, baseline.get(path));
      // Verify every persisted chunk against authenticated references, not just an offset.
      let offset = 0;
      for (const chunk of entry.chunks!) {
        const ref = refs.get(chunk.objectId); if (!ref || ref.objectType !== "chunk") throw new Error("missing authenticated chunk reference");
        if (offset < file.offset) {
          if (offset + chunk.length > file.offset) throw new Error("invalid stage checkpoint");
          const read = await this.bridge.call<{ dataBase64: string }>("stageRead", { id: file.id, offset, length: chunk.length });
          const bytes = fromBase64(read.dataBase64), object = await encryptChunk(bytes, key, manifest.vaultId);
          if (bytes.length !== chunk.length || object.reference.objectId !== ref.objectId || object.reference.ciphertextChecksum !== ref.ciphertextChecksum || object.reference.ciphertextLength !== ref.ciphertextLength) throw new Error("persisted stage chunk corrupted");
        } else {
          const item = await this.remote.downloadChunks([ref], key, manifest.vaultId).next();
          const bytes = item.value; if (!(bytes instanceof Uint8Array) || bytes.length !== chunk.length) throw new Error("invalid plaintext chunk length");
          await this.bridge.call("stageWrite", { id: file.id, offset, dataBase64: toBase64(bytes) });
          file.offset = offset + bytes.length; this.journal.save();
        }
        offset += chunk.length;
      }
      if (!entry.size) await this.bridge.call("stageWrite", { id: file.id, offset: 0, dataBase64: "" });
      const digest = await this.bridge.call<{ sha256: string; size: number }>("stageDigest", { id: file.id });
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) throw new Error("reconstructed file digest mismatch");
      await this.guard(path, baseline.get(path));
      await this.bridge.call("stageCommit", { id: file.id, path, expected: file.expected });
      file.done = true; this.journal.save();
    }
    // Delete only tracked, unchanged paths, deepest first. Native remove MUST be nonrecursive.
    for (const [path, previous] of [...baseline].sort((a, b) => b[0].split("/").length - a[0].split("/").length)) {
      if (!path || this.scanner.matcher.ignores(path, !!previous.metadata?.directory)) continue;
      const wanted = target.get(path); if (wanted && wanted.kind !== "tombstone") continue;
      const current = await this.guard(path, previous); if (!current) continue;
      await this.bridge.call("remove", { path, expected: { size: current.size, modified: current.modified } });
    }
    await this.scanner.refresh();
    const inventory = this.scanner.snapshot() as Metadata[];
    // Success requires full tree verification, not merely equal heads or metadata.
    for (const [path, entry] of target) {
      if (this.scanner.matcher.ignores(path, entry.kind === "directory")) continue;
      const found = inventory.find(m => m.path === path);
      if (entry.kind === "tombstone") { if (found) throw new Error(`deletion not verified: ${path}`); continue; }
      if (!found || found.directory !== (entry.kind === "directory")) throw new Error(`apply verification failed: ${path}`);
      if (entry.kind === "file" && await this.scanner.digest(found) !== entry.sha256) throw new Error(`apply digest verification failed: ${path}`);
    }
    this.journal.commitEntries(manifest, inventory);
    // Commit entry metadata, applied head, and intent removal in one durable state write.
    const old = this.journal.head("applied");
    if (sequence < old.sequence || sequence === old.sequence && old.revisionId !== manifest.revisionId) throw new Error("non-monotonic apply");
    this.journal.state.heads.applied = { revisionId: manifest.revisionId, sequence };
    this.journal.state.applies = []; this.journal.save();
  }
}
