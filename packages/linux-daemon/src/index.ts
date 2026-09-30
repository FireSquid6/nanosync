import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants, chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ClientLocal } from "@nanosync/client-local";
import { applyNewFiles, hydrateFile, LinuxScanner, LinuxWatcher, type ScanOptions, type ScanPlan } from "@nanosync/linux-client";
import { decryptManifest, HttpRemote, IntegrityError, manifestPaths, mergeManifests, parseManifest, verifyReferenceSetMac, history, planRestore, planRestoreRevision, restoreReferences, type ManifestV1, type RemoteOptions } from "@nanosync/sync-core";
import { parseDeviceId, parseRevisionId, parseVaultId, type RevisionEnvelope, type VisibleObjectReference } from "@nanosync/protocol";
import { acquireStartupGate, type FileIdentity } from "./startup-lock.ts";
import { CommandError, exitCode, failureState, type FailureState, type SyncState } from "./status.ts";
export { CommandError, exitCode, failureState, type SyncState } from "./status.ts";

type Verified = { manifest: ManifestV1; revision: RevisionEnvelope; sequence: number | null };
export interface DaemonOptions {
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
export interface DaemonStatus {
  state: SyncState;
  /** Stable exit code for this status snapshot; nonzero means not completely synchronized. */
  exitCode: number;
  phase: "starting" | "idle" | "syncing" | "paused" | "error";
  /** Head equality only, not a claim that unscanned filesystem edits do not exist. */
  headsConverged: boolean;
  paused: boolean;
  error: string | null;
  observed: ReturnType<ClientLocal["head"]>;
  accepted: ReturnType<ClientLocal["head"]>;
  applied: ReturnType<ClientLocal["head"]>;
  pendingProposal: boolean;
  pendingApplies: number;
  pendingOperations: number;
  remoteOnlyFiles: number;
  downloadedFiles: number;
  lastSuccessMs: number | null;
}

function privateDirectory(path: string) {
  const target = resolve(path);
  if (!existsSync(target)) mkdirSync(target, { mode: 0o700 });
  const st = lstatSync(target);
  if (!st.isDirectory() || st.isSymbolicLink() || st.uid !== process.getuid!() || st.mode & 0o077 || realpathSync(target) !== target)
    throw new Error("unsafe client directory");
  return target;
}
function privateFile(path: string) {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.uid !== process.getuid!() || st.mode & 0o177)
    throw new Error("unsafe private file");
}
function secret(path: string): string {
  if (!existsSync(path)) {
    const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, randomBytes(32).toString("hex")); fsyncSync(fd); } finally { closeSync(fd); }
  }
  privateFile(path);
  const value = readFileSync(path, "utf8");
  if (!/^[0-9a-f]{64}$/.test(value)) throw new Error("invalid IPC credential");
  return value;
}
function sameTree(a: ManifestV1, b: ManifestV1): boolean { return JSON.stringify(a.entries) === JSON.stringify(b.entries); }
function refs(revision: RevisionEnvelope): VisibleObjectReference[] { return revision.references.filter(r => r.objectType === "chunk"); }
function validIpcPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.normalize("NFC") && Buffer.byteLength(value) <= 512 &&
    !value.startsWith("/") && value.split("/").every(part => part && part !== "." && part !== ".." && Buffer.byteLength(part) <= 255 &&
      !/[\u0000-\u001f\u007f-\u009f\\:*?"<>|]/u.test(part) && !/[. ]$/u.test(part) &&
      !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part));
}

export class LinuxDaemon {
  readonly socketPath: string;
  readonly credentialPath: string;
  private readonly local: ClientLocal;
  private readonly scanner: LinuxScanner;
  private readonly watcher: LinuxWatcher;
  private readonly remote: HttpRemote;
  private readonly key: Uint8Array;
  private readonly vault: string;
  private readonly device: string;
  private readonly root: string;
  private readonly pollMs: number;
  private readonly credential: string;
  private server?: ReturnType<typeof Bun.serve>;
  private timer?: ReturnType<typeof setInterval>;
  private active?: Promise<void>;
  private mutation?: Promise<unknown>;
  private restoring = false;
  private paused = false;
  private stopped = false;
  private phase: DaemonStatus["phase"] = "starting";
  private error: string | null = null;
  private failure: FailureState | "unknown" | null = null;
  private diskBaseline: string | null = null;
  private lastSuccessMs: number | null = null;
  private socketIdentity?: FileIdentity;

  private constructor(options: DaemonOptions) {
    this.vault = parseVaultId(options.vaultId); this.device = parseDeviceId(options.deviceId);
    if (!(options.masterKey instanceof Uint8Array) || options.masterKey.length !== 32) throw new Error("invalid vault key");
    this.key = Uint8Array.from(options.masterKey);
    this.root = privateDirectory(options.clientDirectory);
    this.socketPath = join(this.root, "daemon.sock"); this.credentialPath = join(this.root, "ipc.secret");
    this.pollMs = options.pollMs ?? 5000;
    if (!Number.isSafeInteger(this.pollMs) || this.pollMs < 100 || this.pollMs > 3600_000) throw new Error("invalid poll interval");
    this.credential = secret(this.credentialPath);
    this.local = new ClientLocal(this.root, this.vault, this.device);
    try {
      this.scanner = new LinuxScanner(options.syncDirectory, this.local, options.scan);
      this.watcher = new LinuxWatcher(this.scanner, options.scan);
      this.remote = new HttpRemote({ baseUrl: options.baseUrl, token: options.token,
        fetch: options.fetch ?? fetch, journal: this.local });
    } catch (e) { this.local.close(); throw e; }
  }

  static async start(options: DaemonOptions): Promise<LinuxDaemon> {
    const daemon = new LinuxDaemon(options);
    try {
      const release = acquireStartupGate(daemon.root);
      try {
        if (existsSync(daemon.socketPath)) {
          const st = lstatSync(daemon.socketPath);
          if (!st.isSocket() || st.uid !== process.getuid!() || st.mode & 0o177) throw new Error("unsafe daemon socket");
          // A failed connect is only a crash hint. The startup gate prevents another
          // local daemon from unlinking/rebinding concurrently during recovery.
          let alive = false;
          try { const response = await fetch("http://localhost/status", { unix: daemon.socketPath, method: "POST" } as RequestInit & { unix: string });
            alive = !!response;
          } catch { /* stale socket */ }
          if (alive) throw new Error("another daemon owns this client directory");
          const now = lstatSync(daemon.socketPath);
          if (now.dev !== st.dev || now.ino !== st.ino) throw new Error("daemon socket changed during recovery");
          unlinkSync(daemon.socketPath);
        }
        daemon.server = Bun.serve({ unix: daemon.socketPath, fetch: request => daemon.handle(request) });
        const st = lstatSync(daemon.socketPath);
        if (!st.isSocket() || st.uid !== process.getuid!()) throw new Error("unsafe IPC socket");
        daemon.socketIdentity = { dev: st.dev, ino: st.ino };
        chmodSync(daemon.socketPath, 0o600);
        const secured = lstatSync(daemon.socketPath);
        if (!secured.isSocket() || secured.uid !== st.uid || secured.dev !== st.dev || secured.ino !== st.ino || secured.mode & 0o177)
          throw new Error("unsafe IPC socket");
      } finally { release(); }
      // A linked download stage has nlink=2 and is intentionally rejected by
      // the normal scanner. Replay its durable intent before watcher inventory.
      await daemon.recoverHydration();
      daemon.watcher.start();
      let lastPoll = Date.now();
      daemon.timer = setInterval(() => {
        if (daemon.stopped || daemon.paused || daemon.active) return;
        if (Date.now() - lastPoll >= daemon.pollMs) {
          lastPoll = Date.now(); daemon.watcher.notify(); void daemon.sync().catch(() => {});
        } else {
          try { if (daemon.watcher.ready()) void daemon.sync().catch(() => {}); }
          catch { void daemon.sync().catch(() => {}); }
        }
      }, Math.min(daemon.pollMs, 250));
      void daemon.sync().catch(() => {});
      return daemon;
    } catch (error) { await daemon.stop(); throw error; }
  }

  status(): DaemonStatus {
    const observed = this.local.head("observed"), accepted = this.local.head("accepted"), applied = this.local.head("applied");
    const pendingProposal = !!this.local.proposal(), pendingApplies = this.local.pendingApplies().length;
    const pendingOperations = this.local.listWork("operations").filter(item => item.state !== "done").length;
    const files = this.local.entries().filter(item => item.kind === "file");
    // Metadata inventory is read-only. A changing or unsafe tree is never called synchronized.
    let diskCurrent = false;
    try { diskCurrent = this.diskBaseline !== null && this.diskSignature() === this.diskBaseline; }
    catch { /* inspection cannot establish a clean tree */ }
    const openConflicts = this.local.listWork("conflicts").some(item => item.state === "open");
    const pendingHydration = this.local.pendingHydration();
    const pendingTransfers = this.local.listWork("transfers").filter(item => item.state !== "done");
    const remoteOnlyFiles = files.filter(item => item.hydration === "evicted").length;
    const headsConverged = this.phase === "idle" && !pendingProposal && !pendingApplies && !pendingOperations && !!applied.revisionId &&
        observed.revisionId === accepted.revisionId && accepted.revisionId === applied.revisionId &&
        observed.sequence === accepted.sequence && accepted.sequence === applied.sequence;
    const state: SyncState = this.failure && this.failure !== "unknown" ? this.failure :
      openConflicts ? "conflict_blocked" : this.paused ? "paused" :
      this.phase === "syncing" ? pendingApplies || pendingHydration?.direction === "download" || pendingTransfers.some(item => item.direction === "download")
        ? "downloading" : pendingProposal || pendingTransfers.some(item => item.direction === "upload") ? "uploading" : "syncing" :
      this.phase === "error" ? "unknown" :
      !diskCurrent || pendingProposal || pendingOperations || pendingApplies || pendingHydration || pendingTransfers.length ||
        observed.revisionId !== applied.revisionId || accepted.revisionId !== applied.revisionId ? "local_changes_pending" :
      remoteOnlyFiles ? "remote_only" : headsConverged && diskCurrent ? "synchronized" : "unknown";
    return { state, exitCode: exitCode(state), phase: this.phase, paused: this.paused, error: this.error, observed,
      headsConverged,
      accepted, applied, pendingProposal, pendingApplies, pendingOperations,
      remoteOnlyFiles,
      downloadedFiles: files.filter(item => item.hydration === "downloaded").length, lastSuccessMs: this.lastSuccessMs };
  }
  private diskSignature(): string {
    return JSON.stringify(this.scanner.snapshot().map(item => [item.path, item.kind, item.stat.dev, item.stat.ino,
      item.stat.size, item.stat.mtimeMs, item.stat.ctimeMs, item.stat.mode]));
  }
  pause() { this.paused = true; this.phase = "paused"; }
  resume() { this.paused = false; this.watcher.notify(0); this.phase = "idle"; void this.sync().catch(() => {}); }
  private tracked<T>(action: () => Promise<T>): Promise<T> {
    if (this.mutation) return Promise.reject(new Error("local mutation already in progress"));
    const work = action(); this.mutation = work;
    void work.finally(() => { if (this.mutation === work) this.mutation = undefined; }).catch(() => {});
    return work;
  }
  private async history(path?: string) {
    const head = await this.remote.head();
    if (!head.revisionId) throw new Error("vault has no head");
    return history(this.remote, head.revisionId, this.key, path);
  }
  private async hydrate(direction: "evict" | "download", path: string) {
    if (this.paused || this.restoring) throw new Error("daemon busy or paused");
    this.restoring = true;
    try {
      await this.sync(true);
      const applied = this.local.head("applied"), remoteHead = await this.remote.head();
      if (!applied.revisionId || applied.revisionId !== remoteHead.revisionId || applied.sequence !== remoteHead.sequence ||
          this.local.head("accepted").revisionId !== applied.revisionId || this.local.proposal()) throw new Error("accepted revision changed; synchronize before hydration");
      const verified = await this.verified(applied.revisionId);
      const result = await hydrateFile(this.scanner.root, this.local, this.remote, verified.manifest, verified.revision, this.key, direction, path);
      this.diskBaseline = this.diskSignature();
      this.watcher.notify(0);
      return result;
    } finally { this.restoring = false; }
  }
  private async restore(revisionId: string, path?: string) {
    if (this.paused) throw new Error("daemon paused");
    if (this.restoring) throw new Error("restore already in progress");
    this.restoring = true;
    try {
    // Settle local edits first; restoration must branch from the accepted head.
    await this.sync(true);
    const head = await this.remote.head();
    if (!head.revisionId || head.revisionId !== this.local.head("applied").revisionId ||
        head.sequence !== this.local.head("applied").sequence || this.local.proposal()) throw new Error("head changed during restore");
    const current = await this.verified(head.revisionId), old = await this.verified(revisionId);
    if (current.sequence !== head.sequence) throw new Error("restore head sequence mismatch");
    if (old.sequence === null) throw new Error("revision was not accepted");
    const planned = path === undefined
      ? planRestoreRevision(current.manifest, old.manifest, randomUUID(), this.device, head.revisionId)
      : planRestore(current.manifest, old.manifest, path, randomUUID(), this.device, head.revisionId);
    const references = await restoreReferences(planned, [{ manifest: current.manifest, envelope: current.revision }, { manifest: old.manifest, envelope: old.revision }], this.key);
    const result = await this.remote.publish(planned, references, [], this.key, head.revisionId, new Date().toISOString(),
      (request, frame) => this.local.freezeRestoreProposal(request, frame, head.revisionId!));
    if (result.status === "accepted" || result.status === "alreadyAccepted") this.local.acceptProposal(result.sequence);
    else { if (result.status === "staleHead") this.local.discardStaleRestore(); throw new Error(`restore not accepted: ${result.status}`); }
    // Apply the accepted historical file through the durable apply journal.
    // The generic proposal replay assumes its local branch differs from its base,
    // which is not true for a server-side restore of unchanged local files.
    await applyNewFiles(this.scanner.root, this.local, this.remote, planned, result.sequence, this.key);
    this.local.finishRestoreProposal();
    return { revisionId: planned.revisionId, sequence: result.sequence };
    } finally { this.restoring = false; }
  }
  private async resolveConflict(path: string) {
    if (this.paused || this.restoring) throw new Error("daemon busy or paused");
    this.restoring = true;
    try {
      // This pass publishes any pending local edits (including edits to either
      // side of the conflict) before the explicitly requested discard.
      await this.sync(true);
      const applied = this.local.head("applied"), head = await this.remote.head();
      if (!head.revisionId || head.revisionId !== applied.revisionId || head.sequence !== applied.sequence ||
          this.local.head("accepted").revisionId !== head.revisionId || this.local.proposal())
        throw new Error("head changed during conflict resolution; synchronize and retry");
      const current = await this.verified(head.revisionId);
      if (current.sequence !== head.sequence) throw new Error("conflict resolution head sequence mismatch");
      const entry = manifestPaths(current.manifest).get(path);
      if (!entry?.conflict || entry.kind !== "file") throw new Error("path is not a live file conflict copy");
      const planned = parseManifest({ ...current.manifest, revisionId: randomUUID(), parents: [head.revisionId],
        creatingDeviceId: this.device, entries: current.manifest.entries.map(item => item.id === entry.id
          ? { id: item.id, parentId: item.parentId, name: item.name, kind: "tombstone", deletedKind: "file" }
          : item) });
      const references = await restoreReferences(planned, [{ manifest: current.manifest, envelope: current.revision }], this.key);
      const result = await this.remote.publish(planned, references, [], this.key, head.revisionId, new Date().toISOString(),
        (request, frame) => this.local.freezeRestoreProposal(request, frame, head.revisionId!));
      if (result.status === "accepted" || result.status === "alreadyAccepted") this.local.acceptProposal(result.sequence);
      else {
        if (result.status === "staleHead") this.local.discardStaleRestore();
        throw new Error(`conflict resolution not accepted: ${result.status}`);
      }
      await applyNewFiles(this.scanner.root, this.local, this.remote, planned, result.sequence, this.key);
      this.local.finishRestoreProposal();
      this.local.reconcileConflicts(planned);
      this.watcher.notify(0);
      return { revisionId: planned.revisionId, sequence: result.sequence, resolvedPath: path };
    } finally { this.restoring = false; }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.watcher?.close();
    await this.mutation?.catch(() => {});
    await this.active?.catch(() => {});
    if (this.server) {
      // Bun.stop unlinks its configured pathname without checking the inode.
      // Preserve an unexpected replacement with a temporary hardlink before
      // calling it. linkSync on Unix sockets is supported on Linux.
      let backup: string | undefined;
      try {
        const current = lstatSync(this.socketPath);
        if (!this.socketIdentity || current.dev !== this.socketIdentity.dev || current.ino !== this.socketIdentity.ino) {
          if (!current.isSocket() || current.uid !== process.getuid!()) throw new Error("unsafe replacement daemon socket");
          backup = join(this.root, `.daemon-socket-${randomUUID()}`);
          linkSync(this.socketPath, backup);
          const confirmed = lstatSync(this.socketPath), saved = lstatSync(backup);
          if (confirmed.dev !== saved.dev || confirmed.ino !== saved.ino) throw new Error("replacement socket changed during stop");
        }
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      this.server.stop(true); this.server = undefined;
      if (backup) {
        try {
          if (!existsSync(this.socketPath)) linkSync(backup, this.socketPath);
          const current = lstatSync(this.socketPath), saved = lstatSync(backup);
          if (current.dev !== saved.dev || current.ino !== saved.ino)
            throw new Error(`replacement socket moved during stop; preserved at ${backup}`);
          unlinkSync(backup);
        } catch (error) {
          // Do not unlink the only path still reaching the other server.
          throw error;
        }
      }
      try {
        const st = lstatSync(this.socketPath);
        if (this.socketIdentity && st.isSocket() && st.uid === process.getuid!() &&
            st.dev === this.socketIdentity.dev && st.ino === this.socketIdentity.ino) unlinkSync(this.socketPath);
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
    this.local.close(); this.key.fill(0);
  }
  /** Serialized manual/automatic pass. A failed pass remains visibly failed until a later successful pass. */
  sync(internalRestore = false): Promise<void> {
    if (this.stopped) return Promise.reject(new Error("daemon stopped"));
    if (this.restoring && !internalRestore) return Promise.reject(new Error("restore in progress"));
    if (this.paused) return Promise.reject(new Error("daemon paused"));
    if (this.active) return this.active;
    this.phase = "syncing";
    const work = (async () => {
      try {
        await this.run();
        const applied = this.local.head("applied");
        if (applied.revisionId) this.local.reconcileConflicts((await this.verified(applied.revisionId)).manifest);
        this.local.recordHead("observed", await this.remote.head());
        this.watcher.refresh();
        this.diskBaseline = this.diskSignature();
        this.error = null; this.failure = null; this.phase = this.paused ? "paused" : "idle"; this.lastSuccessMs = Date.now();
      } catch (error) {
        this.error = error instanceof Error ? error.message : "synchronization failed";
        this.failure = failureState(error);
        this.phase = this.paused ? "paused" : "error"; throw error;
      }
    })();
    this.active = work;
    void work.finally(() => { if (this.active === work) this.active = undefined; }).catch(() => {});
    return work;
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
    const request = proposal.request, reference = request.proposedRevision.references.find(r => r.objectId === request.proposedRevision.encryptedManifestObjectId)!;
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

  private async run() {
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

  private async handle(request: Request): Promise<Response> {
    const supplied = request.headers.get("authorization");
    if (!supplied || !/^Bearer [0-9a-f]{64}$/.test(supplied) ||
        !timingSafeEqual(Buffer.from(supplied.slice(7)), Buffer.from(this.credential)))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.headers.get("content-length") && Number(request.headers.get("content-length")) > 1024)
      return Response.json({ error: "request too large" }, { status: 413 });
    const url = new URL(request.url);
    const commands: Record<string, (body: Record<string, unknown>) => Promise<unknown> | unknown> = {
      status: () => this.status(), pause: () => { this.pause(); return this.status(); },
      resume: () => { this.resume(); return this.status(); },
      sync: async () => { await this.sync(); return this.status(); },
      conflicts: () => this.local.listWork("conflicts").filter(item => item.state === "open"),
      history: body => this.history(body.path as string | undefined),
      restore: body => this.tracked(() => this.restore(body.revision as string, body.path as string)),
      resolve: body => this.tracked(() => this.resolveConflict(body.path as string)),
      evict: body => this.tracked(() => this.hydrate("evict", body.path as string)),
      download: body => this.tracked(() => this.hydrate("download", body.path as string)),
      doctor: async () => ({ status: this.status(), capabilities: await this.remote.capabilities() }),
    };
    if (request.method !== "POST" || !Object.hasOwn(commands, url.pathname.slice(1)) || url.search || request.headers.get("content-type") !== "application/json")
      return Response.json({ error: "invalid command" }, { status: 400 });
    try {
      if (!request.body) throw new Error("missing command body");
      const reader = request.body.getReader(); let size = 0; const chunks: Uint8Array[] = [];
      try {
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          if (!(value instanceof Uint8Array) || value.length > 1024 - size) {
            void reader.cancel().catch(() => {}); throw new Error("command body exceeds limit");
          }
          size += value.length; chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const body = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      for (const key of ["path", "revision"]) if ([...body.matchAll(new RegExp(`"${key}"\\s*:`, "g"))].length > 1) throw new Error("duplicate command field");
      const value = JSON.parse(body) as Record<string, unknown>;
      if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("invalid command body");
      const command = url.pathname.slice(1);
      const fields = command === "history" || command === "evict" || command === "download" || command === "resolve" ? ["path"] : command === "restore" ? ["path", "revision"] : [];
      if (Object.keys(value).some(key => !fields.includes(key))) throw new Error("invalid command fields");
      if (value.path !== undefined && !validIpcPath(value.path)) throw new Error("invalid relative path");
      if (command === "restore") {
        parseRevisionId(value.revision);
        if (value.path !== undefined && typeof value.path !== "string") throw new Error("invalid restore path");
      }
      if ((command === "evict" || command === "download" || command === "resolve") && typeof value.path !== "string") throw new Error("file path required");
      return Response.json(await commands[command]!(value));
    } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "failed", state: failureState(error) }, { status: 409 }); }
  }
}

export async function startDaemon(options: DaemonOptions) { return LinuxDaemon.start(options); }
export async function stopDaemon(daemon: LinuxDaemon) { await daemon.stop(); }
export async function daemonCommand(clientDirectory: string, command: "status" | "pause" | "resume" | "sync" | "history" | "restore" | "resolve" | "conflicts" | "doctor" | "evict" | "download", args: { path?: string; revision?: string } = {}): Promise<any> {
  const root = privateDirectory(clientDirectory), token = secret(join(root, "ipc.secret"));
  let response: Response;
  try {
    response = await fetch(`http://localhost/${command}`, { unix: join(root, "daemon.sock"), method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) } as RequestInit & { unix: string });
  } catch { throw new CommandError("local daemon unavailable", "offline"); }
  const result = await response.json() as DaemonStatus | { error: string; state?: FailureState | "unknown" };
  if (!response.ok) throw new CommandError((result as { error: string }).error, (result as { state?: FailureState | "unknown" }).state ?? "unknown");
  return result as DaemonStatus;
}
