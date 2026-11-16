import type {
  CiphertextChecksum,
  DeviceId,
  IdempotencyKey,
  ObjectId,
  ObjectType,
  PrincipalId,
  VaultId,
} from "@nanosync/protocol";
import { MAX_SQLITE_TIMESTAMP_MS, type ObjectCatalogRow } from "./schema.ts";
import {
  ServerMetadataDatabase,
  type MetadataTransaction,
} from "./database.ts";

export type ObjectRepositoryErrorCode =
  | "CATALOG_CONFLICT"
  | "IDEMPOTENCY_KEY_REUSE"
  | "VAULT_DELETED"
  | "VAULT_CONFLICT"
  | "SERVER_UNINITIALIZED"
  | "INVARIANT";
export class ObjectRepositoryError extends Error {
  constructor(
    readonly code: ObjectRepositoryErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ObjectRepositoryError";
  }
}

export interface UploadIdentity {
  principalId: PrincipalId;
  deviceId: DeviceId;
  vaultId: VaultId;
  idempotencyKey: IdempotencyKey;
  requestDigest: string;
}
export interface CatalogObject {
  vaultId: VaultId;
  objectId: ObjectId;
  objectType: ObjectType;
  ciphertextChecksum: CiphertextChecksum;
  ciphertextLength: number;
  objectFormatVersion: number;
}
export interface UploadResultRecord {
  protocolVersion: 1;
  status: "stored" | "alreadyPresent";
}

const OPERATION = "put-object-v1";
const operation = (vaultId: VaultId) => `${OPERATION}.${vaultId}`;
const QUERY_CHUNK = 400;

export class ObjectCatalogRepository {
  constructor(private readonly database: ServerMetadataDatabase) {}

  ping(): void {
    this.database.get("SELECT 1 AS ok");
  }
  legacyVault(vaultId: VaultId): boolean {
    return !!this.database.get("SELECT 1 FROM server_state WHERE vault_id=? AND singleton=1", [vaultId]);
  }

  requireVault(vaultId: VaultId): void {
    if (this.database.get("SELECT 1 FROM vault_deletions WHERE vault_id=?", [vaultId])) throw new ObjectRepositoryError("VAULT_DELETED", "Vault is permanently deleted");
    const state = this.database.get<{ vault_id: string }>(
      "SELECT vault_id FROM server_state WHERE vault_id = ?",
      [vaultId],
    );
    if (!state && !this.database.get("SELECT 1 FROM server_state LIMIT 1"))
      throw new ObjectRepositoryError(
        "SERVER_UNINITIALIZED",
        "Server vault is not initialized",
      );
    if (state?.vault_id !== vaultId)
      throw new ObjectRepositoryError(
        "VAULT_CONFLICT",
        "Authenticated vault does not match server vault",
      );
  }

  get(vaultId: VaultId, objectId: ObjectId): ObjectCatalogRow | null {
    return this.database.get<ObjectCatalogRow>(
      "SELECT * FROM object_catalog WHERE vault_id = ? AND object_id = ?",
      [vaultId, objectId],
    );
  }

  find(
    vaultId: VaultId,
    objectType: ObjectType,
    objectIds: readonly ObjectId[],
  ): Map<string, ObjectCatalogRow> {
    const output = new Map<string, ObjectCatalogRow>();
    for (let offset = 0; offset < objectIds.length; offset += QUERY_CHUNK) {
      const ids = objectIds.slice(offset, offset + QUERY_CHUNK);
      const placeholders = ids.map(() => "?").join(",");
      for (const row of this.database.all<ObjectCatalogRow>(
        `SELECT * FROM object_catalog WHERE vault_id = ? AND object_type = ? AND object_id IN (${placeholders})`,
        [vaultId, objectType, ...ids],
      ))
        output.set(row.object_id, row);
    }
    return output;
  }

  markMissing(
    vaultId: VaultId,
    objectIds: readonly ObjectId[],
    checkedAtMs: number,
  ): void {
    if (objectIds.length === 0) return;
    this.database.writeTransaction((tx) => {
      for (const id of objectIds)
        tx.run(
          "UPDATE object_catalog SET integrity_status = 'missing', integrity_checked_at_ms = ? WHERE vault_id = ? AND object_id = ?",
          [checkedAtMs, vaultId, id],
        );
    });
  }

  markIntegrity(
    vaultId: VaultId,
    objectId: ObjectId,
    status: "missing" | "corrupt",
    checkedAtMs: number,
  ): void {
    this.database.writeTransaction((tx) =>
      tx.run(
        "UPDATE object_catalog SET integrity_status = ?, integrity_checked_at_ms = ? WHERE vault_id = ? AND object_id = ?",
        [status, checkedAtMs, vaultId, objectId],
      ),
    );
  }

  idempotency(identity: UploadIdentity): UploadResultRecord | null {
    const row = this.database.get<{
      request_digest: string;
      result_json: string;
    }>(
      "SELECT request_digest, result_json FROM idempotency_records WHERE principal_id = ? AND device_id = ? AND operation = ? AND idempotency_key = ?",
      [
        identity.principalId,
        identity.deviceId,
         this.legacyVault(identity.vaultId) ? OPERATION : operation(identity.vaultId),
        identity.idempotencyKey,
      ],
    );
    if (!row) return null;
    if (row.request_digest !== identity.requestDigest)
      throw new ObjectRepositoryError(
        "IDEMPOTENCY_KEY_REUSE",
        "Idempotency key was used for another request",
      );
    return parseUploadResult(row.result_json);
  }

  commitUpload(
    identity: UploadIdentity,
    object: CatalogObject,
    result: UploadResultRecord,
    nowMs: number,
  ): UploadResultRecord {
    return this.database.writeTransaction((tx) => {
      requireVault(tx, identity.vaultId);
      const replay = tx.get<{ request_digest: string; result_json: string }>(
        "SELECT request_digest, result_json FROM idempotency_records WHERE principal_id = ? AND device_id = ? AND operation = ? AND idempotency_key = ?",
        [
          identity.principalId,
          identity.deviceId,
           tx.get("SELECT 1 FROM server_state WHERE singleton=1 AND vault_id=?", [identity.vaultId]) ? OPERATION : operation(identity.vaultId),
          identity.idempotencyKey,
        ],
      );
      if (replay) {
        if (replay.request_digest !== identity.requestDigest)
          throw new ObjectRepositoryError(
            "IDEMPOTENCY_KEY_REUSE",
            "Idempotency key was used for another request",
          );
        return parseUploadResult(replay.result_json);
      }
      const existing = tx.get<ObjectCatalogRow>(
        "SELECT * FROM object_catalog WHERE vault_id = ? AND object_id = ?",
        [object.vaultId, object.objectId],
      );
      if (existing && !sameObject(existing, object))
        throw new ObjectRepositoryError(
          "CATALOG_CONFLICT",
          "Object identity has conflicting metadata",
        );
      if (!existing)
        tx.run(
          `INSERT INTO object_catalog
         (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
          [
            object.vaultId,
            object.objectId,
            object.objectType,
            object.ciphertextChecksum,
            object.ciphertextLength,
            object.objectFormatVersion,
            nowMs,
          ],
        );
      else if (
        existing.integrity_status !== "unchecked" ||
        existing.integrity_checked_at_ms !== null
      ) {
        // Reaching this transaction means storage accepted or checksum-verified the exact immutable object.
        tx.run(
          "UPDATE object_catalog SET integrity_status = 'unchecked', integrity_checked_at_ms = NULL WHERE vault_id = ? AND object_id = ?",
          [object.vaultId, object.objectId],
        );
      }
      const resultJson = JSON.stringify(result);
      tx.run(
        `INSERT INTO idempotency_records
         (principal_id, device_id, operation, idempotency_key, request_digest, outcome, result_json, created_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, 'success', ?, ?, ?)`,
        [
          identity.principalId,
          identity.deviceId,
           tx.get("SELECT 1 FROM server_state WHERE singleton=1 AND vault_id=?", [identity.vaultId]) ? OPERATION : operation(identity.vaultId),
          identity.idempotencyKey,
          identity.requestDigest,
          resultJson,
          nowMs,
          Math.min(MAX_SQLITE_TIMESTAMP_MS, nowMs + 7 * 24 * 60 * 60 * 1000),
        ],
      );
      return result;
    });
  }
}

function requireVault(tx: MetadataTransaction, vaultId: VaultId): void {
  if (tx.get("SELECT 1 FROM vault_deletions WHERE vault_id=?", [vaultId])) throw new ObjectRepositoryError("VAULT_DELETED", "Vault is permanently deleted");
  const state = tx.get<{ vault_id: string }>(
    "SELECT vault_id FROM server_state WHERE vault_id = ?",
    [vaultId],
  );
  if (!state && !tx.get("SELECT 1 FROM server_state LIMIT 1"))
    throw new ObjectRepositoryError(
      "SERVER_UNINITIALIZED",
      "Server vault is not initialized",
    );
  if (state?.vault_id !== vaultId)
    throw new ObjectRepositoryError(
      "VAULT_CONFLICT",
      "Authenticated vault does not match server vault",
    );
}
function sameObject(row: ObjectCatalogRow, object: CatalogObject): boolean {
  return (
    row.object_type === object.objectType &&
    row.ciphertext_checksum === object.ciphertextChecksum &&
    row.ciphertext_length === object.ciphertextLength &&
    row.object_format_version === object.objectFormatVersion
  );
}

function parseUploadResult(source: string): UploadResultRecord {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    throw new ObjectRepositoryError(
      "INVARIANT",
      "Persisted idempotency result is invalid",
    );
  }
  if (JSON.stringify(value) !== source)
    throw new ObjectRepositoryError(
      "INVARIANT",
      "Persisted idempotency result is invalid",
    );
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  ) {
    throw new ObjectRepositoryError(
      "INVARIANT",
      "Persisted idempotency result is invalid",
    );
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.length !== 2 ||
    !Object.hasOwn(record, "protocolVersion") ||
    !Object.hasOwn(record, "status") ||
    record.protocolVersion !== 1 ||
    (record.status !== "stored" && record.status !== "alreadyPresent")
  ) {
    throw new ObjectRepositoryError(
      "INVARIANT",
      "Persisted idempotency result is invalid",
    );
  }
  return { protocolVersion: 1, status: record.status };
}
