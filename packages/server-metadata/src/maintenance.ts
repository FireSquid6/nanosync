import type { ObjectCatalogRow, RevisionRow } from "./schema.ts";
import { MAX_SQLITE_TIMESTAMP_MS } from "./schema.ts";
import {
  ServerMetadataDatabase,
  type MetadataTransaction,
} from "./database.ts";

const DAY = 86_400_000;
export const GC_GRACE_MS = DAY;

function validTime(nowMs: number): void {
  if (
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    nowMs > MAX_SQLITE_TIMESTAMP_MS
  )
    throw new RangeError("Invalid UTC timestamp");
}

/** Selection only: no persisted revisions are pruned without an acknowledged client base protocol. */
export function selectRetention(
  rows: readonly {
    revision_id: string;
    accepted_sequence: number | null;
    server_created_at_ms: number;
  }[],
  nowMs: number,
): Set<string> {
  validTime(nowMs);
  const chosen = new Set<string>();
  const daily = new Set<string>(),
    monthly = new Set<string>();
  const ordered = rows
    .filter((r) => r.accepted_sequence !== null)
    .sort(
      (a, b) =>
        b.server_created_at_ms - a.server_created_at_ms ||
        (b.accepted_sequence ?? 0) - (a.accepted_sequence ?? 0) ||
        a.revision_id.localeCompare(b.revision_id),
    );
  for (const row of ordered) {
    const age = nowMs - row.server_created_at_ms;
    if (age < 0) {
      chosen.add(row.revision_id);
      continue;
    }
    const date = new Date(row.server_created_at_ms);
    if (!Number.isFinite(date.getTime())) {
      chosen.add(row.revision_id);
      continue;
    }
    const month = `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
    const day = `${month}-${String(date.getUTCDate()).padStart(2, "0")}`;
    if (age <= 3 * DAY) chosen.add(row.revision_id);
    if (age <= 30 * DAY && !daily.has(day)) {
      daily.add(day);
      chosen.add(row.revision_id);
    }
    if (age <= 365 * DAY && !monthly.has(month)) {
      monthly.add(month);
      chosen.add(row.revision_id);
    }
  }
  return chosen;
}

export interface RetentionReport {
  selected: string[];
  protected: string[];
  notSelected: string[];
  /** Deliberately zero until clients acknowledge merge bases. */
  deletableRevisions: 0;
}

export class MaintenanceRepository {
  constructor(private readonly db: ServerMetadataDatabase) {}

  retentionDryRun(nowMs: number): RetentionReport {
    validTime(nowMs);
    return this.retentionFromRows(
      nowMs,
      this.db.all<RevisionRow>(
        "SELECT * FROM revisions ORDER BY accepted_sequence, revision_id",
      ),
    );
  }

  retentionDryRunBounded(nowMs: number, maxRows = 10_000): RetentionReport {
    validTime(nowMs);
    if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 10_000)
      throw new RangeError("Invalid retention limit");
    const rows = this.db.all<RevisionRow>(
      "SELECT * FROM revisions ORDER BY accepted_sequence, revision_id LIMIT ?",
      [maxRows + 1],
    );
    if (rows.length > maxRows)
      throw new RangeError("Retention report exceeds revision limit");
    return this.retentionFromRows(nowMs, rows);
  }

  private retentionFromRows(
    nowMs: number,
    rows: RevisionRow[],
  ): RetentionReport {
    const chosen = selectRetention(rows, nowMs);
    const protectedIds = new Set<string>();
    const head = this.db.get<{ current_head_revision_id: string | null }>(
      "SELECT current_head_revision_id FROM server_state WHERE singleton = 1",
    );
    if (head?.current_head_revision_id)
      protectedIds.add(head.current_head_revision_id);
    // All prepared revisions and all ancestors are merge bases until a client ACK protocol exists.
    for (const r of rows)
      if (r.accepted_sequence === null) protectedIds.add(r.revision_id);
    for (const r of rows)
      if (
        r.server_created_at_ms > nowMs ||
        !Number.isFinite(new Date(r.server_created_at_ms).getTime())
      )
        protectedIds.add(r.revision_id);
    for (const r of this.db.all<{ parent_revision_id: string }>(
      "SELECT parent_revision_id FROM revision_parents",
    ))
      protectedIds.add(r.parent_revision_id);
    return {
      selected: rows
        .filter((r) => chosen.has(r.revision_id))
        .map((r) => r.revision_id),
      protected: rows
        .filter((r) => protectedIds.has(r.revision_id))
        .map((r) => r.revision_id),
      notSelected: rows
        .filter(
          (r) => !chosen.has(r.revision_id) && !protectedIds.has(r.revision_id),
        )
        .map((r) => r.revision_id),
      deletableRevisions: 0,
    };
  }

  catalog(cursor = "", limit = 100): ObjectCatalogRow[] {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
      throw new RangeError("Invalid page limit");
    return this.db.all<ObjectCatalogRow>(
      "SELECT * FROM object_catalog WHERE object_id > ? ORDER BY object_id LIMIT ?",
      [cursor, limit],
    );
  }

  integritySummary(): {
    total: number;
    unchecked: number;
    verified: number;
    missing: number;
    corrupt: number;
    ciphertextBytes: number;
  } {
    const rows = this.db.all<{
      integrity_status: string;
      count: number;
      bytes: number;
    }>(
      "SELECT integrity_status, count(*) AS count, coalesce(sum(ciphertext_length), 0) AS bytes FROM object_catalog GROUP BY integrity_status",
    );
    const result = {
      total: 0,
      unchecked: 0,
      verified: 0,
      missing: 0,
      corrupt: 0,
      ciphertextBytes: 0,
    };
    for (const row of rows) {
      if (
        row.integrity_status in result &&
        row.integrity_status !== "total" &&
        row.integrity_status !== "ciphertextBytes"
      )
        result[
          row.integrity_status as
            "unchecked" | "verified" | "missing" | "corrupt"
        ] = row.count;
      result.total += row.count;
      result.ciphertextBytes += row.bytes;
    }
    return result;
  }

  setIntegrity(
    row: ObjectCatalogRow,
    status: "verified" | "missing" | "corrupt",
    atMs: number,
  ): boolean {
    validTime(atMs);
    return this.db.writeTransaction(
      (tx) =>
        tx.run(
          `UPDATE object_catalog SET integrity_status = ?, integrity_checked_at_ms = ?
       WHERE vault_id = ? AND object_id = ? AND ciphertext_checksum = ? AND ciphertext_length = ?
         AND integrity_status = ? AND integrity_checked_at_ms IS ?`,
          [
            status,
            atMs,
            row.vault_id,
            row.object_id,
            row.ciphertext_checksum,
            row.ciphertext_length,
            row.integrity_status,
            row.integrity_checked_at_ms,
          ],
        ).changes === 1,
    );
  }

  /** Mark only verified abandoned uploads; retain all revisions, even unselected history. */
  markCandidates(nowMs: number): number {
    validTime(nowMs);
    return this.db.writeTransaction(
      (tx) =>
        tx.run(
          `INSERT OR IGNORE INTO gc_candidates(vault_id, object_id, marked_at_ms)
       SELECT o.vault_id, o.object_id, ? FROM object_catalog o
       WHERE o.integrity_status = 'verified' AND o.durable_created_at_ms <= ?
         AND NOT EXISTS (SELECT 1 FROM revision_objects r WHERE r.vault_id = o.vault_id AND r.object_id = o.object_id)
         AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = o.vault_id AND r.manifest_object_id = o.object_id)
         AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.vault_id = o.vault_id AND u.object_id = o.object_id AND u.state = 'active')`,
          [nowMs, Math.max(0, nowMs - GC_GRACE_MS)],
        ).changes,
    );
  }

  potentialCandidates(nowMs: number): number {
    validTime(nowMs);
    return (
      this.db.get<{ count: number }>(
        `SELECT count(*) AS count FROM object_catalog o
      WHERE o.integrity_status = 'verified' AND o.durable_created_at_ms <= ?
        AND NOT EXISTS (SELECT 1 FROM revision_objects r WHERE r.vault_id = o.vault_id AND r.object_id = o.object_id)
        AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = o.vault_id AND r.manifest_object_id = o.object_id)
        AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.vault_id = o.vault_id AND u.object_id = o.object_id AND u.state = 'active')`,
        [Math.max(0, nowMs - GC_GRACE_MS)],
      )?.count ?? 0
    );
  }

  candidates(): {
    vault_id: string;
    object_id: string;
    marked_at_ms: number;
  }[] {
    return this.db.all(
      "SELECT * FROM gc_candidates ORDER BY marked_at_ms, object_id",
    );
  }

  candidateSummary(nowMs: number): { pending: number; eligible: number } {
    validTime(nowMs);
    const result = this.db.get<{ pending: number; eligible: number }>(
      `SELECT count(*) AS pending, coalesce(sum(CASE WHEN
      c.marked_at_ms <= ? AND o.durable_created_at_ms <= ? AND o.integrity_status = 'verified'
      AND NOT EXISTS (SELECT 1 FROM revision_objects r WHERE r.vault_id = o.vault_id AND r.object_id = o.object_id)
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = o.vault_id AND r.manifest_object_id = o.object_id)
      AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.vault_id = o.vault_id AND u.object_id = o.object_id AND u.state = 'active')
      THEN 1 ELSE 0 END), 0) AS eligible
      FROM gc_candidates c LEFT JOIN object_catalog o USING (vault_id, object_id)`,
      [Math.max(0, nowMs - GC_GRACE_MS), Math.max(0, nowMs - GC_GRACE_MS)],
    );
    return result ?? { pending: 0, eligible: 0 };
  }

  eligibleDryRun(vaultId: string, objectId: string, nowMs: number): boolean {
    validTime(nowMs);
    return !!this.db.get(
      `SELECT 1 FROM gc_candidates c JOIN object_catalog o USING (vault_id, object_id)
      WHERE c.vault_id = ? AND c.object_id = ? AND c.marked_at_ms <= ? AND o.durable_created_at_ms <= ?
      AND o.integrity_status = 'verified'
      AND NOT EXISTS (SELECT 1 FROM revision_objects r WHERE r.vault_id = o.vault_id AND r.object_id = o.object_id)
      AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = o.vault_id AND r.manifest_object_id = o.object_id)
      AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.vault_id = o.vault_id AND u.object_id = o.object_id AND u.state = 'active')`,
      [
        vaultId,
        objectId,
        Math.max(0, nowMs - GC_GRACE_MS),
        Math.max(0, nowMs - GC_GRACE_MS),
      ],
    );
  }

  /** Recheck in an immediate transaction just before deletion. Only valid while server is stopped. */
  eligible(
    vaultId: string,
    objectId: string,
    nowMs: number,
  ): ObjectCatalogRow | null {
    validTime(nowMs);
    return this.db.writeTransaction((tx) => {
      const row = tx.get<ObjectCatalogRow>(
        `SELECT o.* FROM gc_candidates c JOIN object_catalog o USING (vault_id, object_id)
        WHERE c.vault_id = ? AND c.object_id = ? AND o.integrity_status = 'verified'
          AND c.marked_at_ms <= ? AND o.durable_created_at_ms <= ?
          AND NOT EXISTS (SELECT 1 FROM revision_objects r WHERE r.vault_id = o.vault_id AND r.object_id = o.object_id)
          AND NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = o.vault_id AND r.manifest_object_id = o.object_id)
          AND NOT EXISTS (SELECT 1 FROM upload_sessions u WHERE u.vault_id = o.vault_id AND u.object_id = o.object_id AND u.state = 'active')
          AND NOT EXISTS (SELECT 1 FROM server_state s JOIN revisions h ON h.vault_id = s.vault_id AND h.revision_id = s.current_head_revision_id WHERE h.manifest_object_id = o.object_id)`,
        [
          vaultId,
          objectId,
          Math.max(0, nowMs - GC_GRACE_MS),
          Math.max(0, nowMs - GC_GRACE_MS),
        ],
      );
      // A not-yet-mature mark must remain for the next offline pass.
      if (
        !row &&
        tx.get<{ marked_at_ms: number }>(
          "SELECT marked_at_ms FROM gc_candidates WHERE vault_id = ? AND object_id = ?",
          [vaultId, objectId],
        )?.marked_at_ms! <=
          nowMs - GC_GRACE_MS
      ) {
        tx.run(
          "DELETE FROM gc_candidates WHERE vault_id = ? AND object_id = ?",
          [vaultId, objectId],
        );
      }
      return row;
    });
  }

  finish(row: ObjectCatalogRow): void {
    this.db.writeTransaction((tx: MetadataTransaction) => {
      // A missing candidate or newly reachable object must never be removed from the catalog.
      const candidate = tx.get(
        "SELECT 1 FROM gc_candidates WHERE vault_id = ? AND object_id = ?",
        [row.vault_id, row.object_id],
      );
      const references = tx.get(
        `SELECT 1 FROM revision_objects WHERE vault_id = ? AND object_id = ?
        UNION SELECT 1 FROM revisions WHERE vault_id = ? AND manifest_object_id = ?
        UNION SELECT 1 FROM upload_sessions WHERE vault_id = ? AND object_id = ? AND state = 'active'`,
        [
          row.vault_id,
          row.object_id,
          row.vault_id,
          row.object_id,
          row.vault_id,
          row.object_id,
        ],
      );
      if (!candidate || references)
        throw new Error("GC candidate changed during offline deletion");
      tx.run("DELETE FROM gc_candidates WHERE vault_id = ? AND object_id = ?", [
        row.vault_id,
        row.object_id,
      ]);
      tx.run(
        "DELETE FROM object_catalog WHERE vault_id = ? AND object_id = ? AND integrity_status = 'verified'",
        [row.vault_id, row.object_id],
      );
    });
  }
}
