// The portable sync client also accepts browser-style request inputs.
declare global { type RequestInfo = Request | string; }
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { OWNER_GENESIS_AUTHOR_ID, parseEncryptedVaultCreateRequest, parsePersistedRevisionEnvelope } from '@nanosync/protocol';
import { ServerMetadataDatabase, AuthenticationRepository, RevisionRepository } from '@nanosync/server-metadata';
import { LocalFilesystem } from '@nanosync/server-object-storage';
import { encryptManifest, referenceSetMac } from '../../sync-core/src/index.ts';
import { OwnerOperations } from '../src/index.ts';

test('encrypted owner genesis uses existing crypto and idempotent shared operations without creating a device', async () => {
 const root = await mkdtemp(join(tmpdir(), 'nanosync-owner-'));
 const db = new ServerMetadataDatabase(join(root, 'metadata.sqlite'));
 try {
 const master = new Uint8Array(32).fill(7);
 const vaultId = '123e4567-e89b-42d3-a456-426614174000';
 const revisionId = '223e4567-e89b-42d3-a456-426614174000';
 const encrypted = await encryptManifest({ version: 1, vaultId, revisionId, parents: [], creatingDeviceId: OWNER_GENESIS_AUTHOR_ID, entries: [{ id: '323e4567-e89b-42d3-a456-426614174000', parentId: null, name: '', kind: 'directory' }] }, master);
 const genesis = parsePersistedRevisionEnvelope({ protocolVersion: 1, revisionFormatVersion: 1, vaultId, revisionId, parents: [], creatingDeviceId: OWNER_GENESIS_AUTHOR_ID, createdAt: '2026-01-01T00:00:00.000Z', encryptedManifestObjectId: encrypted.reference.objectId, references: [encrypted.reference], referenceSetMac: '0'.repeat(64) });
 genesis.referenceSetMac = await referenceSetMac(genesis, master) as typeof genesis.referenceSetMac;
 const input = { vaultId, name: 'Owner vault', recoveryWrap: { version: 1, algorithm: 'A256GCM', nonce: Buffer.alloc(12).toString('base64url'), ciphertext: Buffer.alloc(48).toString('base64url') }, genesisRevision: genesis, frame: Buffer.from(encrypted.frame).toString('base64url') };
 const actor = { origin: 'browser' as const, actorId: null };
 const operations = new OwnerOperations(db, new LocalFilesystem(join(root, 'objects')), () => 20);
 expect(() => parseEncryptedVaultCreateRequest({ ...input, password: 'not allowed' })).toThrow();
 expect(() => parseEncryptedVaultCreateRequest({ ...input, genesisRevision: { ...genesis, vaultId: revisionId } })).toThrow();
 await operations.createVault(actor, input);
 operations.renameVault(actor, vaultId, 'Renamed');
 await operations.createVault(actor, input);
 await expect(operations.createVault(actor, { ...input, recoveryWrap: { ...input.recoveryWrap, ciphertext: Buffer.alloc(48, 1).toString('base64url') } })).rejects.toThrow();
 expect(operations.listVaults(actor)).toEqual([{ vaultId, name: 'Renamed', sequence: 1 }]);
 expect(new AuthenticationRepository(db).listDevices()).toEqual([]);
 expect(operations.recentActivity(actor).map(e => e.action)).toEqual(['vault.renamed', 'vault.created']);
 operations.markVaultDeleted(actor, vaultId);
 expect(() => new RevisionRepository(db).requireVault(genesis.vaultId)).toThrow(expect.objectContaining({ code: 'VAULT_DELETED' }));
 } finally { db.close(); await rm(root, { recursive: true, force: true }); }
});
