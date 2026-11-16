import { expect, test } from 'bun:test';
import { ServerMetadataDatabase, VaultRepository } from '../src/index.ts';
import { OWNER_GENESIS_AUTHOR_ID, parsePersistedRevisionEnvelope } from '@nanosync/protocol';
const vaultId = '123e4567-e89b-12d3-a456-426614174000';
const wrap = { version: 1 as const, algorithm: 'A256GCM' as const, nonce: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.alloc(48).toString('base64url') };
const genesis = parsePersistedRevisionEnvelope({ protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId: '223e4567-e89b-12d3-a456-426614174000', parents: [], creatingDeviceId: OWNER_GENESIS_AUTHOR_ID, createdAt: '2026-01-01T00:00:00.000Z', encryptedManifestObjectId: 'a'.repeat(64), references: [{ objectId: 'a'.repeat(64), objectType: 'manifest', ciphertextChecksum: 'b'.repeat(64), ciphertextLength: 109, objectFormatVersion: 1 }], referenceSetMac: 'c'.repeat(64) });
const frame = { objectId: 'a'.repeat(64), checksum: 'b'.repeat(64), length: 109 };
test('creation replay compares all encrypted material, even after rename', () => {
 const db = new ServerMetadataDatabase(':memory:'); const repo = new VaultRepository(db);
 try {
 repo.create(vaultId, 'Vault', wrap, genesis, frame, 1);
 expect(() => repo.create(vaultId, 'Vault', { ...wrap, ciphertext: Buffer.alloc(48, 1).toString('base64url') }, genesis, frame, 2)).toThrow();
 expect(() => repo.create(vaultId, 'Vault', wrap, { ...genesis, referenceSetMac: 'd'.repeat(64) as any }, frame, 2)).toThrow();
 repo.rename(vaultId, 'Renamed');
 expect(() => repo.create(vaultId, 'Vault', wrap, genesis, frame, 3)).not.toThrow();
 expect(repo.list()[0]?.name).toBe('Renamed');
 } finally { db.close(); }
});
test('deletion identifiers survive cleanup and prevent recreation', () => {
 const db = new ServerMetadataDatabase(':memory:'); const repo = new VaultRepository(db);
 try {
 repo.create(vaultId, 'Vault', wrap, genesis, frame, 1);
 repo.markDeleted(vaultId, { origin: 'server-local', actorId: null }, 2);
 expect(repo.has(vaultId)).toBe(false); expect(repo.list()).toEqual([]);
 expect(repo.deletions()).toEqual([{ vaultId, deletedAtMs: 2, cleanupState: 'pending' }]);
 repo.completeDeletion(vaultId);
 expect(() => repo.create(vaultId, 'Vault', wrap, genesis, frame, 3)).toThrow();
 expect(() => db.writeTransaction(tx => tx.run('DELETE FROM vault_deletions'))).toThrow();
 } finally { db.close(); }
});
