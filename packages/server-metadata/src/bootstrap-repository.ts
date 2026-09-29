import {
  canonicalizePersistedRevisionEnvelope,
  decodeCanonicalBase64Url,
  type BootstrapInitializeRequest, type ObjectId, type RevisionEnvelope, type VaultId,
} from "@nanosync/protocol";
import { ServerMetadataDatabase, type MetadataTransaction } from "./database.ts";
import type { BootstrapStateRow, ObjectCatalogRow } from "./schema.ts";

export interface PasswordVerifierRecord {
  algorithm: "argon2id";
  version: 19;
  memoryKiB: number;
  iterations: number;
  parallelism: number;
  salt: Uint8Array;
  hash: Uint8Array;
}
export type BootstrapStatus = "uninitialized" | "initializedWithoutHead" | "sealed";
export class BootstrapRepositoryError extends Error {
  constructor(readonly code: "CONFLICT" | "INVARIANT", message: string) { super(message); this.name = "BootstrapRepositoryError"; }
}

export class BootstrapRepository {
  constructor(private readonly database: ServerMetadataDatabase) {}

  status(): BootstrapStatus {
    const state = this.validatedState();
    return state?.lifecycle === "sealed" ? "sealed" : state ? "initializedWithoutHead" : "uninitialized";
  }

  state(): BootstrapStateRow | null { return this.validatedState(); }

  missingCatalogReferences(vaultId: VaultId, envelope: RevisionEnvelope): ObjectId[] {
    const state = this.state();
    if (!state || state.lifecycle !== "initialized" || state.vault_id !== vaultId) throw new BootstrapRepositoryError("CONFLICT", "Bootstrap mutation is unavailable");
    const missing: ObjectId[] = [];
    for (let offset = 0; offset < envelope.references.length; offset += 350) {
      const refs = envelope.references.slice(offset, offset + 350), placeholders = refs.map(() => "?").join(",");
      const rows = this.database.all<ObjectCatalogRow>(`SELECT * FROM object_catalog WHERE vault_id = ? AND object_id IN (${placeholders})`, [vaultId, ...refs.map((ref) => ref.objectId)]);
      const map = new Map(rows.map((row) => [row.object_id, row]));
      for (const ref of refs) { const row = map.get(ref.objectId); if (!catalogMatches(row, ref)) missing.push(ref.objectId); }
    }
    return [...new Set(missing)].sort();
  }

  initialize(input: BootstrapInitializeRequest, verifier: PasswordVerifierRecord, nowMs: number): "initialized" {
    validateVerifier(verifier, true);
    return this.database.writeTransaction((tx) => {
      if (tx.get("SELECT singleton FROM bootstrap_state WHERE singleton = 1") || tx.get("SELECT singleton FROM server_state WHERE singleton = 1")) {
        throw new BootstrapRepositoryError("CONFLICT", "Bootstrap is already initialized");
      }
      tx.run("INSERT INTO server_state(singleton, vault_id, current_head_revision_id, current_sequence) VALUES (1, ?, NULL, 0)", [input.vaultId]);
      tx.run(`INSERT INTO accounts(singleton, principal_id, password_algorithm, password_version, password_memory_kib, password_iterations, password_parallelism, password_salt, password_hash, created_at_ms, password_updated_at_ms) VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [input.principalId, verifier.algorithm, verifier.version, verifier.memoryKiB, verifier.iterations, verifier.parallelism, verifier.salt, verifier.hash, nowMs, nowMs]);
      tx.run("INSERT INTO initial_devices(singleton, device_id, principal_id, vault_id, created_at_ms) VALUES (1, ?, ?, ?, ?)", [input.initialDeviceId, input.principalId, input.vaultId, nowMs]);
      tx.run("INSERT INTO devices(device_id, principal_id, vault_id, state, role, credential_digest, is_initial, created_at_ms) VALUES (?, ?, ?, 'pending', 'administrator', NULL, 1, ?)", [input.initialDeviceId, input.principalId, input.vaultId, nowMs]);
      tx.run("INSERT INTO recovery_wraps(singleton, vault_id, wrap_version, algorithm, nonce, ciphertext) VALUES (1, ?, 1, 'A256GCM', ?, ?)", [input.vaultId, decodeCanonicalBase64Url(input.recoveryWrap.nonce, 12), decodeCanonicalBase64Url(input.recoveryWrap.ciphertext, 48)]);
      tx.run("INSERT INTO bootstrap_state(singleton, vault_id, principal_id, initial_device_id, lifecycle, initialized_at_ms, sealed_at_ms) VALUES (1, ?, ?, ?, 'initialized', ?, NULL)", [input.vaultId, input.principalId, input.initialDeviceId, nowMs]);
      return "initialized";
    });
  }

  complete(vaultId: VaultId, envelope: RevisionEnvelope, nowMs: number): "accepted" {
    return this.database.writeTransaction((tx) => {
      const state = tx.get<BootstrapStateRow>("SELECT * FROM bootstrap_state WHERE singleton = 1");
      if (!state || state.lifecycle !== "initialized" || state.vault_id !== vaultId) throw new BootstrapRepositoryError("CONFLICT", "Bootstrap mutation is unavailable");
      const head = tx.get<{ current_head_revision_id: string | null; current_sequence: number }>("SELECT current_head_revision_id, current_sequence FROM server_state WHERE singleton = 1 AND vault_id = ?", [vaultId]);
      if (!head || head.current_head_revision_id !== null || head.current_sequence !== 0) throw new BootstrapRepositoryError("INVARIANT", "Bootstrap head state is inconsistent");
      const missing = missingCatalog(tx, vaultId, envelope);
      if (missing.length) throw new BootstrapRepositoryError("CONFLICT", "Genesis references unavailable objects");
      if (envelope.parents.length !== 0 || envelope.creatingDeviceId !== state.initial_device_id) throw new BootstrapRepositoryError("CONFLICT", "Genesis identity is invalid");
      if (tx.get("SELECT revision_id FROM revisions WHERE vault_id = ? AND revision_id = ?", [vaultId, envelope.revisionId])) throw new BootstrapRepositoryError("CONFLICT", "Genesis revision conflicts");
      const canonical = canonicalizePersistedRevisionEnvelope(envelope);
      tx.run(`INSERT INTO revisions(vault_id, revision_id, creating_device_id, client_created_at, manifest_object_id, protocol_version, revision_format_version, reference_set_mac, canonical_envelope_json, request_digest, server_created_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [vaultId, envelope.revisionId, envelope.creatingDeviceId, envelope.createdAt, envelope.encryptedManifestObjectId, envelope.protocolVersion, envelope.revisionFormatVersion, envelope.referenceSetMac, canonical, "0".repeat(64), nowMs]);
      for (const ref of envelope.references) tx.run(`INSERT INTO revision_objects(vault_id, revision_id, object_id, object_type, ciphertext_checksum, ciphertext_length, object_format_version) VALUES (?, ?, ?, ?, ?, ?, ?)`, [vaultId, envelope.revisionId, ref.objectId, ref.objectType, ref.ciphertextChecksum, ref.ciphertextLength, ref.objectFormatVersion]);
      tx.run("UPDATE revisions SET accepted_sequence = 1 WHERE vault_id = ? AND revision_id = ?", [vaultId, envelope.revisionId]);
      tx.run("UPDATE server_state SET current_head_revision_id = ?, current_sequence = 1 WHERE singleton = 1 AND vault_id = ?", [envelope.revisionId, vaultId]);
      tx.run("UPDATE bootstrap_state SET lifecycle = 'sealed', sealed_at_ms = ? WHERE singleton = 1 AND lifecycle = 'initialized'", [nowMs]);
      return "accepted";
    });
  }

  passwordVerifier(): PasswordVerifierRecord | null {
    const row = this.database.get<Record<string, unknown>>("SELECT password_algorithm, password_version, password_memory_kib, password_iterations, password_parallelism, password_salt, password_hash FROM accounts WHERE singleton = 1");
    if (!row) return null;
    const record: PasswordVerifierRecord = { algorithm: row.password_algorithm as "argon2id", version: row.password_version as 19, memoryKiB: row.password_memory_kib as number, iterations: row.password_iterations as number, parallelism: row.password_parallelism as number, salt: copyBlob(row.password_salt), hash: copyBlob(row.password_hash) };
    validateVerifier(record, false); return record;
  }

  replacePasswordVerifier(verifier: PasswordVerifierRecord, updatedAtMs: number): void {
    // Persisted readers accept bounded legacy records, but every production write is the current baseline.
    validateVerifier(verifier, true);
    this.database.writeTransaction((tx) => {
      const account = tx.get<{ password_updated_at_ms: number }>("SELECT password_updated_at_ms FROM accounts WHERE singleton = 1");
      if (!account) throw new BootstrapRepositoryError("INVARIANT", "Account is unavailable");
      if (!Number.isSafeInteger(updatedAtMs) || updatedAtMs <= account.password_updated_at_ms) throw new BootstrapRepositoryError("INVARIANT", "Password verifier update time is invalid");
      tx.run(`UPDATE accounts SET password_algorithm = ?, password_version = ?, password_memory_kib = ?, password_iterations = ?, password_parallelism = ?, password_salt = ?, password_hash = ?, password_updated_at_ms = ? WHERE singleton = 1`,
        [verifier.algorithm, verifier.version, verifier.memoryKiB, verifier.iterations, verifier.parallelism, verifier.salt, verifier.hash, updatedAtMs]);
    });
  }

  private validatedState(): BootstrapStateRow | null {
    const state = this.database.get<BootstrapStateRow>("SELECT * FROM bootstrap_state WHERE singleton = 1");
    const counts = this.database.get<{ servers: number; accounts: number; devices: number; wraps: number }>(`SELECT
      (SELECT count(*) FROM server_state) AS servers,
      (SELECT count(*) FROM accounts) AS accounts,
      (SELECT count(*) FROM initial_devices) AS devices,
      (SELECT count(*) FROM recovery_wraps) AS wraps`);
    if (!counts) throw new BootstrapRepositoryError("INVARIANT", "Bootstrap metadata is unavailable");
    if (!state) {
      if (counts.servers !== 0 || counts.accounts !== 0 || counts.devices !== 0 || counts.wraps !== 0) throw new BootstrapRepositoryError("INVARIANT", "Bootstrap metadata is incomplete");
      return null;
    }
    if (counts.servers !== 1 || counts.accounts !== 1 || counts.devices !== 1 || counts.wraps !== 1) throw new BootstrapRepositoryError("INVARIANT", "Bootstrap metadata is incomplete");
    const server = this.database.get<{ vault_id: VaultId; current_head_revision_id: string | null; current_sequence: number }>("SELECT vault_id, current_head_revision_id, current_sequence FROM server_state WHERE singleton = 1");
    const account = this.database.get<{ principal_id: string }>("SELECT principal_id FROM accounts WHERE singleton = 1");
    const device = this.database.get<{ device_id: string; principal_id: string; vault_id: string }>("SELECT device_id, principal_id, vault_id FROM initial_devices WHERE singleton = 1");
    const recovery = this.database.get<{ vault_id: string }>("SELECT vault_id FROM recovery_wraps WHERE singleton = 1");
    if (!server || account?.principal_id !== state.principal_id || device?.device_id !== state.initial_device_id || device.principal_id !== state.principal_id || device.vault_id !== state.vault_id || recovery?.vault_id !== state.vault_id || server.vault_id !== state.vault_id) throw new BootstrapRepositoryError("INVARIANT", "Bootstrap identity metadata is inconsistent");
    this.passwordVerifier();
    if (state.lifecycle === "initialized") {
      if (server.current_head_revision_id !== null || server.current_sequence !== 0 || state.sealed_at_ms !== null) throw new BootstrapRepositoryError("INVARIANT", "Initialized bootstrap head is inconsistent");
    } else {
      if (server.current_head_revision_id === null || server.current_sequence < 1 || state.sealed_at_ms === null) throw new BootstrapRepositoryError("INVARIANT", "Sealed bootstrap head is inconsistent");
      const head = this.database.get<{ accepted_sequence: number }>("SELECT accepted_sequence FROM revisions WHERE vault_id = ? AND revision_id = ?", [state.vault_id, server.current_head_revision_id]);
      const genesis = this.database.get<{ revision_id: string; creating_device_id: string; parents: number }>(`SELECT r.revision_id, r.creating_device_id, (SELECT count(*) FROM revision_parents p WHERE p.vault_id = r.vault_id AND p.revision_id = r.revision_id) AS parents FROM revisions r WHERE r.vault_id = ? AND r.accepted_sequence = 1`, [state.vault_id]);
      if (head?.accepted_sequence !== server.current_sequence || !genesis || genesis.creating_device_id !== state.initial_device_id || genesis.parents !== 0) throw new BootstrapRepositoryError("INVARIANT", "Sealed bootstrap revision state is inconsistent");
    }
    return state;
  }
}

function copyBlob(value: unknown): Uint8Array {
  if (!(value instanceof Uint8Array)) throw new BootstrapRepositoryError("INVARIANT", "Persisted password verifier is invalid");
  return Uint8Array.from(value);
}
export function validateVerifier(value: PasswordVerifierRecord, baseline: boolean): void {
  const valid = value.algorithm === "argon2id" && value.version === 19 && Number.isSafeInteger(value.memoryKiB) && value.memoryKiB >= 1 && value.memoryKiB <= 1_048_576
    && Number.isSafeInteger(value.iterations) && value.iterations >= 1 && value.iterations <= 10 && Number.isSafeInteger(value.parallelism) && value.parallelism >= 1 && value.parallelism <= 8
    && value.salt instanceof Uint8Array && value.salt.byteLength >= 16 && value.salt.byteLength <= 64 && value.hash instanceof Uint8Array && value.hash.byteLength >= 32 && value.hash.byteLength <= 64;
  if (!valid || baseline && (value.memoryKiB !== 65_536 || value.iterations !== 3 || value.parallelism !== 1 || value.salt.byteLength !== 16 || value.hash.byteLength !== 32)) throw new BootstrapRepositoryError("INVARIANT", "Password verifier parameters are invalid");
}
function missingCatalog(tx: MetadataTransaction, vaultId: VaultId, envelope: RevisionEnvelope): ObjectId[] {
  const missing: ObjectId[] = [];
  for (let offset = 0; offset < envelope.references.length; offset += 350) {
    const refs = envelope.references.slice(offset, offset + 350), placeholders = refs.map(() => "?").join(",");
    const rows = tx.all<ObjectCatalogRow>(`SELECT * FROM object_catalog WHERE vault_id = ? AND object_id IN (${placeholders})`, [vaultId, ...refs.map((ref) => ref.objectId)]);
    const map = new Map(rows.map((row) => [row.object_id, row]));
    for (const ref of refs) { const row = map.get(ref.objectId); if (!catalogMatches(row, ref)) missing.push(ref.objectId); }
  }
  return missing.sort();
}
function catalogMatches(row: ObjectCatalogRow | undefined, ref: RevisionEnvelope["references"][number]): boolean {
  return !!row && row.object_type === ref.objectType && row.ciphertext_checksum === ref.ciphertextChecksum && row.ciphertext_length === ref.ciphertextLength && row.object_format_version === ref.objectFormatVersion && row.integrity_status !== "missing" && row.integrity_status !== "corrupt";
}
