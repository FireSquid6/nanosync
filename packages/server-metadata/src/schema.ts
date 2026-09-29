import type {
  CiphertextChecksum,
  DeviceId,
  ObjectId,
  ObjectType,
  ReferenceSetMac,
  RevisionId,
  VaultId,
} from "@nanosync/protocol";

export const METADATA_SCHEMA_VERSION = 1 as const;
export const MAX_SQLITE_TIMESTAMP_MS = 9_007_199_254_740_991;

export type IntegrityStatus = "unchecked" | "verified" | "corrupt" | "missing";
export type UploadState = "active" | "completed" | "aborted";

export interface ServerStateRow {
  singleton: 1;
  vault_id: VaultId;
  current_head_revision_id: RevisionId | null;
  current_sequence: number;
}

export interface ObjectCatalogRow {
  vault_id: VaultId;
  object_id: ObjectId;
  object_type: ObjectType;
  ciphertext_checksum: CiphertextChecksum;
  ciphertext_length: number;
  object_format_version: number;
  durable_created_at_ms: number;
  integrity_status: IntegrityStatus;
  integrity_checked_at_ms: number | null;
}

export interface RevisionRow {
  vault_id: VaultId;
  revision_id: RevisionId;
  creating_device_id: DeviceId;
  client_created_at: string;
  manifest_object_id: ObjectId;
  protocol_version: number;
  revision_format_version: number;
  reference_set_mac: ReferenceSetMac;
  canonical_envelope_json: string;
  request_digest: string;
  accepted_sequence: number | null;
  server_created_at_ms: number;
}

export interface RevisionParentRow {
  vault_id: VaultId;
  revision_id: RevisionId;
  position: 0 | 1;
  parent_revision_id: RevisionId;
}

export interface RevisionObjectRow {
  vault_id: VaultId;
  revision_id: RevisionId;
  object_id: ObjectId;
  object_type: ObjectType;
  ciphertext_checksum: CiphertextChecksum;
  ciphertext_length: number;
  object_format_version: number;
}

export interface IdempotencyRecordRow {
  principal_id: string;
  device_id: DeviceId;
  operation: string;
  idempotency_key: string;
  request_digest: string;
  outcome: string;
  result_json: string;
  created_at_ms: number;
  expires_at_ms: number;
}

export interface UploadSessionRow {
  vault_id: VaultId;
  session_id: string;
  principal_id: string;
  device_id: DeviceId;
  object_id: ObjectId;
  object_type: ObjectType;
  state: UploadState;
  created_at_ms: number;
  updated_at_ms: number;
  expires_at_ms: number;
}

export interface MigrationLedgerRow {
  version: number;
  name: string;
  checksum: string;
  applied_at_ms: number;
}
