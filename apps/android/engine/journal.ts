import { randomUUID } from "./compatibility.ts";
import { manifestPaths, type Head, type ManifestV1, type SyncJournal, type ChunkJournal } from "../../../packages/sync-core/src/index.ts";
import { parseRevisionId, type AdvanceHeadRequest, type VisibleObjectReference } from "@nanosync/protocol";
import { Bridge, fromBase64, toBase64 } from "./bridge.ts";
export interface Metadata { path: string; directory: boolean; size: number; modified: number; fileKey?: string; symlink?: boolean }
export interface SavedEntry { path: string; metadata?: Metadata; sha256?: string; revision?: string }
export interface ApplyFile { id: string; path: string; offset: number; expected: { size: number; modified: number; fileKey?: string } | { missing: true }; done?: boolean }
export interface ApplyIntent { id: string; revision: string; sequence: number; state: string; files: Record<string, ApplyFile>; baseline: Record<string, SavedEntry>; mutated?: boolean; removed?: string[]; ignorePolicy?: string }
interface State {
  version: 1; heads: Record<"observed" | "accepted" | "applied", Head>;
  proposal: { request: AdvanceHeadRequest; frame: string; state: "prepared" | "accepted"; acceptedSequence: number | null } | null;
  reconciliation: { baseRevision: string; localRevision: string } | null;
  entries: Record<string, SavedEntry>; conflicts: string[];
  applies: ApplyIntent[]; chunks: Record<string, { id: string; reference: VisibleObjectReference }>;
  garbage: string[];
}
const emptyHead = (): Head => ({ revisionId: null, sequence: 0 });
export class Journal implements SyncJournal, ChunkJournal {
  readonly state: State;
  constructor(readonly bridge: Bridge, private cacheBytes = 64 * 1024 * 1024) {
    if (!Number.isSafeInteger(cacheBytes) || cacheBytes < 0) throw new Error("invalid cache budget");
    const saved = bridge.sync<Partial<State>>("journalRead");
    if (Object.keys(saved).length && saved.version !== 1) throw new Error("unsupported Android journal");
    this.state = Object.keys(saved).length ? saved as State : { version: 1, heads: { observed: emptyHead(), accepted: emptyHead(), applied: emptyHead() }, proposal: null, reconciliation: null, entries: {}, conflicts: [], applies: [], chunks: {}, garbage: [] };
    this.state.garbage ??= [];
    this.state.reconciliation ??= null;
  }
  save() { this.bridge.sync("journalWrite", { state: this.state }); }
  head(kind: "observed" | "accepted" | "applied"): Head { return { ...this.state.heads[kind] }; }
  recordHead(kind: "observed" | "accepted" | "applied", head: Head) {
    const old = this.head(kind);
    if (!Number.isSafeInteger(head.sequence) || head.sequence < old.sequence || head.sequence === old.sequence && old.revisionId !== head.revisionId) throw new Error("non-monotonic journal head");
    this.state.heads[kind] = { ...head }; this.save();
  }
  reconcileConflicts(manifest: ManifestV1) {
    this.state.conflicts = [...manifestPaths(manifest)].filter(([, e]) => e.conflict && e.kind !== "tombstone").map(([p]) => p); this.save();
  }
  proposal() { const p = this.state.proposal; return p ? { request: structuredClone(p.request), encryptedManifestFrame: fromBase64(p.frame), state: p.state, acceptedSequence: p.acceptedSequence } : null; }
  freezeProposal(request: AdvanceHeadRequest, frame: Uint8Array) {
    if (this.state.proposal) throw new Error("proposal already frozen");
    this.state.proposal = { request: structuredClone(request), frame: toBase64(frame), state: "prepared", acceptedSequence: null }; this.save();
  }
  acceptProposal(sequence: number) {
    const p = this.state.proposal; if (!p) throw new Error("no proposal");
    const old = this.head("accepted"), revisionId = p.request.proposedRevision.revisionId;
    if (sequence < old.sequence || sequence === old.sequence && revisionId !== old.revisionId) throw new Error("non-monotonic acceptance");
    p.state = "accepted"; p.acceptedSequence = sequence; this.state.heads.accepted = { revisionId, sequence }; this.save();
  }
  clearProposal() { this.state.proposal = null; this.save(); }
  reconciliation(): { baseRevision: string; localRevision: string } | null {
    const current = this.state.reconciliation;
    return current ? { baseRevision: parseRevisionId(current.baseRevision), localRevision: parseRevisionId(current.localRevision) } : null;
  }
  beginReconciliation(baseRevision: string, localRevision: string) {
    parseRevisionId(baseRevision); parseRevisionId(localRevision);
    const current = this.reconciliation();
    if (current) {
      if (current.baseRevision !== baseRevision || current.localRevision !== localRevision) throw new Error("reconciliation already pending");
      return;
    }
    const proposal = this.state.proposal;
    if (this.head("applied").revisionId !== baseRevision || proposal?.state !== "prepared" ||
        proposal.request.proposedRevision.revisionId !== localRevision) throw new Error("reconciliation branch changed");
    this.state.reconciliation = { baseRevision, localRevision }; this.save();
  }
  finishReconciliation() {
    const proposal = this.state.proposal;
    if (!this.reconciliation() || proposal?.state !== "accepted" || this.head("applied").revisionId !== proposal.request.proposedRevision.revisionId)
      throw new Error("reconciliation not applied");
    this.state.reconciliation = null; this.state.proposal = null; this.save();
  }
  discardStaleProposal(id: string) {
    if (this.state.proposal?.state !== "prepared" || this.state.proposal.request.proposedRevision.revisionId !== id) throw new Error("wrong stale proposal");
    this.clearProposal();
  }
  restoreProposal() { return null; }
  discardStaleRestore() { throw new Error("Android restore unsupported"); }
  finishRestoreProposal() { throw new Error("Android restore unsupported"); }
  pendingApplies() { return structuredClone(this.state.applies); }
  pendingHydration() { return null; }
  entry(id: string) { return this.state.entries[id] ?? null; }
  commitEntries(manifest: ManifestV1, inventory: Metadata[]) {
    const entries: Record<string, SavedEntry> = {}, metadata = new Map(inventory.map(e => [e.path, e]));
    for (const [path, entry] of manifestPaths(manifest)) if (entry.kind !== "tombstone") {
      const previous = this.state.entries[entry.id], current = metadata.get(path);
      entries[entry.id] = !current && previous?.path === path ? { ...structuredClone(previous), revision: manifest.revisionId } : { path, metadata: current, sha256: entry.sha256, revision: manifest.revisionId };
    }
    this.state.entries = entries; this.save();
  }
  private cacheKey(vault: string, ref: VisibleObjectReference) { return `${vault}:${ref.objectId}:${ref.ciphertextChecksum}`; }
  async get(vault: string, ref: VisibleObjectReference): Promise<Uint8Array | null> {
    const cached = this.state.chunks[this.cacheKey(vault, ref)]; if (!cached) return null;
    try {
      const read = await this.bridge.call<{ dataBase64: string; size: number }>("stageRead", { id: cached.id, offset: 0, length: 4194304 });
      const bytes = fromBase64(read.dataBase64); if (read.size !== bytes.length) return null; return bytes;
    } catch { return null; } // Cache loss is safe: HttpRemote re-authenticates every hit.
  }
  additionalCacheBytes(missingBytes: number) {
    const used = Object.values(this.state.chunks).reduce((sum, c) => sum + c.reference.ciphertextLength - 96, 0);
    // Existing bytes already reduce native free space. One replacement chunk can
    // coexist with the old cache until the durable mapping/garbage checkpoint.
    return Math.min(missingBytes, Math.max(0, this.cacheBytes - used) + Math.min(4194304, missingBytes));
  }
  async prepareStorage() {
    await this.collectGarbage();
    if (this.state.garbage.length) throw new Error("private stage cleanup blocked; retry after restoring private storage access");
  }
  async put(vault: string, ref: VisibleObjectReference, bytes: Uint8Array) {
    await this.prepareStorage();
    const key = this.cacheKey(vault, ref), id = randomUUID();
    // Reserve cleanup ownership BEFORE native writes, including partial failures.
    this.state.garbage.push(id); this.save();
    await this.bridge.call("stageWrite", { id, offset: 0, dataBase64: toBase64(bytes) });
    const previous = this.state.chunks[key];
    if (previous) this.state.garbage.push(previous.id);
    delete this.state.chunks[key]; // insertion order is a durable FIFO cache policy
    this.state.chunks[key] = { id, reference: { ...ref } };
    this.state.garbage = this.state.garbage.filter(item => item !== id);
    let size = Object.values(this.state.chunks).reduce((sum, c) => sum + c.reference.ciphertextLength - 96, 0);
    for (const [oldKey, old] of Object.entries(this.state.chunks)) {
      if (size <= this.cacheBytes) break;
      size -= old.reference.ciphertextLength - 96;
      delete this.state.chunks[oldKey]; this.state.garbage.push(old.id);
    }
    this.save(); // no referenced or pending-intent stage is deleted before this checkpoint
    await this.collectGarbage();
  }
  discardApply(intent: ApplyIntent) {
    this.state.garbage.push(...Object.values(intent.files).map(file => file.id));
    this.state.applies = this.state.applies.filter(item => item.id !== intent.id);
  }
  async collectGarbage() {
    const pinned = new Set([...Object.values(this.state.chunks).map(c => c.id), ...this.state.applies.flatMap(i => Object.values(i.files).map(f => f.id))]);
    for (const id of [...new Set(this.state.garbage)]) {
      if (pinned.has(id)) continue;
      try {
        await this.bridge.call("stageDelete", { id });
        this.state.garbage = this.state.garbage.filter(item => item !== id); this.save();
      } catch { /* Retry durable garbage after a later run; never fail verified sync for cleanup. */ }
    }
  }
}
