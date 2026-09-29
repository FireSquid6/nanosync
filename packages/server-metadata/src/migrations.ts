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

const V2_SQL = `
CREATE TABLE accounts (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  principal_id TEXT NOT NULL UNIQUE CHECK(${uuid("principal_id")}),
  password_algorithm TEXT NOT NULL CHECK(password_algorithm = 'argon2id'),
  password_version INTEGER NOT NULL CHECK(password_version = 19),
  password_memory_kib INTEGER NOT NULL CHECK(password_memory_kib BETWEEN 1 AND 1048576),
  password_iterations INTEGER NOT NULL CHECK(password_iterations BETWEEN 1 AND 10),
  password_parallelism INTEGER NOT NULL CHECK(password_parallelism BETWEEN 1 AND 8),
  password_salt BLOB NOT NULL CHECK(typeof(password_salt) = 'blob' AND length(password_salt) BETWEEN 16 AND 64),
  password_hash BLOB NOT NULL CHECK(typeof(password_hash) = 'blob' AND length(password_hash) BETWEEN 32 AND 64),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  password_updated_at_ms INTEGER NOT NULL CHECK(${timestamp("password_updated_at_ms")} AND password_updated_at_ms >= created_at_ms)
) STRICT;

CREATE TABLE initial_devices (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  device_id TEXT NOT NULL UNIQUE CHECK(${uuid("device_id")}),
  principal_id TEXT NOT NULL UNIQUE,
  vault_id TEXT NOT NULL UNIQUE CHECK(${uuid("vault_id")}),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  FOREIGN KEY (principal_id) REFERENCES accounts(principal_id),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id)
) STRICT;

CREATE TABLE recovery_wraps (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  vault_id TEXT NOT NULL UNIQUE CHECK(${uuid("vault_id")}),
  wrap_version INTEGER NOT NULL CHECK(wrap_version = 1),
  algorithm TEXT NOT NULL CHECK(algorithm = 'A256GCM'),
  nonce BLOB NOT NULL CHECK(typeof(nonce) = 'blob' AND length(nonce) = 12),
  ciphertext BLOB NOT NULL CHECK(typeof(ciphertext) = 'blob' AND length(ciphertext) = 48),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id)
) STRICT;

CREATE TABLE bootstrap_state (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  vault_id TEXT NOT NULL UNIQUE CHECK(${uuid("vault_id")}),
  principal_id TEXT NOT NULL UNIQUE,
  initial_device_id TEXT NOT NULL UNIQUE,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('initialized', 'sealed')),
  initialized_at_ms INTEGER NOT NULL CHECK(${timestamp("initialized_at_ms")}),
  sealed_at_ms INTEGER CHECK(sealed_at_ms IS NULL OR (${timestamp("sealed_at_ms")})),
  CHECK((lifecycle = 'initialized' AND sealed_at_ms IS NULL) OR (lifecycle = 'sealed' AND sealed_at_ms IS NOT NULL)),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id),
  FOREIGN KEY (principal_id) REFERENCES accounts(principal_id),
  FOREIGN KEY (initial_device_id) REFERENCES initial_devices(device_id)
) STRICT;

CREATE TRIGGER account_identity_immutable BEFORE UPDATE OF singleton, principal_id, created_at_ms ON accounts
BEGIN SELECT RAISE(ABORT, 'account identity is immutable'); END;
CREATE TRIGGER account_verifier_transition BEFORE UPDATE OF password_algorithm, password_version, password_memory_kib,
  password_iterations, password_parallelism, password_salt, password_hash, password_updated_at_ms ON accounts
WHEN NEW.password_updated_at_ms <= OLD.password_updated_at_ms
  OR NEW.password_salt = OLD.password_salt
BEGIN SELECT RAISE(ABORT, 'password verifier replacement is invalid'); END;
CREATE TRIGGER recovery_wrap_immutable BEFORE UPDATE ON recovery_wraps
BEGIN SELECT RAISE(ABORT, 'recovery wrap is immutable'); END;
CREATE TRIGGER initial_device_immutable BEFORE UPDATE ON initial_devices
BEGIN SELECT RAISE(ABORT, 'initial device is immutable'); END;
CREATE TRIGGER bootstrap_identity_immutable
BEFORE UPDATE OF vault_id, principal_id, initial_device_id, initialized_at_ms ON bootstrap_state
BEGIN SELECT RAISE(ABORT, 'bootstrap identity is immutable'); END;
CREATE TRIGGER bootstrap_seal_once BEFORE UPDATE OF lifecycle, sealed_at_ms ON bootstrap_state
WHEN NOT (OLD.lifecycle = 'initialized' AND NEW.lifecycle = 'sealed' AND OLD.sealed_at_ms IS NULL AND NEW.sealed_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'bootstrap transition is invalid'); END;
`;

const V3_SQL = `
CREATE TABLE devices (
  device_id TEXT PRIMARY KEY CHECK(${uuid("device_id")}),
  principal_id TEXT NOT NULL,
  vault_id TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('pending', 'active', 'revoked')),
  role TEXT NOT NULL CHECK(role IN ('administrator', 'member')),
  credential_digest BLOB UNIQUE CHECK(credential_digest IS NULL OR (typeof(credential_digest) = 'blob' AND length(credential_digest) = 32)),
  display_name TEXT CHECK(display_name IS NULL OR (length(CAST(display_name AS BLOB)) BETWEEN 1 AND 128 AND display_name NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*')),
  platform TEXT CHECK(platform IS NULL OR (length(CAST(platform AS BLOB)) BETWEEN 1 AND 32 AND platform NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*')),
  client_version TEXT CHECK(client_version IS NULL OR (length(CAST(client_version AS BLOB)) BETWEEN 1 AND 64 AND client_version NOT GLOB '*[' || char(0) || '-' || char(31) || char(127) || ']*')),
  fingerprint BLOB CHECK(fingerprint IS NULL OR (typeof(fingerprint) = 'blob' AND length(fingerprint) = 32)),
  is_initial INTEGER NOT NULL DEFAULT 0 CHECK(is_initial IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  approved_at_ms INTEGER CHECK(approved_at_ms IS NULL OR (${timestamp("approved_at_ms")})),
  revoked_at_ms INTEGER CHECK(revoked_at_ms IS NULL OR (${timestamp("revoked_at_ms")})),
  CHECK((state = 'pending' AND credential_digest IS NULL AND approved_at_ms IS NULL AND revoked_at_ms IS NULL)
     OR (state = 'active' AND credential_digest IS NOT NULL AND approved_at_ms IS NOT NULL AND revoked_at_ms IS NULL)
     OR (state = 'revoked' AND credential_digest IS NULL AND approved_at_ms IS NOT NULL AND revoked_at_ms IS NOT NULL)),
  CHECK(is_initial = 0 OR role = 'administrator'),
  FOREIGN KEY (principal_id) REFERENCES accounts(principal_id),
  FOREIGN KEY (vault_id) REFERENCES server_state(vault_id)
) STRICT;
CREATE UNIQUE INDEX one_initial_device ON devices(is_initial) WHERE is_initial = 1;

CREATE TABLE password_sessions (
  token_digest BLOB PRIMARY KEY CHECK(typeof(token_digest) = 'blob' AND length(token_digest) = 32),
  principal_id TEXT NOT NULL,
  device_id TEXT,
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  expires_at_ms INTEGER NOT NULL CHECK(${timestamp("expires_at_ms")} AND expires_at_ms > created_at_ms),
  FOREIGN KEY (principal_id) REFERENCES accounts(principal_id),
  FOREIGN KEY (device_id) REFERENCES devices(device_id)
) STRICT;
CREATE INDEX password_sessions_expiry ON password_sessions(expires_at_ms);
CREATE TRIGGER password_session_digest_immutable BEFORE UPDATE OF token_digest, principal_id, created_at_ms ON password_sessions
BEGIN SELECT RAISE(ABORT, 'password session identity is immutable'); END;

CREATE TABLE enrollment_requests (
  token_digest BLOB PRIMARY KEY CHECK(typeof(token_digest) = 'blob' AND length(token_digest) = 32),
  device_id TEXT NOT NULL UNIQUE CHECK(${uuid("device_id")}),
  display_name TEXT NOT NULL CHECK(length(CAST(display_name AS BLOB)) BETWEEN 1 AND 128),
  platform TEXT NOT NULL CHECK(length(CAST(platform AS BLOB)) BETWEEN 1 AND 32),
  client_version TEXT NOT NULL CHECK(length(CAST(client_version AS BLOB)) BETWEEN 1 AND 64),
  fingerprint BLOB NOT NULL CHECK(typeof(fingerprint) = 'blob' AND length(fingerprint) = 32),
  state TEXT NOT NULL CHECK(state IN ('pending', 'approved', 'denied')),
  created_at_ms INTEGER NOT NULL CHECK(${timestamp("created_at_ms")}),
  expires_at_ms INTEGER NOT NULL CHECK(${timestamp("expires_at_ms")} AND expires_at_ms > created_at_ms),
  decided_at_ms INTEGER CHECK(decided_at_ms IS NULL OR (${timestamp("decided_at_ms")})),
  CHECK((state = 'pending' AND decided_at_ms IS NULL) OR (state <> 'pending' AND decided_at_ms IS NOT NULL)),
  FOREIGN KEY (token_digest) REFERENCES password_sessions(token_digest) ON DELETE CASCADE
) STRICT;
CREATE INDEX enrollment_requests_state_created ON enrollment_requests(state, created_at_ms);

CREATE TABLE authentication_rate_limit (
  singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
  window_started_at_ms INTEGER NOT NULL CHECK(${timestamp("window_started_at_ms")}),
  failed_attempts INTEGER NOT NULL CHECK(failed_attempts BETWEEN 0 AND 5),
  locked_until_ms INTEGER NOT NULL CHECK(${timestamp("locked_until_ms")})
) STRICT;

CREATE TABLE audit_events (
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,
  event_type TEXT NOT NULL CHECK(length(event_type) BETWEEN 1 AND 64 AND event_type NOT GLOB '*[^a-z0-9._-]*'),
  actor_device_id TEXT CHECK(actor_device_id IS NULL OR (${uuid("actor_device_id")})),
  subject_device_id TEXT CHECK(subject_device_id IS NULL OR (${uuid("subject_device_id")})),
  occurred_at_ms INTEGER NOT NULL CHECK(${timestamp("occurred_at_ms")}),
  details_json TEXT NOT NULL CHECK(length(CAST(details_json AS BLOB)) BETWEEN 2 AND 512 AND json_valid(details_json))
) STRICT;
CREATE INDEX audit_events_time ON audit_events(occurred_at_ms);
CREATE TRIGGER audit_event_immutable BEFORE UPDATE ON audit_events
BEGIN SELECT RAISE(ABORT, 'audit event is immutable'); END;

CREATE TRIGGER device_identity_immutable BEFORE UPDATE OF device_id, principal_id, vault_id, is_initial, created_at_ms ON devices
BEGIN SELECT RAISE(ABORT, 'device identity is immutable'); END;
CREATE TRIGGER device_transition_valid BEFORE UPDATE ON devices
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state = 'active' AND OLD.credential_digest IS NULL AND NEW.credential_digest IS NOT NULL)
  OR (OLD.state = 'active' AND NEW.state = 'revoked' AND NEW.credential_digest IS NULL)
  OR (OLD.state = 'revoked' AND OLD.role = 'member' AND OLD.is_initial = 0 AND NEW.state = 'active' AND OLD.credential_digest IS NULL AND NEW.credential_digest IS NOT NULL)
) OR NEW.role <> OLD.role
BEGIN SELECT RAISE(ABORT, 'device transition is invalid'); END;
CREATE TRIGGER device_last_admin BEFORE UPDATE OF state ON devices
WHEN OLD.state = 'active' AND OLD.role = 'administrator' AND NEW.state = 'revoked'
  AND NOT EXISTS (SELECT 1 FROM devices d WHERE d.device_id <> OLD.device_id AND d.state = 'active' AND d.role = 'administrator')
BEGIN SELECT RAISE(ABORT, 'last active administrator cannot be revoked'); END;
CREATE TRIGGER enrollment_identity_immutable BEFORE UPDATE OF token_digest, device_id, display_name, platform, client_version, fingerprint, created_at_ms, expires_at_ms ON enrollment_requests
BEGIN SELECT RAISE(ABORT, 'enrollment identity is immutable'); END;
CREATE TRIGGER enrollment_transition_valid BEFORE UPDATE OF state, decided_at_ms ON enrollment_requests
WHEN NOT (OLD.state = 'pending' AND NEW.state IN ('approved', 'denied') AND NEW.decided_at_ms IS NOT NULL)
BEGIN SELECT RAISE(ABORT, 'enrollment transition is invalid'); END;

INSERT INTO devices(device_id, principal_id, vault_id, state, role, credential_digest, is_initial, created_at_ms)
SELECT device_id, principal_id, vault_id, 'pending', 'administrator', NULL, 1, created_at_ms FROM initial_devices;
`;

export function migrationChecksum(version: number, name: string, sql: string): string {
  return createHash("sha256").update(`${version}\0${name}\0${sql}`, "utf8").digest("hex");
}

function migration(version: number, name: string, sql: string): MetadataMigration {
  return Object.freeze({ version, name, sql, checksum: migrationChecksum(version, name, sql) });
}

export const METADATA_MIGRATIONS: readonly MetadataMigration[] = Object.freeze([
  migration(1, "initial_metadata_schema", V1_SQL),
  migration(2, "account_and_bootstrap", V2_SQL),
  migration(3, "device_authentication", V3_SQL),
]);
