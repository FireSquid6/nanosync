import { encryptChunk, manifestPaths, type HttpRemote, type ManifestV1 } from "../../../packages/sync-core/src/index.ts";
import { Bridge, fromBase64, toBase64 } from "./bridge.ts";
import { Journal, type ApplyIntent, type Metadata, type SavedEntry } from "./journal.ts";
import { Scanner, sameMetadata } from "./scanner.ts";

/** Stage all required content before topology changes. Every visible mutation has
 * a durable intent and an unchanged-local guard; directory removal is nonrecursive. */
export class Applier {
  constructor(readonly bridge: Bridge, readonly journal: Journal, readonly scanner: Scanner, readonly remote: HttpRemote) {}
  private async stat(path: string): Promise<Metadata | { missing: true }> {
    const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
    // Complete inventory distinguishes an absent parent from a permission error.
    // stageCommit still checks missing atomically after planned parents exist.
    if (parent && !(this.scanner.snapshot() as Metadata[]).some(m => m.path === parent && m.directory)) return { missing: true };
    return this.bridge.call("stat", { path });
  }
  private async guard(path: string, baseline: SavedEntry | undefined): Promise<Metadata | null> {
    const stat = await this.stat(path);
    if ("missing" in stat) return null;
    if (!baseline?.metadata || (stat.directory ? !baseline.metadata.directory || !!baseline.metadata.fileKey && baseline.metadata.fileKey !== stat.fileKey : !sameMetadata(baseline.metadata, stat))) throw new Error(`local path changed or untracked: ${path}`);
    if (!stat.directory && baseline.sha256 && await this.scanner.digest({ ...stat, path }) !== baseline.sha256) throw new Error(`local content changed: ${path}`);
    return stat;
  }
  async apply(manifest: ManifestV1, sequence: number, key: Uint8Array) {
    await this.scanner.refresh();
    let intent = this.journal.state.applies.find(i => i.revision === manifest.revisionId);
    if (this.journal.state.applies.length && !intent) throw new Error("different apply already pending");
    if (!intent) {
      intent = { id: crypto.randomUUID(), revision: manifest.revisionId, sequence, state: "applying", files: {}, baseline: structuredClone(this.journal.state.entries) };
      this.journal.state.applies.push(intent); this.journal.save();
    }
    try { await this.execute(manifest, sequence, key, intent); }
    catch (error) {
      if (error instanceof Error && (/^local (?:path|content) changed/.test(error.message) || /^ignore policy changed/.test(error.message))) {
        if (!intent.mutated) {
          // No visible filesystem mutations: the old applied baseline is intact.
          // Drop only the apply intent, retaining authenticated chunk caches; the
          // next sync scans the edit against the old base and merges remote head.
          this.journal.discardApply(intent);
          const proposal = this.journal.state.proposal;
          if (proposal?.state === "accepted" && proposal.request.proposedRevision.revisionId === manifest.revisionId) this.journal.state.proposal = null;
          this.journal.save();
          await this.journal.collectGarbage();
          throw new Error(`${error.message}. Local edits preserved; retry sync to replan and merge with the remote revision.`);
        }
        if (/^ignore policy changed/.test(error.message)) throw new Error(`${error.message}. Partial apply paused. Restore the previous .nanosyncignore rules, then retry to finish the pending revision before changing exclusions.`);
        throw new Error(`${error.message}. Partial apply paused without discarding your edit. Move the edited path outside this vault, then retry sync to finish the pending revision. Keep your saved copy; do not clear app data.`);
      }
      throw error;
    }
  }
  private async execute(manifest: ManifestV1, sequence: number, key: Uint8Array, intent: ApplyIntent) {
    const policy = intent.ignorePolicy ?? this.scanner.policySignature();
    intent.ignorePolicy = policy; this.journal.save();
    await this.scanner.verifyPolicy(policy);
    const target = manifestPaths(manifest), baseline = new Map(Object.values(intent.baseline).map(e => [e.path, e]));
    const verified = await this.remote.manifest(manifest.revisionId, key);
    if (verified.sequence !== sequence) throw new Error("apply revision sequence mismatch");
    const refs = new Map<string, typeof verified.revision.references[number]>(verified.revision.references.map(r => [r.objectId, r]));
    let privateRequired = 0, sharedRequired = 0, missingCacheBytes = 0;
    const missingCache = new Set<string>();
    for (const [path, entry] of target) {
      if (entry.kind !== "file" || this.scanner.matcher.ignores(path) || intent.files[entry.id]?.done) continue;
      const prior = baseline.get(path);
      if (prior && prior.sha256 === entry.sha256 && prior.metadata?.size === entry.size) continue;
      privateRequired += entry.size! - (intent.files[entry.id]?.offset ?? 0);
      sharedRequired += entry.size!;
      for (const chunk of entry.chunks!) {
        const ref = refs.get(chunk.objectId)!;
        const cacheKey = `${manifest.vaultId}:${ref.objectId}:${ref.ciphertextChecksum}`;
        if (!this.journal.state.chunks[cacheKey] && !missingCache.has(cacheKey)) { missingCacheBytes += chunk.length; missingCache.add(cacheKey); }
      }
    }
    privateRequired += this.journal.additionalCacheBytes(missingCacheBytes);
    const capacity = await this.bridge.call<{ availableBytes: number; privateAvailableBytes?: number }>("capacity");
    const privateAvailable = capacity.privateAvailableBytes ?? capacity.availableBytes;
    if (!Number.isFinite(capacity.availableBytes) || !Number.isFinite(privateAvailable) || privateAvailable < privateRequired || capacity.availableBytes < sharedRequired + (capacity.privateAvailableBytes === undefined ? privateRequired : 0)) throw new Error("insufficient storage for safe apply");

    // Phase one: authenticate/reconstruct ALL changed files without altering the vault.
    for (const [path, entry] of target) {
      if (entry.kind !== "file" || this.scanner.matcher.ignores(path)) continue;
      let file = intent.files[entry.id];
      const stat = await this.stat(path);
      if (!("missing" in stat) && !stat.directory && stat.size === entry.size && await this.scanner.digest({ ...stat, path }) === entry.sha256) {
        if (file) { file.done = true; this.journal.save(); } // crash after commit
        continue;
      }
      if (file?.done) {
        if (!("missing" in stat)) throw new Error(`local content changed after apply commit: ${path}`);
        // User recovery: the edited file has been moved safely outside the vault.
        // Reconstruct from authenticated chunks if its retained stage was lost.
        file.done = false; file.offset = 0; file.expected = { missing: true }; this.journal.save();
      }
      if (!file) {
        const current = await this.guard(path, baseline.get(path));
        file = { id: crypto.randomUUID(), path, offset: 0, expected: current ? { size: current.size, modified: current.modified, ...(current.fileKey ? { fileKey: current.fileKey } : {}) } : { missing: true } };
        intent.files[entry.id] = file; this.journal.save();
      } else {
        // A recorded topology removal intentionally leaves the old destination absent.
        if (!intent.removed?.includes(path)) await this.guard(path, baseline.get(path));
      }
      let offset = 0;
      for (const chunk of entry.chunks!) {
        const ref = refs.get(chunk.objectId); if (!ref || ref.objectType !== "chunk") throw new Error("missing authenticated chunk reference");
        if (offset < file.offset) {
          if (offset + chunk.length > file.offset) throw new Error("invalid stage checkpoint");
          const read = await this.bridge.call<{ dataBase64: string }>("stageRead", { id: file.id, offset, length: chunk.length });
          const bytes = fromBase64(read.dataBase64), object = await encryptChunk(bytes, key, manifest.vaultId);
          if (bytes.length !== chunk.length || object.reference.objectId !== ref.objectId || object.reference.ciphertextChecksum !== ref.ciphertextChecksum || object.reference.ciphertextLength !== ref.ciphertextLength) throw new Error("persisted stage chunk corrupted");
        } else {
          for await (const bytes of this.remote.downloadChunks([ref], key, manifest.vaultId)) {
            if (bytes.length !== chunk.length) throw new Error("invalid plaintext chunk length");
            await this.bridge.call("stageWrite", { id: file.id, offset, dataBase64: toBase64(bytes) });
            file.offset = offset + bytes.length; this.journal.save();
          }
        }
        offset += chunk.length;
      }
      if (!entry.size) await this.bridge.call("stageWrite", { id: file.id, offset: 0, dataBase64: "" });
      const digest = await this.bridge.call<{ sha256: string; size: number }>("stageDigest", { id: file.id });
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) throw new Error("reconstructed file digest mismatch");
      if (!intent.removed?.includes(path)) await this.guard(path, baseline.get(path));
    }

    await this.scanner.refresh();
    if (this.scanner.policySignature() !== policy) throw new Error("ignore policy changed during download; retry sync before applying");
    const mutation = async () => {
      await this.scanner.verifyPolicy(policy);
      intent.mutated = true; this.journal.save();
    };
    // Phase two: delete obsolete/transtyped tracked entries deepest first. Unknown
    // and ignored children are never removed; they cause nonempty-directory failure.
    for (const [path, previous] of [...baseline].sort((a, b) => b[0].split("/").length - a[0].split("/").length)) {
      if (!path || this.scanner.matcher.ignores(path, !!previous.metadata?.directory) || intent.removed?.includes(path)) continue;
      const wanted = target.get(path);
      if (wanted && wanted.kind !== "tombstone" && previous.metadata?.directory === (wanted.kind === "directory")) continue;
      const current = await this.guard(path, previous);
      if (current) {
        await mutation();
        await this.bridge.call("remove", { path, expected: { size: current.size, modified: current.modified, ...(current.fileKey ? { fileKey: current.fileKey } : {}) } });
      }
      (intent.removed ??= []).push(path); this.journal.save();
    }
    // Missing paths after a crash between remove/checkpoint are safe: native stat
    // verifies root accessibility; reappearing untracked paths are never deleted.
    for (const [path, entry] of [...target].sort((a, b) => a[0].split("/").length - b[0].split("/").length)) {
      if (!path || entry.kind !== "directory" || this.scanner.matcher.ignores(path, true)) continue;
      const stat = await this.bridge.call<Metadata | { missing: true }>("stat", { path });
      if ("missing" in stat) { await mutation(); await this.bridge.call("mkdir", { path }); }
      else if (!stat.directory) throw new Error(`local path changed before directory creation: ${path}`);
    }
    // Refresh complete inventory after topology changes before destination guards.
    await this.scanner.refresh();
    for (const [path, entry] of target) {
      const file = intent.files[entry.id];
      if (entry.kind !== "file" || !file || file.done || this.scanner.matcher.ignores(path)) continue;
      const current = await this.guard(path, intent.removed?.includes(path) ? undefined : baseline.get(path));
      if (!current) { file.expected = { missing: true }; this.journal.save(); }
      await mutation();
      await this.bridge.call("stageCommit", { id: file.id, path, expected: file.expected });
      file.done = true; this.journal.save();
    }
    await this.scanner.refresh();
    const inventory = this.scanner.snapshot() as Metadata[];
    for (const [path, entry] of target) {
      if (this.scanner.matcher.ignores(path, entry.kind === "directory")) continue;
      const found = inventory.find(m => m.path === path);
      if (entry.kind === "tombstone") { if (found) throw new Error(`deletion not verified: ${path}`); continue; }
      if (!found || found.directory !== (entry.kind === "directory")) throw new Error(`apply verification failed: ${path}`);
      if (entry.kind === "file" && await this.scanner.digest(found) !== entry.sha256) throw new Error(`local content changed during apply verification: ${path}`);
    }
    await this.scanner.verifyPolicy(policy);
    this.journal.commitEntries(manifest, inventory);
    const old = this.journal.head("applied");
    if (sequence < old.sequence || sequence === old.sequence && old.revisionId !== manifest.revisionId) throw new Error("non-monotonic apply");
    this.journal.state.heads.applied = { revisionId: manifest.revisionId, sequence };
    this.journal.discardApply(intent); this.journal.save();
    await this.journal.collectGarbage();
  }
}
