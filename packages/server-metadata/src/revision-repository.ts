import {
  canonicalizePersistedRevisionEnvelope, parseAdvanceHeadResult, parsePersistedRevisionEnvelope,
  type AdvanceHeadResult, type DeviceId, type ObjectId, type PrincipalId,
  type RevisionEnvelope, type RevisionId, type VaultId,
} from "@nanosync/protocol";
import { ServerMetadataDatabase, type MetadataTransaction } from "./database.ts";
import { MAX_SQLITE_TIMESTAMP_MS, type ObjectCatalogRow, type RevisionObjectRow, type RevisionParentRow, type RevisionRow } from "./schema.ts";

export type RevisionRepositoryErrorCode = "IDEMPOTENCY_KEY_REUSE" | "VAULT_CONFLICT" | "SERVER_UNINITIALIZED" | "INVARIANT";
export class RevisionRepositoryError extends Error {
  constructor(readonly code: RevisionRepositoryErrorCode, message: string) { super(message); this.name = "RevisionRepositoryError"; }
}

export interface RevisionIdentity {
  principalId: PrincipalId;
  deviceId: DeviceId;
  vaultId: VaultId;
  idempotencyKey: string;
  requestDigest: string;
}
export interface StoredRevision { envelope: RevisionEnvelope; sequence: number | null; }
export interface AdvanceRevisionInput {
  identity: RevisionIdentity;
  expectedRevisionId: RevisionId;
  envelope: RevisionEnvelope;
  canonicalEnvelopeJson: string;
  nowMs: number;
}

const OPERATION = "advance-head-v1";
const QUERY_CHUNK = 350;
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export class RevisionRepository {
  constructor(private readonly database: ServerMetadataDatabase) {}

  requireVault(vaultId: VaultId): void { requireVaultReader(this.database, vaultId); }

  head(vaultId: VaultId): { revisionId: RevisionId | null; sequence: number } {
    requireVaultReader(this.database, vaultId);
    const row = this.database.get<{ current_head_revision_id: RevisionId | null; current_sequence: number }>(
      "SELECT current_head_revision_id, current_sequence FROM server_state WHERE singleton = 1 AND vault_id = ?", [vaultId],
    );
    if (!row) throw new RevisionRepositoryError("INVARIANT", "Initialized vault state disappeared");
    return { revisionId: row.current_head_revision_id, sequence: row.current_sequence };
  }

  revision(vaultId: VaultId, revisionId: RevisionId): StoredRevision | null {
    requireVaultReader(this.database, vaultId);
    const row = this.database.get<RevisionRow>("SELECT * FROM revisions WHERE vault_id = ? AND revision_id = ?", [vaultId, revisionId]);
    if (!row) return null;
    const envelope = parsePersistedEnvelope(row.canonical_envelope_json, revisionId);
    if (!rowMatchesEnvelope(row, envelope)) throw new RevisionRepositoryError("INVARIANT", "Persisted revision metadata is inconsistent");
    const parents = this.database.all<RevisionParentRow>("SELECT * FROM revision_parents WHERE vault_id = ? AND revision_id = ? ORDER BY position", [vaultId, revisionId]);
    const objects = this.database.all<RevisionObjectRow>("SELECT * FROM revision_objects WHERE vault_id = ? AND revision_id = ? ORDER BY object_id", [vaultId, revisionId]);
    if (!childrenMatch(parents, objects, envelope)) throw new RevisionRepositoryError("INVARIANT", "Persisted revision metadata is inconsistent");
    return { envelope, sequence: row.accepted_sequence };
  }

  parentIdsExist(vaultId: VaultId, ids: readonly RevisionId[]): boolean {
    requireVaultReader(this.database, vaultId);
    const placeholders = ids.map(() => "?").join(",");
    const count = this.database.get<{ count: number }>(
      `SELECT count(*) AS count FROM revisions WHERE vault_id = ? AND revision_id IN (${placeholders})`, [vaultId, ...ids],
    )?.count ?? 0;
    return count === ids.length;
  }

  missingCatalogReferences(vaultId: VaultId, envelope: RevisionEnvelope): ObjectId[] {
    requireVaultReader(this.database, vaultId);
    const missing: ObjectId[] = [];
    for (let offset = 0; offset < envelope.references.length; offset += QUERY_CHUNK) {
      const references = envelope.references.slice(offset, offset + QUERY_CHUNK);
      const placeholders = references.map(() => "?").join(",");
      const rows = this.database.all<ObjectCatalogRow>(
        `SELECT * FROM object_catalog WHERE vault_id = ? AND object_id IN (${placeholders})`, [vaultId, ...references.map((item) => item.objectId)],
      );
      const byId = new Map(rows.map((row) => [row.object_id, row]));
      for (const reference of references) if (!catalogMatches(byId.get(reference.objectId), reference)) missing.push(reference.objectId);
    }
    return [...new Set(missing)].sort();
  }

  idempotency(identity: RevisionIdentity): AdvanceHeadResult | null {
    requireVaultReader(this.database, identity.vaultId);
    const row = this.database.get<{ request_digest: string; result_json: string }>(
      "SELECT request_digest, result_json FROM idempotency_records WHERE principal_id = ? AND device_id = ? AND operation = ? AND idempotency_key = ?",
      [identity.principalId, identity.deviceId, OPERATION, identity.idempotencyKey],
    );
    if (!row) return null;
    if (row.request_digest !== identity.requestDigest) throw new RevisionRepositoryError("IDEMPOTENCY_KEY_REUSE", "Idempotency key was used for another request");
    const result = parsePersistedResult(row.result_json);
    return result.status === "accepted" ? { ...result, status: "alreadyAccepted" } : result;
  }

  advance(input: AdvanceRevisionInput): AdvanceHeadResult {
    return this.database.writeTransaction((tx) => {
      requireVault(tx, input.identity.vaultId);
      const replay = readIdempotency(tx, input.identity);
      if (replay) return replay.status === "accepted" ? { ...replay, status: "alreadyAccepted" } : replay;

      const missing = missingCatalogInTransaction(tx, input.identity.vaultId, input.envelope);
      if (missing.length) return { status: "missingObjects", objectIds: missing };
      if (!parentsExist(tx, input.identity.vaultId, input.envelope.parents)) return { status: "invalidRevision", reasonCode: "PARENT_NOT_FOUND" };

      const existing = tx.get<RevisionRow>("SELECT * FROM revisions WHERE vault_id = ? AND revision_id = ?", [input.identity.vaultId, input.envelope.revisionId]);
      if (existing) {
        if (!samePersistedRevision(tx, existing, input)) return { status: "invalidRevision", reasonCode: "REVISION_ID_CONFLICT" };
      } else {
        insertRevision(tx, input);
      }

      const state = tx.get<{ current_head_revision_id: RevisionId | null; current_sequence: number }>(
        "SELECT current_head_revision_id, current_sequence FROM server_state WHERE singleton = 1 AND vault_id = ?", [input.identity.vaultId],
      );
      if (!state) throw new RevisionRepositoryError("INVARIANT", "Initialized vault state disappeared");
      let result: AdvanceHeadResult;
      if (state.current_head_revision_id !== input.expectedRevisionId) {
        result = { status: "staleHead", currentRevisionId: state.current_head_revision_id };
      } else {
        if (existing?.accepted_sequence !== null && existing?.accepted_sequence !== undefined) {
          result = { status: "invalidRevision", reasonCode: "REVISION_ALREADY_ACCEPTED" };
          return result;
        }
        const sequence = state.current_sequence + 1;
        if (!Number.isSafeInteger(sequence)) throw new RevisionRepositoryError("INVARIANT", "Server sequence exhausted");
        tx.run("UPDATE revisions SET accepted_sequence = ? WHERE vault_id = ? AND revision_id = ?", [sequence, input.identity.vaultId, input.envelope.revisionId]);
        tx.run("UPDATE server_state SET current_head_revision_id = ?, current_sequence = ? WHERE singleton = 1 AND vault_id = ?", [input.envelope.revisionId, sequence, input.identity.vaultId]);
        result = { status: "accepted", revisionId: input.envelope.revisionId, sequence };
      }
      persistResult(tx, input.identity, result, input.nowMs);
      return result;
    });
  }
}

function requireVaultReader(db: ServerMetadataDatabase, vaultId: VaultId): void {
  const state = db.get<{ vault_id: string }>("SELECT vault_id FROM server_state WHERE singleton = 1");
  if (!state) throw new RevisionRepositoryError("SERVER_UNINITIALIZED", "Server vault is not initialized");
  if (state.vault_id !== vaultId) throw new RevisionRepositoryError("VAULT_CONFLICT", "Authenticated vault does not match server vault");
}
function requireVault(tx: MetadataTransaction, vaultId: VaultId): void {
  const state = tx.get<{ vault_id: string }>("SELECT vault_id FROM server_state WHERE singleton = 1");
  if (!state) throw new RevisionRepositoryError("SERVER_UNINITIALIZED", "Server vault is not initialized");
  if (state.vault_id !== vaultId) throw new RevisionRepositoryError("VAULT_CONFLICT", "Authenticated vault does not match server vault");
}
function catalogMatches(row: ObjectCatalogRow | undefined, reference: RevisionEnvelope["references"][number]): boolean {
  return !!row && row.object_type === reference.objectType && row.ciphertext_checksum === reference.ciphertextChecksum
    && row.ciphertext_length === reference.ciphertextLength && row.object_format_version === reference.objectFormatVersion
    && row.integrity_status !== "missing" && row.integrity_status !== "corrupt";
}
function missingCatalogInTransaction(tx: MetadataTransaction, vaultId: VaultId, envelope: RevisionEnvelope): ObjectId[] {
  const missing: ObjectId[] = [];
  for (let offset = 0; offset < envelope.references.length; offset += QUERY_CHUNK) {
    const refs = envelope.references.slice(offset, offset + QUERY_CHUNK), placeholders = refs.map(() => "?").join(",");
    const rows = tx.all<ObjectCatalogRow>(`SELECT * FROM object_catalog WHERE vault_id = ? AND object_id IN (${placeholders})`, [vaultId, ...refs.map((r) => r.objectId)]);
    const map = new Map(rows.map((row) => [row.object_id, row]));
    for (const ref of refs) if (!catalogMatches(map.get(ref.objectId), ref)) missing.push(ref.objectId);
  }
  return [...new Set(missing)].sort();
}
function parentsExist(tx: MetadataTransaction, vaultId: VaultId, parents: readonly RevisionId[]): boolean {
  const placeholders = parents.map(() => "?").join(",");
  return (tx.get<{ count: number }>(`SELECT count(*) AS count FROM revisions WHERE vault_id = ? AND revision_id IN (${placeholders})`, [vaultId, ...parents])?.count ?? 0) === parents.length;
}
function insertRevision(tx: MetadataTransaction, input: AdvanceRevisionInput): void {
  const e = input.envelope;
  tx.run(`INSERT INTO revisions (vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, server_created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [e.vaultId, e.revisionId, e.creatingDeviceId, e.createdAt, e.encryptedManifestObjectId, e.protocolVersion, e.revisionFormatVersion, e.referenceSetMac, input.canonicalEnvelopeJson, input.identity.requestDigest, input.nowMs]);
  e.parents.forEach((parent, position) => tx.run("INSERT INTO revision_parents(vault_id, revision_id, position, parent_revision_id) VALUES (?, ?, ?, ?)", [e.vaultId, e.revisionId, position, parent]));
  for (const ref of e.references) tx.run(`INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version) VALUES (?, ?, ?, ?, ?, ?, ?)`, [e.vaultId, e.revisionId, ref.objectId, ref.objectType, ref.ciphertextChecksum, ref.ciphertextLength, ref.objectFormatVersion]);
}
function samePersistedRevision(tx: MetadataTransaction, row: RevisionRow, input: AdvanceRevisionInput): boolean {
  if (row.canonical_envelope_json !== input.canonicalEnvelopeJson) return false;
  const parents = tx.all<RevisionParentRow>("SELECT * FROM revision_parents WHERE vault_id = ? AND revision_id = ? ORDER BY position", [row.vault_id, row.revision_id]);
  const objects = tx.all<RevisionObjectRow>("SELECT * FROM revision_objects WHERE vault_id = ? AND revision_id = ? ORDER BY object_id", [row.vault_id, row.revision_id]);
  return rowMatchesEnvelope(row, input.envelope) && childrenMatch(parents, objects, input.envelope);
}
function rowMatchesEnvelope(row: RevisionRow, envelope: RevisionEnvelope): boolean {
  return row.vault_id === envelope.vaultId && row.revision_id === envelope.revisionId && row.creating_device_id === envelope.creatingDeviceId
    && row.client_created_at === envelope.createdAt && row.manifest_object_id === envelope.encryptedManifestObjectId
    && row.protocol_version === envelope.protocolVersion && row.revision_format_version === envelope.revisionFormatVersion
    && row.reference_set_mac === envelope.referenceSetMac;
}
function childrenMatch(parents: RevisionParentRow[], objects: RevisionObjectRow[], envelope: RevisionEnvelope): boolean {
  return parents.length === envelope.parents.length && parents.every((item, i) => item.position === i && item.parent_revision_id === envelope.parents[i])
    && objects.length === envelope.references.length && objects.every((item, i) => {
      const ref = envelope.references[i]!;
      return item.object_id === ref.objectId && item.object_type === ref.objectType && item.ciphertext_checksum === ref.ciphertextChecksum && item.ciphertext_length === ref.ciphertextLength && item.object_format_version === ref.objectFormatVersion;
    });
}
function readIdempotency(tx: MetadataTransaction, identity: RevisionIdentity): AdvanceHeadResult | null {
  const row = tx.get<{ request_digest: string; result_json: string }>("SELECT request_digest, result_json FROM idempotency_records WHERE principal_id = ? AND device_id = ? AND operation = ? AND idempotency_key = ?", [identity.principalId, identity.deviceId, OPERATION, identity.idempotencyKey]);
  if (!row) return null;
  if (row.request_digest !== identity.requestDigest) throw new RevisionRepositoryError("IDEMPOTENCY_KEY_REUSE", "Idempotency key was used for another request");
  return parsePersistedResult(row.result_json);
}
function persistResult(tx: MetadataTransaction, identity: RevisionIdentity, result: AdvanceHeadResult, nowMs: number): void {
  tx.run(`INSERT INTO idempotency_records(principal_id, device_id, operation, idempotency_key, request_digest, outcome, result_json, created_at_ms, expires_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [identity.principalId, identity.deviceId, OPERATION, identity.idempotencyKey, identity.requestDigest, result.status, JSON.stringify(result), nowMs, Math.min(MAX_SQLITE_TIMESTAMP_MS, nowMs + RETENTION_MS)]);
}
function parsePersistedResult(source: string): AdvanceHeadResult {
  try { const value = JSON.parse(source); if (JSON.stringify(value) !== source) throw new Error(); return parseAdvanceHeadResult(value); }
  catch { throw new RevisionRepositoryError("INVARIANT", "Persisted idempotency result is invalid"); }
}
function parsePersistedEnvelope(source: string, revisionId: RevisionId): RevisionEnvelope {
  try { const value = JSON.parse(source); const parsed = parsePersistedRevisionEnvelope(value); if (parsed.revisionId !== revisionId || canonicalizePersistedRevisionEnvelope(parsed) !== source) throw new Error(); return parsed; }
  catch { throw new RevisionRepositoryError("INVARIANT", "Persisted revision envelope is invalid"); }
}
