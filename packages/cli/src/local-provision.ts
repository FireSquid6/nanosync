import { randomUUID } from 'node:crypto';
import { existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { OWNER_GENESIS_AUTHOR_ID, parseEncryptedVaultCreateRequest, parsePersistedRevisionEnvelope } from '@nanosync/protocol';
import { encryptManifest, generateRecoverySecret, generateVaultMasterKey, displayRecoverySecret, wrapMasterKey, referenceSetMac } from '@nanosync/sync-core';
import { privateDirectory, secureCreate, secureRead, syncPrivateDirectory } from './security.ts';
import { localOwner, withLocalOwner } from './server.ts';

/** Only encrypted creation bytes persist here; recovery delivery precedes server mutation. */
export async function provisionLocalVault(directory: string, name: string, deliver: (secret: string) => Promise<void>) {
  const root = privateDirectory(directory), path = join(root, 'owner-creation.json');
  let request;
  if (existsSync(path)) {
    request = parseEncryptedVaultCreateRequest(JSON.parse(secureRead(path, 16384).toString('utf8')));
    if (request.name !== name) throw new Error('Another vault creation is pending; retry its name');
  } else {
    const vaultId = randomUUID(), revisionId = randomUUID(), master = generateVaultMasterKey(), recovery = generateRecoverySecret();
    try {
      const encrypted = await encryptManifest({ version:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
        entries:[{ id:randomUUID(), parentId:null, name:'', kind:'directory' }] }, master);
      const genesis = parsePersistedRevisionEnvelope({ protocolVersion:1, revisionFormatVersion:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
        createdAt:new Date().toISOString(), encryptedManifestObjectId:encrypted.reference.objectId, references:[encrypted.reference], referenceSetMac:'0'.repeat(64) });
      request = { vaultId, name, recoveryWrap:await wrapMasterKey(master, recovery, vaultId),
        genesisRevision:parsePersistedRevisionEnvelope({ ...genesis, referenceSetMac:await referenceSetMac(genesis, master) }), frame:Buffer.from(encrypted.frame).toString('base64url') };
      request = parseEncryptedVaultCreateRequest(request);
      await deliver(await displayRecoverySecret(recovery));
      secureCreate(path, JSON.stringify(request));
    } finally { master.fill(0); recovery.fill(0); }
  }
  const result = await withLocalOwner(root, owner => owner.createVault(localOwner, request));
  unlinkSync(path); syncPrivateDirectory(root);
  return { ...result, name };
}
