import { canonicalizePersistedRevisionEnvelope, decodeCanonicalBase64Url, parseVaultId, type RevisionEnvelope, type RecoveryWrapV1 } from "@nanosync/protocol";
import { ServerMetadataDatabase } from "./database.ts";

export class VaultRepository {
  constructor(private readonly db: ServerMetadataDatabase) {}

  list(): { vaultId: string; name: string; sequence: number }[] {
    return this.db.all<{ vaultId: string; name: string; sequence: number }>(
      "SELECT vault_id AS vaultId, name, current_sequence AS sequence FROM server_state WHERE name IS NOT NULL AND current_sequence > 0 ORDER BY name COLLATE NOCASE, vault_id");
  }
  has(id: string): boolean { return !!this.db.get("SELECT 1 FROM server_state WHERE vault_id=? AND current_sequence>0", [parseVaultId(id)]); }

  create(vaultId: string, name: string, wrap: RecoveryWrapV1, genesis: RevisionEnvelope,
    frame: { objectId: string; checksum: string; length: number }, now: number): void {
    parseVaultId(vaultId);
    if (typeof name !== "string" || name !== name.trim() || !name || Buffer.byteLength(name) > 128 || /[\u0000-\u001f\u007f]/u.test(name))
      throw new Error("invalid vault name");
    if (genesis.vaultId !== vaultId || genesis.parents.length !== 0 || genesis.references.length !== 1 ||
        genesis.encryptedManifestObjectId !== frame.objectId || genesis.references[0]?.objectType !== "manifest" ||
        genesis.references[0].objectId !== frame.objectId || genesis.references[0].ciphertextChecksum !== frame.checksum ||
        genesis.references[0].ciphertextLength !== frame.length) throw new Error("invalid vault genesis");
    if (wrap.version !== 1 || wrap.algorithm !== "A256GCM") throw new Error("invalid recovery wrap");
    const nonce = decodeCanonicalBase64Url(wrap.nonce, 12), ciphertext = decodeCanonicalBase64Url(wrap.ciphertext, 48);
    this.db.writeTransaction(tx => {
      const prior = tx.get<{ name: string; current_head_revision_id: string }>("SELECT name,current_head_revision_id FROM server_state WHERE vault_id=?", [vaultId]);
      if (prior) {
        if (prior.name === name && prior.current_head_revision_id === genesis.revisionId) return;
        throw new Error("vault ID already in use");
      }
      if (tx.get("SELECT 1 FROM server_state WHERE name=? COLLATE NOCASE", [name])) throw new Error("vault name already in use");
      tx.run("INSERT INTO server_state(singleton,vault_id,name,current_head_revision_id,current_sequence) VALUES (NULL,?,?,NULL,0)", [vaultId,name]);
      tx.run("INSERT INTO recovery_wraps(singleton,vault_id,wrap_version,algorithm,nonce,ciphertext) VALUES (NULL,?,1,'A256GCM',?,?)", [vaultId,nonce,ciphertext]);
      tx.run(`INSERT INTO object_catalog(vault_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version,durable_created_at_ms)
        VALUES (?,?,'manifest',?,?,1,?)`, [vaultId,frame.objectId,frame.checksum,frame.length,now]);
      tx.run(`INSERT INTO revisions(vault_id,revision_id,creating_device_id,client_created_at,manifest_object_id,protocol_version,revision_format_version,reference_set_mac,canonical_envelope_json,request_digest,server_created_at_ms)
        VALUES (?,?,?,?,?,1,1,?,?,?,?)`, [vaultId,genesis.revisionId,genesis.creatingDeviceId,genesis.createdAt,frame.objectId,
          genesis.referenceSetMac,canonicalizePersistedRevisionEnvelope(genesis),"0".repeat(64),now]);
      tx.run(`INSERT INTO revision_objects(vault_id,revision_id,object_id,object_type,ciphertext_checksum,ciphertext_length,object_format_version)
        VALUES (?,? ,?,'manifest',?,?,1)`, [vaultId,genesis.revisionId,frame.objectId,frame.checksum,frame.length]);
      tx.run("UPDATE revisions SET accepted_sequence=1 WHERE vault_id=? AND revision_id=?", [vaultId,genesis.revisionId]);
      tx.run("UPDATE server_state SET current_head_revision_id=?,current_sequence=1 WHERE vault_id=?", [genesis.revisionId,vaultId]);
    });
  }

  rename(vaultId: string, name: string): void {
    if (typeof name !== "string" || name !== name.trim() || !name || Buffer.byteLength(name)>128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("invalid vault name");
    this.db.writeTransaction(tx => {
      if (tx.get("SELECT 1 FROM server_state WHERE name=? COLLATE NOCASE AND vault_id<>?", [name,vaultId])) throw new Error("vault name already in use");
      if (tx.run("UPDATE server_state SET name=? WHERE vault_id=? AND name IS NOT NULL", [name,parseVaultId(vaultId)]).changes !== 1)
        throw new Error("vault not found");
    });
  }
}
