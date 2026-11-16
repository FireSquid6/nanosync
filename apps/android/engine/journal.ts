import { manifestPaths, type Head, type ManifestV1, type SyncJournal, type ChunkJournal } from "../../../packages/sync-core/src/index.ts";
import type { AdvanceHeadRequest, VisibleObjectReference } from "@nanosync/protocol";
import { Bridge, fromBase64, toBase64 } from "./bridge.ts";
export interface Metadata { path: string; directory: boolean; size: number; modified: number; fileKey?: string; symlink?: boolean }
export interface SavedEntry { path: string; metadata?: Metadata; sha256?: string }
export interface ApplyFile { id: string; path: string; offset: number; expected: { size: number; modified: number } | { missing: true }; done?: boolean }
export interface ApplyIntent { id: string; revision: string; sequence: number; state: string; files: Record<string, ApplyFile>; baseline: Record<string, SavedEntry> }
interface State {
  version: 1; heads: Record<"observed" | "accepted" | "applied", Head>;
  proposal: { request: AdvanceHeadRequest; frame: string; state: "prepared" | "accepted"; acceptedSequence: number | null } | null;
  entries: Record<string, SavedEntry>; conflicts: string[];
  applies: ApplyIntent[]; chunks: Record<string, { id: string; reference: VisibleObjectReference }>;
}
const emptyHead = (): Head => ({ revisionId: null, sequence: 0 });
export class Journal implements SyncJournal, ChunkJournal {
  readonly state: State;
  constructor(readonly bridge: Bridge) {
    const saved = bridge.sync<Partial<State>>("journalRead");
    if (Object.keys(saved).length && saved.version !== 1) throw new Error("unsupported Android journal");
    this.state = Object.keys(saved).length ? saved as State : { version: 1, heads: { observed: emptyHead(), accepted: emptyHead(), applied: emptyHead() }, proposal: null, entries: {}, conflicts: [], applies: [], chunks: {} };
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
  discardStaleProposal(id: string) { if (this.state.proposal?.request.proposedRevision.revisionId !== id) throw new Error("wrong stale proposal"); this.clearProposal(); }
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
      entries[entry.id] = !current && previous?.path === path ? structuredClone(previous) : { path, metadata: current, sha256: entry.sha256 };
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
  async put(vault: string, ref: VisibleObjectReference, bytes: Uint8Array) {
    const key = this.cacheKey(vault, ref), id = crypto.randomUUID();
    await this.bridge.call("stageWrite", { id, offset: 0, dataBase64: toBase64(bytes) });
    this.state.chunks[key] = { id, reference: { ...ref } }; this.save();
  }
}
