import { createHash } from "node:crypto";
import {
  MAX_JSON_METADATA_BYTES, PROTOCOL_VERSION,
  canonicalizeAdvanceHeadIdentity, canonicalizeRevisionEnvelope,
  type AdvanceHeadRequest, type AdvanceHeadResult, type ObjectId, type RevisionId,
} from "@nanosync/protocol";
import { RevisionRepository, RevisionRepositoryError, type RevisionIdentity } from "@nanosync/server-metadata";
import { ObjectStorageError, type Filesystem } from "@nanosync/server-object-storage";
import { ApiError, json } from "./http.ts";
import { objectKey, type AuthorizationContext } from "./object-service.ts";

export interface RevisionServiceOptions {
  filesystem: Filesystem;
  revisions: RevisionRepository;
  clock?: () => number;
}

const STORAGE_BATCH = 1_000;
export const REVISION_STAT_CONCURRENCY = 32;

export class RevisionService {
  private readonly clock: () => number;
  constructor(private readonly options: RevisionServiceOptions) { this.clock = options.clock ?? Date.now; }

  head(context: AuthorizationContext): Response {
    const head = this.repositoryCall(() => this.options.revisions.head(context.vaultId));
    return head.revisionId === null
      ? json({ protocolVersion: PROTOCOL_VERSION, status: "initializedWithoutHead", revisionId: null, sequence: 0 })
      : json({ protocolVersion: PROTOCOL_VERSION, status: "head", revisionId: head.revisionId, sequence: head.sequence });
  }

  revision(context: AuthorizationContext, revisionId: RevisionId): Response {
    const stored = this.repositoryCall(() => this.options.revisions.revision(context.vaultId, revisionId));
    if (!stored) throw new ApiError(404, "NOT_FOUND", "Revision not found");
    return json({ protocolVersion: PROTOCOL_VERSION, revision: stored.envelope, sequence: stored.sequence });
  }

  async advance(context: AuthorizationContext, request: AdvanceHeadRequest): Promise<Response> {
    this.repositoryCall(() => this.options.revisions.requireVault(context.vaultId));
    if (request.vaultId !== context.vaultId) return json(invalid("VAULT_MISMATCH"));
    if (request.proposedRevision.creatingDeviceId !== context.deviceId) return json(invalid("CREATING_DEVICE_MISMATCH"));
    if (request.expectedRevisionId === null) return json(invalid("GENESIS_REQUIRES_BOOTSTRAP"));
    const parents = request.proposedRevision.parents;
    if (parents.length === 1 && parents[0] !== request.expectedRevisionId) return json(invalid("EXPECTED_PARENT_MISMATCH"));
    if (parents.length === 2 && !parents.includes(request.expectedRevisionId)) return json(invalid("EXPECTED_PARENT_MISMATCH"));

    const canonicalIdentity = canonicalizeAdvanceHeadIdentity(request);
    const identity: RevisionIdentity = {
      principalId: context.principalId,
      deviceId: context.deviceId,
      vaultId: context.vaultId,
      idempotencyKey: request.idempotencyKey,
      requestDigest: createHash("sha256").update(canonicalIdentity, "utf8").digest("hex"),
    };
    const replay = this.repositoryCall(() => this.options.revisions.idempotency(identity));
    if (replay) return json(replay);

    if (!this.repositoryCall(() => this.options.revisions.parentIdsExist(context.vaultId, parents))) return json(invalid("PARENT_NOT_FOUND"));
    const missing = new Set<ObjectId>(this.repositoryCall(() => this.options.revisions.missingCatalogReferences(context.vaultId, request.proposedRevision)));
    const candidates = request.proposedRevision.references.filter((reference) => !missing.has(reference.objectId));
    try {
      for (const id of await verifyReferenceStorage(this.options.filesystem, candidates,
        this.options.revisions.legacyVault(context.vaultId) ? undefined : context.vaultId)) missing.add(id);
    } catch (error) {
      this.repositoryCall(() => this.options.revisions.requireVault(context.vaultId));
      throw error;
    }
    this.repositoryCall(() => this.options.revisions.requireVault(context.vaultId));
    if (missing.size) return json({ status: "missingObjects", objectIds: [...missing].sort() } satisfies AdvanceHeadResult);

    const result = this.repositoryCall(() => this.options.revisions.advance({
      identity,
      expectedRevisionId: request.expectedRevisionId!,
      envelope: request.proposedRevision,
      canonicalEnvelopeJson: canonicalizeRevisionEnvelope(request.proposedRevision),
      nowMs: this.clock(),
    }));
    return json(result);
  }

  static readonly maximumBodyBytes = MAX_JSON_METADATA_BYTES;

  private repositoryCall<T>(callback: () => T): T {
    try { return callback(); }
    catch (error) {
      if (error instanceof RevisionRepositoryError) {
        if (error.code === "VAULT_DELETED") throw new ApiError(410, "VAULT_DELETED", "Vault is permanently deleted");
        if (error.code === "IDEMPOTENCY_KEY_REUSE") throw new ApiError(409, "IDEMPOTENCY_KEY_REUSE", "Idempotency key was used for another request");
        if (error.code === "VAULT_CONFLICT") throw new ApiError(403, "FORBIDDEN", "Authenticated vault is not available");
        if (error.code === "SERVER_UNINITIALIZED") throw new ApiError(503, "UNAVAILABLE", "Server vault is not initialized");
      }
      throw error;
    }
  }
}

export async function verifyReferenceStorage(filesystem: Filesystem, candidates: readonly { objectId: ObjectId; objectType: "chunk" | "manifest" | "revision-private"; ciphertextLength: number }[], vaultId?: string): Promise<ObjectId[]> {
  const missing = new Set<ObjectId>();
  for (let offset = 0; offset < candidates.length; offset += STORAGE_BATCH) {
      const batch = candidates.slice(offset, offset + STORAGE_BATCH);
      const keys = batch.map((reference) => objectKey(reference.objectType, reference.objectId, vaultId));
      const exists = await filesystem.existsBatch(keys);
      if (exists.length !== batch.length) throw new ApiError(500, "INTERNAL", "Request failed");
      await forEachBounded(batch, REVISION_STAT_CONCURRENCY, async (reference, index) => {
        if (!exists[index]) { missing.add(reference.objectId); return; }
        try {
          const stat = await filesystem.stat(keys[index]!);
          if (stat.size !== reference.ciphertextLength) missing.add(reference.objectId);
        } catch (error) {
          if (error instanceof ObjectStorageError && error.code === "NOT_FOUND") { missing.add(reference.objectId); return; }
          throw error;
        }
      });
    }
  return [...missing].sort();
}

function invalid(reasonCode: string): AdvanceHeadResult { return { status: "invalidRevision", reasonCode }; }

async function forEachBounded<T>(items: readonly T[], concurrency: number, callback: (item: T, index: number) => Promise<void>): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  const worker = async (): Promise<void> => {
    while (!failed) {
      const index = next++;
      if (index >= items.length) return;
      try { await callback(items[index]!, index); }
      catch (error) { failed = true; failure = error; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  if (failed) throw failure;
}
