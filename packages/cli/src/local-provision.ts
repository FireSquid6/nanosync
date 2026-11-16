import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { OWNER_GENESIS_AUTHOR_ID, parseEncryptedVaultCreateRequest, parsePersistedRevisionEnvelope } from '@nanosync/protocol';
import { encryptManifest, generateRecoverySecret, generateVaultMasterKey, displayRecoverySecret, wrapMasterKey, referenceSetMac } from '@nanosync/sync-core';
import { privateDirectory, secureCreate, secureRead, secureReplace } from './security.ts';
import { acquireServerStorage } from './server-ownership.ts';
import { localOwner, withLocalOwner } from './server.ts';

type EncryptedVaultCreateRequest = ReturnType<typeof parseEncryptedVaultCreateRequest>;
type Receipt = { request: EncryptedVaultCreateRequest; phase: 'prepared' | 'delivered' | 'complete'; recoveryDigest: string; output: string | null };
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Durable encrypted receipts precede protected output. No provisioning secret is persisted here. */
export async function provisionLocalVault(directory: string, name: string, deliver: (secret: string) => Promise<void>, recoveryOutput?: string) {
  const root = privateDirectory(directory);
  // Acquire before receipt/recovery delivery as well as every possible storage write.
  const release = acquireServerStorage(root);
  try {
    const output = recoveryOutput ? resolve(recoveryOutput) : null;
    const path = output ? join(privateDirectory(join(root, 'owner-creations')), `${digest(output)}.json`) : join(root, 'owner-creation.json');
    let receipt: Receipt | undefined;
    const save = (value: Receipt) => {
      if (existsSync(path)) secureReplace(path, JSON.stringify(value)); else secureCreate(path, JSON.stringify(value));
      receipt = value;
    };
    if (existsSync(path)) {
      const saved = JSON.parse(secureRead(path, 32768).toString('utf8')) as Receipt;
      saved.request = parseEncryptedVaultCreateRequest(saved.request);
      if (!['prepared','delivered','complete'].includes(saved.phase) || saved.output !== output || !/^[0-9a-f]{64}$/.test(saved.recoveryDigest)) throw new Error('Invalid owner creation receipt');
      if (saved.request.name !== name) {
        if (output || saved.phase !== 'complete') throw new Error('Another vault creation uses this recovery delivery; retry its name or select a new output file');
      } else receipt = saved;
    }
    // A prepared receipt never reached server mutation. If delivery was interrupted
    // before a file appeared, regenerate safely. If it appeared, verify and flush
    // its protected descriptor and parent before treating interrupted delivery as durable.
    if (receipt && output && existsSync(output)) {
      if (digest(secureRead(output, 4096, receipt.phase === 'prepared').toString('utf8').trimEnd()) !== receipt.recoveryDigest) throw new Error('Recovery output differs from creation receipt; no vault published');
      if (receipt.phase === 'prepared') save({...receipt, phase:'delivered'});
    } else if (receipt?.phase === 'prepared') receipt = undefined;
    else if (receipt && output) throw new Error('Delivered recovery output is missing; restore it before retrying');

    if (!receipt) {
      const vaultId = randomUUID(), revisionId = randomUUID(), master = generateVaultMasterKey(), recovery = generateRecoverySecret();
      try {
        const encrypted = await encryptManifest({ version:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
          entries:[{ id:randomUUID(), parentId:null, name:'', kind:'directory' }] }, master);
        const genesis = parsePersistedRevisionEnvelope({ protocolVersion:1, revisionFormatVersion:1, vaultId, revisionId, parents:[], creatingDeviceId:OWNER_GENESIS_AUTHOR_ID,
          createdAt:new Date().toISOString(), encryptedManifestObjectId:encrypted.reference.objectId, references:[encrypted.reference], referenceSetMac:'0'.repeat(64) });
        const request = parseEncryptedVaultCreateRequest({ vaultId, name, recoveryWrap:await wrapMasterKey(master, recovery, vaultId),
          genesisRevision:parsePersistedRevisionEnvelope({ ...genesis, referenceSetMac:await referenceSetMac(genesis, master) }), frame:Buffer.from(encrypted.frame).toString('base64url') });
        const secret = await displayRecoverySecret(recovery);
        const prepared: Receipt = {request, phase:'prepared', recoveryDigest:digest(secret), output};
        save(prepared);
        await deliver(secret);
        if (output && digest(secureRead(output,4096).toString('utf8').trimEnd()) !== prepared.recoveryDigest) throw new Error('Recovery delivery could not be verified');
        save({...prepared, phase:'delivered'});
      } finally { master.fill(0); recovery.fill(0); }
    }
    const delivered = receipt!;
    const result = await withLocalOwner(root, owner => owner.createVault(localOwner, delivered.request));
    save({...delivered, phase:'complete'});
    return { ...result, name };
  } finally { release(); }
}
