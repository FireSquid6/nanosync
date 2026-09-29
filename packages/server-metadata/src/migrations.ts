import { createHash } from "node:crypto";
import {
  AES_GCM_TAG_BYTES,
  CHUNK_SIZE,
  MAX_JSON_METADATA_BYTES,
  MAX_OBJECT_CIPHERTEXT_BYTES,
  OBJECT_FRAME_HEADER_BYTES,
  OBJECT_FORMAT_VERSION,
  PROTOCOL_VERSION,
  RANDOMIZED_NONCE_BYTES,
  REVISION_FORMAT_VERSION,
} from "@nanosync/protocol";
import { MAX_SQLITE_TIMESTAMP_MS } from "./schema.ts";

export interface MetadataMigration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
  readonly checksum: string;
}

const UUID_HEX = "[0-9a-f]";
const UUID_GLOB = `${UUID_HEX.repeat(8)}-${UUID_HEX.repeat(4)}-[1-8]${UUID_HEX.repeat(3)}-[89ab]${UUID_HEX.repeat(3)}-${UUID_HEX.repeat(12)}`;
const uuid = (column: string): string => `length(${column}) = 36 AND ${column} GLOB '${UUID_GLOB}'`;
const hex64 = (column: string): string =>
  `length(${column}) = 64 AND ${column} NOT GLOB '*[^0-9a-f]*'`;
const timestamp = (column: string): string =>
  `${column} >= 0 AND ${column} <= ${MAX_SQLITE_TIMESTAMP_MS}`;
const CHUNK_FRAME_MIN = OBJECT_FRAME_HEADER_BYTES + 1 + AES_GCM_TAG_BYTES;
const CHUNK_FRAME_MAX = OBJECT_FRAME_HEADER_BYTES + CHUNK_SIZE + AES_GCM_TAG_BYTES;
const RANDOMIZED_FRAME_MIN = OBJECT_FRAME_HEADER_BYTES + RANDOMIZED_NONCE_BYTES + 1 + AES_GCM_TAG_BYTES;
const frameLength = (type: string, length: string): string => `(
    (${type} = 'chunk' AND ${length} BETWEEN ${CHUNK_FRAME_MIN} AND ${CHUNK_FRAME_MAX})
    OR (${type} IN ('manifest', 'revision-private') AND ${length} BETWEEN ${RANDOMIZED_FRAME_MIN} AND ${MAX_OBJECT_CIPHERTEXT_BYTES})
  )`;

const V1_SQL = `
CREATE TABLE metadata_migrations (
  version INTEGER PRIMARY KEY CHECK(version > 0),
  name TEXT NOT NULL UNIQUE CHECK(length(name) BETWEEN 1 AND 128),
  checksum TEXT NOT NULL CHECK(${hex64("checksum")}),
  applied_at_ms INTEGER NOT NULL CHECK(${timestamp("applied_at_ms")})
) STRICT;

CREATE TABLE object_catalog (
  vault_id TEXT NOT NULL CHECK(${uuid("vault_id")}),
  object_id TEXT NOT NULL CHECK(${hex64("object_id")}),
  object_type TEXT NOT NULL CHECK(object_type IN ('chunk', 'manifest', 'revision-private')),
  ciphertext_checksum TEXT NOT NULL CHECK(${hex64("ciphertext_checksum")}),
  ciphertext_length INTEGER NOT NULL CHECK(${frameLength("object_type", "ciphertext_length")}),
  object_format_version INTEGER NOT NULL CHECK(object_format_version = ${OBJECT_FORMAT_VERSION}),
  durable_created_at_ms INTEGER NOT NULL CHECK(${timestamp("durable_created_at_ms")}),
  integrity_status TEXT NOT NULL DEFAULT 'unchecked' CHECK(integrity_status IN ('unchecked', 'verified', 'corrupt', 'missing')),
  integrity_checked_at_ms INTEGER CHECK(integrity_checked_at_ms IS NULL OR (${timestamp("integrity_checked_at_ms")})),
  PRIMARY KEY (vault_id, object_id),
  UNIQUE (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id)
) STRICT;

CREATE TABLE revisions (
  vault_id TEXT NOT NULL CHECK(${uuid("vault_id")}),
  revision_id TEXT NOT NULL CHECK(${uuid("revision_id")}),
  creating_device_id TEXT NOT NULL CHECK(${uuid("creating_device_id")}),
  client_created_at TEXT NOT NULL CHECK(length(client_created_at) = 24 AND client_created_at GLOB '????-??-??T??:??:??.???Z'),
  manifest_object_id TEXT NOT NULL CHECK(${hex64("manifest_object_id")}),
  protocol_version INTEGER NOT NULL CHECK(protocol_version = ${PROTOCOL_VERSION}),
  revision_format_version INTEGER NOT NULL CHECK(revision_format_version = ${REVISION_FORMAT_VERSION}),
  reference_set_mac TEXT NOT NULL CHECK(${hex64("reference_set_mac")}),
  canonical_envelope_json TEXT NOT NULL CHECK(length(CAST(canonical_envelope_json AS BLOB)) BETWEEN 2 AND ${MAX_JSON_METADATA_BYTES} AND json_valid(canonical_envelope_json)),
  request_digest TEXT NOT NULL CHECK(${hex64("request_digest")}),
  accepted_sequence INTEGER UNIQUE CHECK(accepted_sequence IS NULL OR accepted_sequence > 0),
  server_created_at_ms INTEGER NOT NULL CHECK(${timestamp("server_created_at_ms")}),
  PRIMARY KEY (vault_id, revision_id),
  FOREIGN KEY (vault_id, manifest_object_id) REFERENCES object_catalog(vault_id, object_id)
) STRICT;

CREATE TABLE revision_parents (
  vault_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  position INTEGER NOT NULL CHECK(position IN (0, 1)),
  parent_revision_id TEXT NOT NULL CHECK(parent_revision_id <> revision_id),
  PRIMARY KEY (vault_id, revision_id, position),
  UNIQUE (vault_id, revision_id, parent_revision_id),
  FOREIGN KEY (vault_id, revision_id) REFERENCES revisions(vault_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, parent_revision_id) REFERENCES revisions(vault_id, revision_id)
) STRICT;

CREATE TABLE revision_objects (
  vault_id TEXT NOT NULL,
  revision_id TEXT NOT NULL,
  object_id TEXT NOT NULL,
  object_type TEXT NOT NULL CHECK(object_type IN ('chunk', 'manifest', 'revision-private')),
  ciphertext_checksum TEXT NOT NULL CHECK(${hex64("ciphertext_checksum")}),
  ciphertext_length INTEGER NOT NULL CHECK(${frameLength("object_type", "ciphertext_length")}),
  object_format_version INTEGER NOT NULL CHECK(object_format_version = ${OBJECT_FORMAT_VERSION}),
  PRIMARY KEY (vault_id, revision_id, object_id),
  FOREIGN KEY (vault_id, revision_id) REFERENCES revisions(vault_id, revision_id) ON DELETE CASCADE,
  FOREIGN KEY (vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
    REFERENCES object_catalog(vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version)
) STRICT;

CREATE TABLE server_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  vault_id TEXT NOT NULL UNIQUE CHECK(${uuid("vault_id")}),
  current_head_revision_id TEXT,
  current_sequence INTEGER NOT NULL CHECK(current_sequence >= 0),
  CHECK((current_head_revision_id IS NULL AND current_sequence = 0) OR (current_head_revision_id IS NOT NULL AND current_sequence > 0)),
  FOREIGN KEY (vault_id, current_head_revision_id) REFERENCES revisions(vault_id, revision_id)
) STRICT;

CREATE TABLE idempotency_records (
  principal_id TEXT NOT NULL CHECK(${uuid("principal_id")}),
  device_id TEXT NOT NULL CHECK(${uuid("device_id")}),
  operation TEXT NOT NULL CHECK(length(operation) BETWEEN 1 AND 64 AND operation NOT GLOB '*[^a-zA-Z0-9._-]*'),
  idempotency_key TEXT NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 128 AND idempotency_key NOT GLOB '*[^!-~]*'),
  request_digest TEXT NOT NULL CHECK(${hex64("request_digest")}),
  outcome TEXT NOT NULL CHECK(length(outcome) BETWEEN 1 AND 64),
  result_json TEXT NOT NULL CHECK(length(CAST(result_json AS BLOB)) BETWEEN 2 AND ${MAX_JSON_METADATA_BYTES} AND json_valid(result_json)),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  expires_at_ms INTEGER NOT NULL CHECK(${timestamp("expires_at_ms")} AND expires_at_ms >= created_at_ms),
  PRIMARY KEY (principal_id, device_id, operation, idempotency_key)
) STRICT;

CREATE TABLE upload_sessions (
  vault_id TEXT NOT NULL CHECK(${uuid("vault_id")}),
  session_id TEXT NOT NULL CHECK(${uuid("session_id")}),
  principal_id TEXT NOT NULL CHECK(${uuid("principal_id")}),
  device_id TEXT NOT NULL CHECK(${uuid("device_id")}),
  object_id TEXT NOT NULL CHECK(${hex64("object_id")}),
  object_type TEXT NOT NULL CHECK(object_type IN ('chunk', 'manifest', 'revision-private')),
  state TEXT NOT NULL CHECK(state IN ('active', 'completed', 'aborted')),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  updated_at_ms INTEGER NOT NULL CHECK(${timestamp("updated_at_ms")} AND updated_at_ms >= created_at_ms),
  expires_at_ms INTEGER NOT NULL CHECK(${timestamp("expires_at_ms")} AND expires_at_ms >= created_at_ms),
  PRIMARY KEY (vault_id, session_id),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id)
) STRICT;

CREATE TRIGGER object_catalog_immutable
BEFORE UPDATE OF vault_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version, durable_created_at_ms ON object_catalog
BEGIN SELECT RAISE(ABORT, 'immutable object metadata'); END;

CREATE TRIGGER revision_immutable
BEFORE UPDATE OF vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id,
  protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, server_created_at_ms ON revisions
BEGIN SELECT RAISE(ABORT, 'immutable revision metadata'); END;

CREATE TRIGGER idempotency_record_immutable
BEFORE UPDATE ON idempotency_records
BEGIN SELECT RAISE(ABORT, 'terminal idempotency record is immutable'); END;

CREATE TRIGGER revision_accept_once
BEFORE UPDATE OF accepted_sequence ON revisions
WHEN NOT (OLD.accepted_sequence IS NULL AND NEW.accepted_sequence IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'revision acceptance is immutable'); END;

CREATE TRIGGER revision_accept_complete
BEFORE UPDATE OF accepted_sequence ON revisions
WHEN NEW.accepted_sequence IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM revision_objects ro
    WHERE ro.vault_id = NEW.vault_id AND ro.revision_id = NEW.revision_id
      AND ro.object_id = NEW.manifest_object_id AND ro.object_type = 'manifest'
  ) THEN RAISE(ABORT, 'accepted revision requires its manifest reference') END;
END;

CREATE TRIGGER server_state_valid_head_insert
BEFORE INSERT ON server_state WHEN NEW.current_head_revision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = NEW.vault_id
    AND r.revision_id = NEW.current_head_revision_id AND r.accepted_sequence = NEW.current_sequence)
    THEN RAISE(ABORT, 'head must name the accepted revision at its sequence') END;
END;

CREATE TRIGGER server_state_valid_head_update
BEFORE UPDATE OF vault_id, current_head_revision_id, current_sequence ON server_state WHEN NEW.current_head_revision_id IS NOT NULL
BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM revisions r WHERE r.vault_id = NEW.vault_id
    AND r.revision_id = NEW.current_head_revision_id AND r.accepted_sequence = NEW.current_sequence)
    THEN RAISE(ABORT, 'head must name the accepted revision at its sequence') END;
END;
`;

export function migrationChecksum(version: number, name: string, sql: string): string {
  return createHash("sha256").update(`${version}\0${name}\0${sql}`, "utf8").digest("hex");
}

function migration(version: number, name: string, sql: string): MetadataMigration {
  return Object.freeze({ version, name, sql, checksum: migrationChecksum(version, name, sql) });
}

export const METADATA_MIGRATIONS: readonly MetadataMigration[] = Object.freeze([
  migration(1, "initial_metadata_schema", V1_SQL),
]);
