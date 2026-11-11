import { createHash } from "node:crypto";
import { OBJECT_FRAME_HEADER_BYTES, parseObjectFrameHeader } from "@nanosync/protocol";
import { GC_GRACE_MS, MaintenanceRepository, type ObjectCatalogRow } from "@nanosync/server-metadata";
import { ObjectStorageError, type Filesystem } from "@nanosync/server-object-storage";
import { objectKey } from "./object-service.ts";

export interface OfflineOperatorControl {
  /** Operator must hold exclusive control of both metadata and object storage, with API stopped. */
  assertExclusiveOffline(): void;
}

function assertTime(now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new RangeError("Invalid UTC timestamp");
}

export class ServerMaintenance {
  constructor(private readonly metadata: MaintenanceRepository, private readonly storage: Filesystem) {}

  /** Full ciphertext frame SHA-256; never buffers the entire object. */
  async scan(nowMs: number, signal?: AbortSignal): Promise<ScanCounts> {
    assertTime(nowMs);
    const result: ScanCounts = { verified: 0, missing: 0, corrupt: 0 };
    let cursor = "";
    while (true) {
      const batch = await this.scanBatch(nowMs, cursor, 100, signal);
      for (const status of ["verified", "missing", "corrupt"] as const) result[status] += batch.counts[status];
      if (batch.done) break;
      cursor = batch.cursor;
    }
    return result;
  }

  /** At most `limit` catalog entries per call; cursor is exclusive and restarts at empty after done. */
  async scanBatch(nowMs: number, cursor = "", limit = 100, signal?: AbortSignal): Promise<{ cursor: string; done: boolean; counts: ScanCounts }> {
    assertTime(nowMs);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new RangeError("Invalid scan batch limit");
    if (signal?.aborted) throw signal.reason ?? new Error("Integrity scan cancelled");
    const rows = this.metadata.catalog(cursor, limit);
    const counts: ScanCounts = { verified: 0, missing: 0, corrupt: 0 };
    for (const row of rows) {
      if (signal?.aborted) throw signal.reason ?? new Error("Integrity scan cancelled");
      let status: keyof ScanCounts;
       try { status = await verifyObject(this.storage, row, this.metadata.legacyVault(row.vault_id), signal); }
      catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        if (error instanceof ObjectStorageError && error.code === "NOT_FOUND") status = "missing";
        else if (error instanceof ObjectStorageError && ["SYMLINK", "NOT_REGULAR_FILE", "UNSAFE_PATH"].includes(error.code)) status = "corrupt";
        else throw error; // I/O uncertainty is not a missing object.
      }
      if (signal?.aborted) throw signal.reason ?? new Error("Integrity scan cancelled");
      if (this.metadata.setIntegrity(row, status, nowMs)) counts[status]++;
    }
    const last = rows.at(-1);
    return { cursor: last ? `${last.vault_id}:${last.object_id}` : cursor, done: rows.length < limit, counts };
  }

  gcDryRun(nowMs: number): { potential: number; eligible: number; pending: number; graceMs: number } {
    assertTime(nowMs);
    // Read-only inspection; no candidate marking or physical deletion.
    const { pending, eligible } = this.metadata.candidateSummary(nowMs);
    return { potential: this.metadata.potentialCandidates(nowMs), eligible, pending, graceMs: GC_GRACE_MS };
  }

  storageStatus(): ReturnType<MaintenanceRepository["integritySummary"]> { return this.metadata.integritySummary(); }

  retentionDryRun(nowMs: number): { selected: number; protected: number; notSelected: number; deletableRevisions: 0 } {
    const report = this.metadata.retentionDryRunBounded(nowMs);
    return { selected: report.selected.length, protected: report.protected.length, notSelected: report.notSelected.length, deletableRevisions: report.deletableRevisions };
  }

  /** Never invoke while serving requests. No HTTP route or background scheduler exposes this operation. */
  async collectOffline(control: OfflineOperatorControl, nowMs: number): Promise<{ marked: number; deleted: number; failed: number }> {
    assertTime(nowMs);
    control.assertExclusiveOffline();
    const marked = this.metadata.markCandidates(nowMs);
    let deleted = 0, failed = 0;
    for (const candidate of this.metadata.candidates()) {
      control.assertExclusiveOffline();
      const row = this.metadata.eligible(candidate.vault_id, candidate.object_id, nowMs);
      if (!row) continue;
      try {
         await this.storage.delete(objectKey(row.object_type, row.object_id, this.metadata.legacyVault(row.vault_id) ? undefined : row.vault_id));
        this.metadata.finish(row);
        deleted++;
      } catch { failed++; /* Persist candidate for safe re-evaluation on next offline run. */ }
    }
    return { marked, deleted, failed };
  }
}

export interface ScanCounts { verified: number; missing: number; corrupt: number; }

export interface IntegrityScanSchedule {
  intervalMs: number;
  batchSize?: number;
  clock?: () => number;
  onBatch?: (counts: ScanCounts) => void;
  onError: (error: unknown) => void;
}

/** Runtime opt-in. One bounded page per interval, single-flight; never schedules destructive GC. */
export class PeriodicIntegrityScanner {
  private timer: ReturnType<typeof setInterval> | undefined;
  private flight: Promise<void> | undefined;
  private controller: AbortController | undefined;
  private cursor = "";

  constructor(private readonly maintenance: ServerMaintenance, private readonly schedule: IntegrityScanSchedule) {
    if (!Number.isSafeInteger(schedule.intervalMs) || schedule.intervalMs < 1) throw new RangeError("Invalid integrity scan interval");
    if (schedule.batchSize !== undefined && (!Number.isInteger(schedule.batchSize) || schedule.batchSize < 1 || schedule.batchSize > 1000)) {
      throw new RangeError("Invalid integrity scan batch size");
    }
  }

  start(): void {
    if (this.timer) return;
    this.controller = new AbortController();
    this.timer = setInterval(() => { void this.tick(); }, this.schedule.intervalMs);
    void this.tick();
  }

  /** Returns after active I/O has settled; no further scans begin after stop. */
  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    this.controller?.abort();
    await this.flight;
    this.controller = undefined;
  }

  /** Safe to call from an operator timer or test; concurrent calls share the in-flight batch. */
  tick(): Promise<void> {
    if (this.flight) return this.flight;
    const controller = this.controller;
    if (!this.timer || !controller || controller.signal.aborted) return Promise.resolve();
    const flight = (async () => {
      try {
        const batch = await this.maintenance.scanBatch((this.schedule.clock ?? Date.now)(), this.cursor, this.schedule.batchSize ?? 100, controller.signal);
        if (!controller.signal.aborted) {
          this.cursor = batch.done ? "" : batch.cursor;
          this.schedule.onBatch?.(batch.counts);
        }
      } catch (error) {
        if (!controller.signal.aborted) {
          try { this.schedule.onError(error); } catch { /* Monitoring must not crash the scheduler. */ }
        }
      }
    })();
    this.flight = flight;
    void flight.finally(() => { if (this.flight === flight) this.flight = undefined; });
    return flight;
  }
}

async function verifyObject(storage: Filesystem, row: ObjectCatalogRow, legacy: boolean, signal?: AbortSignal): Promise<"verified" | "corrupt"> {
   const opened = await storage.open(objectKey(row.object_type, row.object_id, legacy ? undefined : row.vault_id));
  const reader = opened.stream.getReader();
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener("abort", cancel, { once: true });
  const hash = createHash("sha256");
  let length = 0, headerLength = 0;
  const header = new Uint8Array(OBJECT_FRAME_HEADER_BYTES);
  try {
    while (true) {
      if (signal?.aborted) throw signal.reason ?? new Error("Integrity scan cancelled");
      const next = await reader.read();
      if (next.done) break;
      const bytes = next.value;
      length += bytes.byteLength;
      if (length > row.ciphertext_length) return "corrupt";
      hash.update(bytes);
      const take = Math.min(bytes.byteLength, header.length - headerLength);
      if (take > 0) { header.set(bytes.subarray(0, take), headerLength); headerLength += take; }
    }
  } finally { signal?.removeEventListener("abort", cancel); await reader.cancel().catch(() => undefined); reader.releaseLock(); }
  if (opened.size !== row.ciphertext_length || length !== row.ciphertext_length || headerLength !== header.length || hash.digest("hex") !== row.ciphertext_checksum) return "corrupt";
  try {
    const frame = parseObjectFrameHeader(header);
    if (frame.vaultId !== row.vault_id || frame.objectId !== row.object_id || frame.objectType !== row.object_type
      || frame.objectFormatVersion !== row.object_format_version || frame.completeLength !== length) return "corrupt";
  } catch { return "corrupt"; }
  return "verified";
}
