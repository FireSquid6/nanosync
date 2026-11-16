# Issue #5 implementation progress

## Shared owner administration foundation (completed)

Spec: `docs/server-ui-and-client-cli-spec.md`. No earlier progress file existed. This step supplies reusable operations/contracts, not the CLI/browser surfaces or physical deletion worker.

### Public integration contracts

- `@nanosync/protocol` exports `OwnerActor`, `parseOwnerActor`, `parseOwnerEnrollmentAction`, `enrollmentVerificationCode`, `OWNER_GENESIS_AUTHOR_ID`, and `parseEncryptedVaultCreateRequest`.
- `OwnerActor` is exactly `{ origin: 'server-local' | 'browser', actorId: string | null }`. Actor IDs are bounded non-control text (128 UTF-8 bytes), not device foreign keys. Supply provenance from trusted local access or an authenticated browser session; never trust an actor object submitted by the browser as authorization.
- Enrollment decisions have exactly `{ protocolVersion: 1, deviceId: <canonical lowercase UUID>, decision: 'approve' | 'deny' }`. Display names are not selectors. The UUID is the existing enrollment device identity; terminal fresh enrollments should generate a fresh identity. `enrollmentVerificationCode(deviceId, fingerprint)` is a portable deterministic public comparison string: uppercase full UUID plus the first eight fingerprint bytes as uppercase hexadecimal. Both inputs are immutable request columns. Clients can calculate it before submission; owner pending views derive it from the request, not mutable device metadata. It is not authentication material.
- `parseEncryptedVaultCreateRequest` accepts exactly `{ vaultId, name, recoveryWrap, genesisRevision, frame }`, where `frame` is canonical base64url, at most 8192 decoded bytes, and is the sole manifest reference. It validates UUIDs, trimmed/bounded name, wrap, envelope, frame/header identities and lengths; server-core additionally checks the complete frame SHA-256 checksum. No plaintext recovery secret/key fields are accepted.
- `OWNER_GENESIS_AUTHOR_ID` is `00000000-0000-4000-8000-000000000001`. Set **both the encrypted manifest author and genesis envelope author** to this UUID before encryption/MAC generation. It is only an author label. Do not create a device row or credential for it. Existing sync-core encryption and reference-set MAC primitives work unchanged (covered using real crypto).
- `@nanosync/server-core` exports `OwnerOperations(database, filesystem, clock?)`. Public methods: `pending`, `devices`, `decideEnrollment`, `revoke`, `listVaults`, `createVault`, `renameVault`, `markVaultDeleted`, `recentActivity`. All take an explicit owner actor. These are trusted business-operation seams, not HTTP authentication handlers. Local/browser adapters must authenticate and enforce their confirmations/CSRF/transport rules before calling them. Creation returns `{ vaultId }`; it does not return recovery material.
- `pending` adds `verificationCode`, `requestedAtMs`, and `expiresAtMs` to existing device metadata. `recentActivity(actor, limit=100)` returns newest-first `{ sequence, action, occurredAtMs, origin, actorId, targetId }`, with a maximum limit of 100; it deliberately excludes details, names, file paths, and secrets.
- Authentication repository approval/revocation now accept either a device ID (existing device-admin behavior) or an explicit `OwnerActor`. `deny` requires an owner actor. Replaying the same terminal decision is idempotent; opposite decisions/expired requests conflict. Denied requests remain observable through enrollment status. Fresh requests may reuse the denied display name; active names remain uniquely constrained and pending names are checked transactionally against live requests.
- Device actors still require a live administrator, cannot self-revoke, and cannot revoke the last administrator. Owner actors do not inherit device self/last-admin restrictions. Migration 6 removes the device-only last-admin SQL trigger; the existing transactional device-admin repository guard remains authoritative.
- `VaultRepository.create(..., now, actor?)` now persists a digest of the entire original name/wrap/canonical genesis/frame metadata. Identical replay succeeds even after rename/head advancement; any changed encrypted material conflicts. A replay does not rename a vault or duplicate audit events. Owner paths supply the actor to create/rename for transactional audit writes.
- Migration 6 (`owner_administration`) adds audit `origin`, `actor_id`, `target_id`; immutable `vault_creations` digests; and `vault_deletions(vault_id, deleted_at_ms, cleanup_state)`. Deletion UUIDs/timestamps cannot change or be deleted. Cleanup transitions only pending → complete. Migration 1–5 SQL/checksums are unchanged.
- `VaultRepository.markDeleted(id, actor, now)`, `deletions()`, and `completeDeletion(id)` provide the next deletion worker's durable state. Marking is idempotent, emits one audit event, hides the vault from lists, prevents rename/recreation, and causes vault admission plus transactional publication/upload commits to reject it. Protocol error `VAULT_DELETED` is mapped to HTTP 410 by the existing sync admission/service boundaries. Recovery-wrap lookup refuses explicit deleted IDs.

### Required follow-up integration (not silently implemented)

- Wire both the new server-local commands and authenticated browser endpoints to `OwnerOperations`. Existing legacy CLI/device vault mutation endpoints still exist pending that command/API redesign; this step did not introduce browser endpoints or sessions.
- Implement browser session storage/lifetimes, password login/reauthentication, origin/CSRF policy, recovery delivery/acknowledgement checkpoints, and surface-specific stable result/error handling. No browser-session persistence is claimed by this step.
- `markVaultDeleted` is **not physical cleanup**. Implement restart-safe object/history/wrap reclamation, in-flight object-write coordination, and multi-vault race tests next. Keep tombstones forever, and call `completeDeletion` only after actual reclamation. The present pre-write tombstone check and transactional commit gates alone do not coordinate a cleanup worker with an already-running storage write. Do not expose completed deletion as reclaimed storage yet.
- Propagate the stable deleted-vault outcome through client sync stopping/preserved-files UX and all new recovery-wrap/browser endpoints. No client plaintext changes were made here.
- Provisioning conflict failures currently use existing repository errors/messages; adapters must map these to their documented public result/error vocabulary rather than exposing arbitrary exceptions.

### Evidence

- Observed red tests for missing strict owner exports and for the previous vault replay bug (changed recovery ciphertext was incorrectly accepted), then implemented and reran green.
- `bun test packages/server-metadata packages/server-core packages/protocol`: **109 passed, 0 failed**.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **244 passed, 0 failed** (baseline 237).
- Focused behavior includes real encrypted owner genesis without a fabricated device, exact UUID decisions, deny/status/fresh request, request-code replay stability, browser/local audit provenance, distinct owner revocation, complete encrypted replay conflict, rename-safe replay, and durable deletion identifier constraints.

### Files / review handoff

Key types/functions: `OwnerActor`, `parseOwnerEnrollmentAction`, `parseEncryptedVaultCreateRequest`, `OwnerOperations`, `AuthenticationRepository.approve/deny/revoke/pendingRequests`, `VaultRepository.create/markDeleted/deletions/completeDeletion`, vault admission checks, migration 6.

Changed paths:
- `packages/protocol/src/owner.ts`
- `packages/protocol/src/index.ts`
- `packages/protocol/src/protocol-errors.ts`
- `packages/protocol/tests/owner.test.ts`
- `packages/server-core/src/owner-operations.ts`
- `packages/server-core/src/index.ts`
- `packages/server-core/src/object-service.ts`
- `packages/server-core/src/revision-service.ts`
- `packages/server-core/tests/owner.test.ts`
- `packages/server-core/tests/auth.test.ts`
- `packages/server-core/tests/maintenance.test.ts`
- `packages/server-metadata/src/auth-repository.ts`
- `packages/server-metadata/src/database.ts`
- `packages/server-metadata/src/migrations.ts`
- `packages/server-metadata/src/object-repository.ts`
- `packages/server-metadata/src/revision-repository.ts`
- `packages/server-metadata/src/schema.ts`
- `packages/server-metadata/src/vault-repository.ts`
- `packages/server-metadata/tests/database.test.ts`
- `packages/server-metadata/tests/owner.test.ts`
- `docs/architecture.md`
- `docs/security.md`
- `docs/implementation-progress.md`
