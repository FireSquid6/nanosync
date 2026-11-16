import { createHash } from 'node:crypto';
import { OWNER_GENESIS_AUTHOR_ID, parseOwnerActor, parseOwnerEnrollmentAction, parseDeviceId, parseVaultId, type OwnerActor } from '@nanosync/protocol';
import { AuthenticationRepository, ServerMetadataDatabase, VaultRepository } from '@nanosync/server-metadata';
import type { Filesystem } from '@nanosync/server-object-storage';
import { parseEncryptedVaultCreateRequest } from '@nanosync/protocol';
import { objectKey } from './object-service.ts';

/** Trusted owner boundary. Callers authenticate local access/browser sessions,
 * perform CSRF and destructive confirmations BEFORE invoking these operations.
 * Actor provenance is supplied by the authenticated surface, never JSON input.
 */
export class OwnerOperations {
  private readonly auth: AuthenticationRepository;
  private readonly vaults: VaultRepository;
  constructor(private readonly database: ServerMetadataDatabase, private readonly storage: Filesystem, private readonly clock: () => number = Date.now) {
    this.auth = new AuthenticationRepository(database);
    this.vaults = new VaultRepository(database);
  }
  pending(actor: OwnerActor) { parseOwnerActor(actor); return this.auth.pendingRequests(this.clock()); }
  devices(actor: OwnerActor) { parseOwnerActor(actor); return this.auth.listDevices(); }
  decideEnrollment(actor: OwnerActor, input: unknown): void {
    parseOwnerActor(actor);
    const request = parseOwnerEnrollmentAction(input);
    if (request.decision === 'approve') this.auth.approve(actor, request.deviceId, this.clock());
    else this.auth.deny(actor, request.deviceId, this.clock());
  }
  revoke(actor: OwnerActor, deviceId: unknown): void {
    parseOwnerActor(actor);
    this.auth.revoke(actor, parseDeviceId(deviceId), this.clock());
  }
  listVaults(actor: OwnerActor) { parseOwnerActor(actor); return this.vaults.list(); }
  async createVault(actor: OwnerActor, value: unknown) {
    parseOwnerActor(actor);
    const input = parseEncryptedVaultCreateRequest(value);
    if (input.genesisRevision.creatingDeviceId !== OWNER_GENESIS_AUTHOR_ID) throw new Error('Owner genesis requires reserved owner author');
    const frame = Buffer.from(input.frame, 'base64url');
    const reference = input.genesisRevision.references[0]!;
    const checksum = createHash('sha256').update(frame).digest('hex');
    if (checksum !== reference.ciphertextChecksum) throw new Error('Invalid genesis frame checksum');
    if (this.vaults.deletions().some(d => d.vaultId === input.vaultId)) throw new Error('vault ID is deleted');
    await this.storage.putIfAbsent(objectKey('manifest', reference.objectId, input.vaultId), new ReadableStream({ start(controller) { controller.enqueue(frame); controller.close(); } }), checksum);
    this.vaults.create(input.vaultId, input.name, input.recoveryWrap, input.genesisRevision, { objectId: reference.objectId, checksum, length: frame.length }, this.clock(), actor);
    return { vaultId: input.vaultId };
  }
  renameVault(actor: OwnerActor, vaultId: unknown, name: string): void { parseOwnerActor(actor); this.vaults.rename(parseVaultId(vaultId), name, actor, this.clock()); }
  markVaultDeleted(actor: OwnerActor, vaultId: unknown): void { parseOwnerActor(actor); this.vaults.markDeleted(parseVaultId(vaultId), actor, this.clock()); }
  recentActivity(actor: OwnerActor, limit = 100) {
    parseOwnerActor(actor);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('Invalid activity limit');
    return this.database.all<{ sequence: number; action: string; occurredAtMs: number; origin: 'device' | 'server-local' | 'browser'; actorId: string | null; targetId: string | null }>(
      "SELECT sequence,event_type AS action,occurred_at_ms AS occurredAtMs,origin,actor_id AS actorId,target_id AS targetId FROM audit_events WHERE event_type IN ('enrollment.approved','enrollment.denied','device.revoked','vault.created','vault.renamed','vault.deleted') ORDER BY sequence DESC LIMIT ?", [limit]);
  }
}
