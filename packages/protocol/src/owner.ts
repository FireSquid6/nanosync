import { ProtocolValidationError } from './errors.ts';
import { parseDeviceId, parseVaultId, type DeviceId } from './ids.ts';
import { parsePersistedRevisionEnvelope } from './envelopes.ts';
import { parseObjectFrameHeader } from './object-http.ts';
import { decodeCanonicalBase64Url, parseRecoveryWrap } from './bootstrap.ts';

export interface OwnerActor { origin: 'server-local' | 'browser'; actorId: string | null; }
// Reserved author UUID for owner-created genesis only. It is an authenticated
// envelope author label, not a device, credential, or encryption-format change.
export const OWNER_GENESIS_AUTHOR_ID = parseDeviceId('00000000-0000-4000-8000-000000000001');
function exact(value: unknown, fields: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw new ProtocolValidationError('INVALID_TYPE', 'request', 'expected plain object');
  const record = value as Record<string, unknown>;
  if (Object.keys(record).length !== fields.length || fields.some(key => !Object.hasOwn(record, key))) throw new ProtocolValidationError('INVALID_VALUE', 'request', 'unexpected or missing fields');
  return record;
}
export function parseOwnerActor(value: unknown): OwnerActor {
  const input = exact(value, ['origin', 'actorId']);
  if ((input.origin !== 'server-local' && input.origin !== 'browser') || (input.actorId !== null && (typeof input.actorId !== 'string' || !input.actorId.length || new TextEncoder().encode(input.actorId).length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.actorId)))) throw new ProtocolValidationError('INVALID_VALUE', 'actor', 'invalid owner actor');
  return input as unknown as OwnerActor;
}
export function parseOwnerEnrollmentAction(value: unknown): { protocolVersion: 1; deviceId: DeviceId; decision: 'approve' | 'deny' } {
  const input = exact(value, ['protocolVersion', 'deviceId', 'decision']);
  if (input.protocolVersion !== 1 || (input.decision !== 'approve' && input.decision !== 'deny')) throw new ProtocolValidationError('INVALID_VALUE', 'request', 'invalid enrollment decision');
  return { protocolVersion: 1, deviceId: parseDeviceId(input.deviceId), decision: input.decision };
}
// UUID is the exact request identity. Fingerprint suffix aids out-of-band
// comparison. Never use this public code as authentication material.
export function enrollmentVerificationCode(deviceId: unknown, fingerprint: string): string {
  const id = parseDeviceId(deviceId);
  const bytes = decodeCanonicalBase64Url(fingerprint, 32);
  return `${id.toUpperCase()}-${Array.from(bytes.slice(0, 8), b => b.toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}


export function parseEncryptedVaultCreateRequest(value: unknown) {
  const input = exact(value, ['vaultId', 'name', 'recoveryWrap', 'genesisRevision', 'frame']);
  const vaultId = parseVaultId(input.vaultId);
  if (typeof input.name !== 'string' || input.name !== input.name.trim() || !input.name || new TextEncoder().encode(input.name).length > 128 || /[\u0000-\u001f\u007f-\u009f]/u.test(input.name)) throw new ProtocolValidationError('INVALID_VALUE', 'name', 'invalid vault name');
  if (typeof input.frame !== 'string' || !/^[A-Za-z0-9_-]+$/.test(input.frame) || input.frame.length > 10923) throw new ProtocolValidationError('INVALID_VALUE', 'frame', 'invalid encrypted frame');
  const bytes = decodeCanonicalBase64Url(input.frame, Math.floor(input.frame.length * 6 / 8), 'frame');
  const header = parseObjectFrameHeader(bytes.subarray(0, 80));
  const genesisRevision = parsePersistedRevisionEnvelope(input.genesisRevision);
  const reference = genesisRevision.references[0];
  if (bytes.length > 8192 || header.vaultId !== vaultId || header.objectType !== 'manifest' || header.completeLength !== bytes.length || genesisRevision.vaultId !== vaultId || genesisRevision.parents.length || genesisRevision.references.length !== 1 || !reference || reference.objectType !== 'manifest' || reference.objectId !== header.objectId || reference.objectId !== genesisRevision.encryptedManifestObjectId || reference.ciphertextLength !== bytes.length) throw new ProtocolValidationError('INVALID_VALUE', 'genesisRevision', 'invalid vault genesis');
  return { vaultId, name: input.name, recoveryWrap: parseRecoveryWrap(input.recoveryWrap), genesisRevision, frame: input.frame };
}
