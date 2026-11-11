import { randomUUID } from "node:crypto";
import { ClientLocal } from "@nanosync/client-local";
import { applyNewFiles, hydrateFile, LinuxScanner, LinuxWatcher, type ScanOptions, type ScanPlan } from "@nanosync/linux-client";
import { decryptManifest, HttpRemote, IntegrityError, mergeManifests, verifyReferenceSetMac, type ManifestV1, type RemoteOptions } from "@nanosync/sync-core";
import { parseDeviceId, parseVaultId, type RevisionEnvelope, type VisibleObjectReference } from "@nanosync/protocol";
import { acquireSyncLock } from "./sync-lock.ts";
import { privateDirectory } from "./security.ts";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, sep } from "node:path";

// Synchronization orchestration belongs to the CLI process; no background service or IPC is created.
type Verified = { manifest: ManifestV1; revision: RevisionEnvelope; sequence: number | null };
export interface SyncOptions {
  clientDirectory: string;
  syncDirectory: string;
  vaultId: string;
  deviceId: string;
  masterKey: Uint8Array;
  baseUrl: string;
  token: string;
  fetch?: RemoteOptions["fetch"];
  pollMs?: number;
  scan?: ScanOptions;
}

function sameTree(a: ManifestV1, b: ManifestV1): boolean {
  return JSON.stringify(a.entries) === JSON.stringify(b.entries);
}
function refs(revision: RevisionEnvelope): VisibleObjectReference[] {
  return revision.references.filter(ref => ref.objectType === "chunk");
}

export class SyncRunner {
  private readonly local: ClientLocal;
  private readonly scanner: LinuxScanner;
  private readonly remote: HttpRemote;
  private readonly key: Uint8Array;
  private readonly vault: string;
  private readonly device: string;
  private readonly pollMs: number;
  private readonly unlock: () => void;
  private watcher?: LinuxWatcher;
  private active?: Promise<{ revisionId: string; sequence: number }>;
  private stopped = false;

  private constructor(options: SyncOptions, unlock: () => void) {
    this.unlock = unlock;
    this.vault = parseVaultId(options.vaultId);
    this.device = parseDeviceId(options.deviceId);
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.length !== 32) throw new Error("invalid vault key");
    this.pollMs = options.pollMs ?? 5_000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 100 || this.pollMs > 3_600_000) throw new Error("invalid poll interval");
    this.local = new ClientLocal(options.clientDirectory, this.vault, this.device);
    this.key = Uint8Array.from(options.masterKey);
    try {
      this.scanner = new LinuxScanner(options.syncDirectory, this.local, options.scan);
      this.remote = new HttpRemote({ baseUrl: options.baseUrl, token: options.token, vaultId: this.vault,
        fetch: options.fetch ?? fetch, journal: this.local });
    } catch (error) {
      this.local.close();
      this.key.fill(0);
      throw error;
    }
  }

  static start(options: SyncOptions): SyncRunner {
    const root = privateDirectory(options.clientDirectory);
    const dataRoot = resolve(options.syncDirectory);
    if (dataRoot === root || dataRoot.startsWith(root + sep) || root.startsWith(dataRoot + sep)) {
      throw new Error("sync directory and private client directory must not overlap");
    }
    const unlock = acquireSyncLock(root);
    try { return new SyncRunner({ ...options, clientDirectory: root }, unlock); }
    catch (error) { unlock(); throw error; }
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    try {
      this.watcher?.close();
      await this.active?.catch(() => {});
    } finally {
      try { this.local.close(); }
      finally { this.key.fill(0); this.unlock(); }
    }
  }

  syncOnce(): Promise<{ revisionId: string; sequence: number }> {
    if (this.stopped) return Promise.reject(new Error("sync runner stopped"));
    if (this.active) return this.active;
    const work = (async () => {
      // A concurrent publisher may advance the head between the first pass and its
      // final observation. Retry a bounded number of times rather than claim success.
      for (let attempt = 0; attempt < 4; attempt++) {
        await this.run();
        const applied = this.local.head("applied");
        if (!applied.revisionId) throw new Error("sync did not apply a head");
        this.local.reconcileConflicts((await this.verified(applied.revisionId)).manifest);
        const observed = await this.remote.head();
        this.local.recordHead("observed", observed);
        if (observed.revisionId === applied.revisionId && observed.sequence === applied.sequence &&
            this.local.head("accepted").revisionId === applied.revisionId && !this.local.proposal() &&
            !this.local.pendingApplies().length) {
          this.watcher?.refresh();
          return { revisionId: applied.revisionId, sequence: applied.sequence };
        }
      }
      throw new Error("remote head changed repeatedly during sync");
    })();
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {});
    return work;
  }

  /** Foreground loop: watcher events are hints; periodic full passes catch missed notifications. */
  async watch(signal: AbortSignal, onSuccess: (head: { revisionId: string; sequence: number }) => void,
    onError: (error: unknown) => void): Promise<void> {
    let lastPoll = 0;
    while (!signal.aborted && !this.stopped) {
      const now = Date.now();
      let shouldSync = now - lastPoll >= this.pollMs;
      if (this.watcher) {
        try { shouldSync = this.watcher.ready(now) || shouldSync; }
        catch (error) { if (shouldSync) onError(error); }
      }
      if (shouldSync) {
        lastPoll = Date.now();
        try {
          const head = await this.syncOnce();
          if (!signal.aborted && !this.stopped) {
            if (!this.watcher) { this.watcher = new LinuxWatcher(this.scanner); this.watcher.start(); }
            onSuccess(head);
          }
        } catch (error) { onError(error); }
      }
      if (!signal.aborted && !this.stopped) {
        try { await delay(250, undefined, { signal }); }
        catch (error) { if (!signal.aborted) throw error; }
      }
    }
  }

  private async verified(id: string): Promise<Verified> {
    const result = await this.remote.manifest(id, this.key);
    if (result.manifest.vaultId !== this.vault || result.revision.vaultId !== this.vault ||
        result.manifest.creatingDeviceId !== result.revision.creatingDeviceId) throw new IntegrityError("vault or device binding mismatch");
    return result;
  }
  private async recoverHydration() {
    const hydration = this.local.pendingHydration();
    if (!hydration) return;
    await this.remote.capabilities();
    const head = this.local.head("applied"), remoteHead = await this.remote.head();
    if (head.revisionId !== hydration.revision || head.sequence !== hydration.sequence ||
        this.local.head("accepted").revisionId !== hydration.revision ||
        remoteHead.sequence < hydration.sequence || remoteHead.sequence === hydration.sequence && remoteHead.revisionId !== hydration.revision)
      throw new Error("hydration recovery requires unchanged accepted revision");
    const verified = await this.verified(hydration.revision);
    if (verified.sequence !== hydration.sequence) throw new Error("hydration accepted sequence changed");
    if (remoteHead.sequence > hydration.sequence) {
      if (!remoteHead.revisionId) throw new Error("remote head missing during hydration recovery");
      const current = await this.verified(remoteHead.revisionId);
      if (current.sequence !== remoteHead.sequence) throw new Error("head sequence mismatch");
      await this.remotePath(verified, current);
    }
    await hydrateFile(this.scanner.root, this.local, this.remote, verified.manifest, verified.revision, this.key, hydration.direction,
      this.local.entry(hydration.entryId)?.path ?? "", hydration);
  }
  private async replay(): Promise<{ stale: Verified | null; local: Verified | null }> {
    const proposal = this.local.proposal();
    if (!proposal) return { stale: null, local: null };
    if (proposal.state === "accepted") return { stale: null, local: await this.verified(proposal.request.proposedRevision.revisionId) };
    const request = proposal.request;
    const reference = request.proposedRevision.references.find(
      r => r.objectId === request.proposedRevision.encryptedManifestObjectId,
    )!;
    // Authenticate frozen bytes before retrying. No regenerated nonce or request key.
    if (!await verifyReferenceSetMac(request.proposedRevision, this.key)) throw new Error("frozen revision MAC mismatch");
    const manifest = await decryptManifest(proposal.encryptedManifestFrame, request.proposedRevision, this.key);
    if (manifest.vaultId !== this.vault || manifest.creatingDeviceId !== this.device ||
        !manifest.parents.includes(request.expectedRevisionId!)) throw new Error("frozen proposal binding mismatch");
    if ((await this.remote.presence("manifest", [reference.objectId])).has(reference.objectId))
      await this.remote.upload({ frame: proposal.encryptedManifestFrame, reference }, this.vault, request.idempotencyKey);
    let response = await this.remote.advance(request);
    if (response.status === "missingObjects") {
      const missing = new Set(response.objectIds);
      if (missing.has(reference.objectId))
        await this.remote.upload({ frame: proposal.encryptedManifestFrame, reference }, this.vault, request.idempotencyKey);
      const baseId = this.local.head("applied").revisionId;
      if (baseId && [...missing].some(id => id !== reference.objectId)) {
        const base = await this.verified(baseId);
        const plan = await this.scanner.plan(base.manifest, manifest.revisionId, this.device, this.key, manifest);
        if (!sameTree(plan.manifest, manifest)) throw new Error("cannot repair frozen proposal: local tree changed");
        const required = new Map(request.proposedRevision.references.map(r => [r.objectId, r]));
        const available = new Set(required.keys());
        for (const id of missing) available.delete(id);
        const repaired = new Set<string>();
        for await (const object of plan.chunks(available)) {
          const ref = required.get(object.reference.objectId);
          if (!ref || !missing.has(ref.objectId) || JSON.stringify(ref) !== JSON.stringify(object.reference))
            throw new Error("frozen chunk reference changed during repair");
          await this.remote.upload(object, this.vault, ref.objectId);
          repaired.add(ref.objectId);
        }
        if ([...missing].some(id => id !== reference.objectId && !repaired.has(id)))
          throw new Error("cannot repair missing frozen chunks");
      }
      response = await this.remote.advance(request);
    }
    if (response.status === "accepted" || response.status === "alreadyAccepted") {
      if (response.revisionId !== request.proposedRevision.revisionId) throw new Error("accepted wrong revision");
      this.local.acceptProposal(response.sequence);
      return { stale: null, local: await this.verified(response.revisionId) };
    }
    if (response.status === "staleHead" && this.local.restoreProposal()) {
      this.local.discardStaleRestore(); throw new Error("restore head changed; retry against the current accepted revision");
    }
    if (response.status !== "staleHead" || !response.currentRevisionId) throw new Error(`proposal not accepted: ${response.status}`);
    const local = await this.verified(request.proposedRevision.revisionId);
    this.local.discardStaleProposal(request.proposedRevision.revisionId);
    return { stale: await this.verified(response.currentRevisionId), local };
  }

  private async finishLocal(plan: ScanPlan, verified: Verified) {
    const head = this.local.head("accepted");
    if (head.revisionId !== verified.manifest.revisionId || head.sequence !== verified.sequence) throw new Error("local revision was not accepted");
    plan.commit();
    this.local.recordHead("applied", head);
    if (this.local.proposal()?.state === "accepted") this.local.clearProposal();
  }
  private async publish(plan: ScanPlan, previous: Verified): Promise<{ stale: Verified | null; local: Verified | null }> {
    const required = new Set(plan.manifest.entries.flatMap(e => (e.chunks ?? []).map(c => c.objectId)));
    const known = refs(previous.revision).filter(r => required.has(r.objectId));
    const knownIds = new Set(known.map(ref => ref.objectId));
    const result = await this.remote.publish(plan.manifest, known, plan.chunks(knownIds), this.key,
      previous.manifest.revisionId, new Date().toISOString(), (request, frame) => this.local.freezeProposal(request, frame));
    if (result.status === "accepted" || result.status === "alreadyAccepted") {
      if (result.revisionId !== plan.manifest.revisionId) throw new Error("accepted wrong revision");
      this.local.acceptProposal(result.sequence);
      return { stale: null, local: await this.verified(result.revisionId) };
    }
    if (result.status !== "staleHead" || !result.currentRevisionId) throw new Error(`publication failed: ${result.status}`);
    const local = await this.verified(plan.manifest.revisionId);
    this.local.discardStaleProposal(plan.manifest.revisionId);
    return { stale: await this.verified(result.currentRevisionId), local };
  }

  private async merge(base: Verified, local: Verified, remote: Verified): Promise<{ stale: Verified | null; local: Verified | null }> {
    if (!local.manifest.parents.includes(base.manifest.revisionId) || !remote.manifest.parents.includes(base.manifest.revisionId))
      throw new Error("merge requires a verified common base; manual intervention required");
    const merged = await mergeManifests(base.manifest, local.manifest, remote.manifest,
      { revisionId: randomUUID(), creatingDeviceId: this.device,
        localCreatedAt: local.revision.createdAt, remoteCreatedAt: remote.revision.createdAt });
    const known = new Map<string, VisibleObjectReference>();
    for (const ref of [...refs(base.revision), ...refs(local.revision), ...refs(remote.revision)]) {
      const existing = known.get(ref.objectId);
      if (existing && JSON.stringify(existing) !== JSON.stringify(ref)) throw new Error("conflicting authenticated chunk metadata");
      known.set(ref.objectId, ref);
    }
    const required = new Set(merged.manifest.entries.flatMap(e => (e.chunks ?? []).map(c => c.objectId)));
    const result = await this.remote.publish(merged.manifest, [...known.values()].filter(r => required.has(r.objectId)).sort((a, b) => a.objectId.localeCompare(b.objectId)),
      [], this.key, remote.manifest.revisionId, new Date().toISOString(),
      (request, frame) => this.local.freezeProposal(request, frame));
    if (result.status === "accepted" || result.status === "alreadyAccepted") {
      if (result.revisionId !== merged.manifest.revisionId) throw new Error("accepted wrong merge revision");
      this.local.acceptProposal(result.sequence);
      return { stale: null, local: await this.verified(result.revisionId) };
    }
    if (result.status !== "staleHead" || !result.currentRevisionId) throw new Error(`merge failed: ${result.status}`);
    const prepared = await this.verified(merged.manifest.revisionId);
    this.local.discardStaleProposal(merged.manifest.revisionId);
    return { stale: await this.verified(result.currentRevisionId), local: prepared };
  }

  /** Find an authenticated path from the applied revision. Merge parents may
   * include prepared (unaccepted) local branches, but accepted nodes along the
   * path must have strictly increasing server sequences.
   */
  private async remotePath(base: Verified, head: Verified, acceptedOnly = false): Promise<Verified[]> {
    // A frequently edited vault can accumulate far more than 64 revisions
    // while a device is offline. Bound hostile graph traversal without making
    // ordinary long-running histories unsynchronizable.
    const maxAncestryNodes = 16_384;
    if (base.sequence === null || head.sequence === null || head.sequence <= base.sequence)
      throw new Error("remote head does not advance applied sequence");
    const seen = new Set<string>();
    const visit = async (node: Verified): Promise<Verified[] | null> => {
      if (node.manifest.revisionId === base.manifest.revisionId) {
        if (node.sequence !== base.sequence) throw new Error("merge base sequence mismatch");
        return [];
      }
      if (acceptedOnly && node.sequence === null) return null;
      if (seen.has(node.manifest.revisionId)) return null;
      if (seen.size >= maxAncestryNodes) throw new Error("remote ancestry traversal limit exceeded");
      seen.add(node.manifest.revisionId);
      for (const id of node.manifest.parents) {
        const parent = await this.verified(id);
        if (node.sequence !== null && parent.sequence !== null && parent.sequence >= node.sequence) continue;
        const path = await visit(parent);
        if (path) {
          // A prepared parent can sit between two accepted revisions. Check
          // monotonicity across that gap as well as on direct accepted edges.
          let lastAccepted = base;
          for (let i = path.length - 1; i >= 0; i--) {
            if (path[i]!.sequence !== null) { lastAccepted = path[i]!; break; }
          }
          if (node.sequence !== null && node.sequence <= lastAccepted.sequence!) continue;
          return [...path, node];
        }
      }
      return null;
    };
    const path = await visit(head);
    if (!path?.length) throw new Error("no bounded authenticated path from local base to remote head");
    return path;
  }

  private async reconcile(base: Verified, local: Verified, current: Verified): Promise<Verified> {
    let concurrentStales = 0, steps = 0;
    while (steps++ < 64) {
      const path = await this.remotePath(base, current, true);
      const child = path[0]!;
      if (!local.manifest.parents.includes(base.manifest.revisionId) || !child.manifest.parents.includes(base.manifest.revisionId))
        throw new Error("unverifiable merge ancestry");
      const result = await this.merge(base, local, child);
      if (!result.local) throw new Error("missing prepared merge branch");
      if (!result.stale) {
        if (!result.local.sequence) throw new Error("merge was not accepted");
        return result.local;
      }
      local = result.local;
      if (path.length === 1 && ++concurrentStales >= 3)
        throw new Error("head contention: merge retry limit exceeded");
      base = child;
      current = result.stale;
    }
    throw new Error("remote ancestry traversal limit exceeded");
  }

  private async run(): Promise<void> {
    await this.remote.capabilities();
    await this.recoverHydration();
    // A partially applied filesystem is never scanned or overwritten.
    for (const pending of this.local.pendingApplies()) {
      const verified = await this.verified(pending.revision);
      if (verified.sequence !== pending.sequence) throw new Error("apply sequence mismatch");
      await applyNewFiles(this.scanner.root, this.local, this.remote, verified.manifest, pending.sequence, this.key);
    }
    let { stale, local: proposed } = await this.replay();
    const applied = this.local.head("applied");
    const base = applied.revisionId ? await this.verified(applied.revisionId) : null;
    if (base && base.sequence !== applied.sequence) throw new Error("applied sequence mismatch");
    const restore = this.local.restoreProposal();
    if (restore && proposed && !stale) {
      if (base?.manifest.revisionId !== restore.baseRevision && applied.revisionId !== restore.revision) throw new Error("restore base changed during recovery");
      if (applied.revisionId !== restore.revision) await applyNewFiles(this.scanner.root, this.local, this.remote, proposed.manifest, proposed.sequence!, this.key);
      this.local.finishRestoreProposal(); proposed = null;
    }
    if (proposed && !stale && this.local.proposal()?.state === "accepted" && base) {
      // On a lost response the scan plan is reconstructed against the old applied
      // tree; never treat a remote merge as a local-only revision.
      const scan = await this.scanner.plan(base.manifest, proposed.manifest.revisionId, this.device, this.key, proposed.manifest);
      if (sameTree(scan.manifest, proposed.manifest)) await this.finishLocal(scan, proposed);
      else {
        // A merge revision includes remote entries. Identify the authenticated
        // local branch whose tree is still on disk before any destructive apply.
        let branch: Verified | null = proposed;
        let matched = false;
        for (let depth = 0; depth < 4 && branch && !matched; depth++) {
          const parents: Verified[] = await Promise.all(branch.manifest.parents.map((id: string) => this.verified(id)));
          branch = null;
          for (const candidate of parents) {
            if (candidate.manifest.vaultId !== this.vault) throw new Error("foreign merge parent");
            const candidateScan = await this.scanner.plan(base.manifest, candidate.manifest.revisionId, this.device, this.key, candidate.manifest);
            if (sameTree(candidateScan.manifest, candidate.manifest)) { candidateScan.commit(); matched = true; break; }
            if (candidate.sequence === null && candidate.manifest.creatingDeviceId === this.device) branch = candidate;
          }
        }
        if (!matched) throw new Error("local branch changed before merge apply");
        const sequence = this.local.head("accepted").sequence;
        await applyNewFiles(this.scanner.root, this.local, this.remote, proposed.manifest, sequence, this.key);
        this.local.clearProposal();
      }
      proposed = null;
    }
    if (stale && proposed) {
      if (!base) throw new Error("cannot merge without applied base");
      const scan = await this.scanner.plan(base.manifest, proposed.manifest.revisionId, this.device, this.key, proposed.manifest);
      if (!sameTree(scan.manifest, proposed.manifest)) throw new Error("local edits changed after frozen proposal");
      scan.commit();
      proposed = await this.reconcile(base, proposed, stale);
      await applyNewFiles(this.scanner.root, this.local, this.remote, proposed.manifest, proposed.sequence!, this.key);
      this.local.clearProposal();
    }
    const head = await this.remote.head();
    this.local.recordHead("observed", head);
    if (!head.revisionId) throw new Error("server has no genesis revision");
    const current = await this.verified(head.revisionId);
    if (current.sequence !== head.sequence) throw new Error("head sequence mismatch");
    const latest = this.local.head("applied");
    if (!latest.revisionId) {
       if (this.scanner.snapshot().length > 1) {
         // Treat local files as an independent branch from the verified empty
         // genesis. Publishing against the current head produces a stale-head
         // merge rather than overwriting either side's existing files.
         let genesis = current;
         const seen = new Set<string>();
         while (genesis.manifest.parents.length) {
           if (seen.size >= 16_384 || seen.has(genesis.manifest.revisionId)) throw new Error("unbounded genesis ancestry");
           seen.add(genesis.manifest.revisionId);
           genesis = await this.verified(genesis.manifest.parents[0]!);
         }
         if (genesis.sequence !== 1 || genesis.manifest.entries.length !== 1)
           throw new Error("vault does not have an empty authenticated genesis");
         const baseHead = { revisionId: genesis.manifest.revisionId, sequence: 1 };
         this.local.recordHead("accepted", baseHead);
         this.local.recordHead("applied", baseHead);
         return this.run();
      }
      this.local.recordHead("accepted", head);
      await applyNewFiles(this.scanner.root, this.local, this.remote, current.manifest, head.sequence, this.key);
      return;
    }
    const prior = await this.verified(latest.revisionId);
    if (prior.sequence !== latest.sequence) throw new Error("applied revision sequence mismatch");
    if (head.revisionId !== latest.revisionId) await this.remotePath(prior, current);
    else if (head.sequence !== latest.sequence) throw new Error("applied head sequence changed");
    const scan = await this.scanner.plan(prior.manifest, randomUUID(), this.device, this.key);
    if (sameTree(scan.manifest, prior.manifest)) {
      if (head.sequence > latest.sequence) {
        this.local.recordHead("accepted", head);
        await applyNewFiles(this.scanner.root, this.local, this.remote, current.manifest, head.sequence, this.key);
      }
      return;
    }
    let next = await this.publish(scan, prior);
    if (!next.stale && next.local) { await this.finishLocal(scan, next.local); return; }
    scan.commit();
    if (!next.stale || !next.local) throw new Error("missing stale merge inputs");
    const resolved = await this.reconcile(prior, next.local, next.stale);
    await applyNewFiles(this.scanner.root, this.local, this.remote, resolved.manifest, resolved.sequence!, this.key);
    this.local.clearProposal();
  }

}
