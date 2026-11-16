import { createHash } from "node:crypto";
import { parseOwnerActor, type OwnerActor } from "@nanosync/protocol";
import { canonicalizePersistedRevisionEnvelope, decodeCanonicalBase64Url, parseVaultId, type RevisionEnvelope, type RecoveryWrapV1 } from "@nanosync/protocol";
import { ServerMetadataDatabase } from "./database.ts";

export class VaultRepository {
  constructor(private readonly db: ServerMetadataDatabase) {}

  list(): { vaultId: string; name: string; sequence: number }[] {
    return this.db.all<{ vaultId: string; name: string; sequence: number }>(
      "SELECT vault_id AS vaultId, name, current_sequence AS sequence FROM server_state WHERE name IS NOT NULL AND current_sequence > 0 AND NOT EXISTS (SELECT 1 FROM vault_deletions d WHERE d.vault_id=server_state.vault_id) ORDER BY name COLLATE NOCASE, vault_id");
  }
  has(id: string): boolean { return !!this.db.get("SELECT 1 FROM server_state WHERE vault_id=? AND current_sequence>0 AND NOT EXISTS (SELECT 1 FROM vault_deletions d WHERE d.vault_id=server_state.vault_id)", [parseVaultId(id)]); }

  create(vaultId: string, name: string, wrap: RecoveryWrapV1, genesis: RevisionEnvelope,
    frame: { objectId: string; checksum: string; length: number }, now: number, actor?: OwnerActor): void {
    parseVaultId(vaultId);
    if (actor) parseOwnerActor(actor);
    if (typeof name !== "string" || name !== name.trim() || !name || Buffer.byteLength(name) > 128 || /[\u0000-\u001f\u007f]/u.test(name))
      throw new Error("invalid vault name");
    if (genesis.vaultId !== vaultId || genesis.parents.length !== 0 || genesis.references.length !== 1 ||
        genesis.encryptedManifestObjectId !== frame.objectId || genesis.references[0]?.objectType !== "manifest" ||
        genesis.references[0].objectId !== frame.objectId || genesis.references[0].ciphertextChecksum !== frame.checksum ||
        genesis.references[0].ciphertextLength !== frame.length) throw new Error("invalid vault genesis");
    if (wrap.version !== 1 || wrap.algorithm !== "A256GCM") throw new Error("invalid recovery wrap");
    const nonce = decodeCanonicalBase64Url(wrap.nonce, 12), ciphertext = decodeCanonicalBase64Url(wrap.ciphertext, 48);
    const envelope = canonicalizePersistedRevisionEnvelope(genesis);
    const digest = createHash('sha256').update(JSON.stringify([vaultId,name,wrap.version,wrap.algorithm,wrap.nonce,wrap.ciphertext,envelope,frame.objectId,frame.checksum,frame.length])).digest('hex');
    this.db.writeTransaction(tx => {
      if (tx.get("SELECT 1 FROM vault_deletions WHERE vault_id=?", [vaultId])) throw new Error('vault ID is deleted');
      const creation = tx.get<{ request_digest: string }>("SELECT request_digest FROM vault_creations WHERE vault_id=?", [vaultId]);
      if (creation) {
        if (creation.request_digest === digest) return;
        throw new Error('vault ID already in use with different creation material');
      }
      const prior = tx.get<{ name: string; current_head_revision_id: string }>("SELECT name,current_head_revision_id FROM server_state WHERE vault_id=?", [vaultId]);
      if (prior) {
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
      tx.run("INSERT INTO vault_creations(vault_id,request_digest) VALUES (?,?)", [vaultId,digest]);
      if (actor) ownerAudit(tx, 'vault.created', vaultId, actor, now);
    });
  }

  rename(vaultId: string, name: string, actor?: OwnerActor, now = Date.now()): void {
    if (typeof name !== "string" || name !== name.trim() || !name || Buffer.byteLength(name)>128 || /[\u0000-\u001f\u007f]/u.test(name)) throw new Error("invalid vault name");
    if (actor) parseOwnerActor(actor);
    this.db.writeTransaction(tx => {
      if (tx.get("SELECT 1 FROM vault_deletions WHERE vault_id=?", [parseVaultId(vaultId)])) throw new Error("vault ID is deleted");
      if (tx.get("SELECT 1 FROM server_state WHERE name=? COLLATE NOCASE AND vault_id<>?", [name,vaultId])) throw new Error("vault name already in use");
      if (tx.run("UPDATE server_state SET name=? WHERE vault_id=? AND name IS NOT NULL", [name,parseVaultId(vaultId)]).changes !== 1)
        throw new Error("vault not found");
      if (actor) ownerAudit(tx, "vault.renamed", vaultId, actor, now);
    });
  }
  markDeleted(vaultId: string, actor: OwnerActor, now: number): void {
    parseVaultId(vaultId); parseOwnerActor(actor);
    this.db.writeTransaction(tx => {
      if (tx.get("SELECT 1 FROM vault_deletions WHERE vault_id=?", [vaultId])) return;
      if (!tx.get("SELECT 1 FROM server_state WHERE vault_id=?", [vaultId])) throw new Error('vault not found');
      tx.run("INSERT INTO vault_deletions(vault_id,deleted_at_ms,cleanup_state) VALUES (?,?,'pending')", [vaultId,now]);
      ownerAudit(tx, 'vault.deleted', vaultId, actor, now);
    });
  }
  deletions(): { vaultId: string; deletedAtMs: number; cleanupState: 'pending' | 'complete' }[] {
    return this.db.all("SELECT vault_id AS vaultId,deleted_at_ms AS deletedAtMs,cleanup_state AS cleanupState FROM vault_deletions ORDER BY deleted_at_ms,vault_id");
  }
  // Cleanup worker must call only after metadata and storage reclamation.
  completeDeletion(vaultId: string): void {
    this.db.writeTransaction(tx => tx.run("UPDATE vault_deletions SET cleanup_state='complete' WHERE vault_id=? AND cleanup_state='pending'", [parseVaultId(vaultId)]));
  }

}

function ownerAudit(tx: import('./database.ts').MetadataTransaction, type: string, target: string, actor: OwnerActor, now: number): void {
  tx.run("INSERT INTO audit_events(event_type,occurred_at_ms,details_json,origin,actor_id,target_id) VALUES (?,?,'{}',?,?,?)", [type,now,actor.origin,actor.actorId,target]);
}
