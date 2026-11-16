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

## Permanent deletion worker and terminal client outcome (completed)

### Public contracts / integration

- `ServerMaintenance.cleanupDeleted(): Promise<void>` drains durable pending tombstones. It deletes all published ciphertext in the deleted vault's namespace (including uncataloged objects), then transactionally removes revisions, parent/reference edges, wraps, catalog, upload sessions, creation digests and vault-scoped idempotency results, and finally marks cleanup complete. Failed I/O rejects visibly and leaves the tombstone pending; a new worker/database instance resumes partial cleanup idempotently. Retention and live-vault GC rules are unchanged.
- Tombstones and audit provenance survive forever. An empty identity-only `server_state` row remains (null name/head, sequence zero) because legacy account/device/bootstrap foreign keys reference it; no recovery wrap, history, encrypted content or human-readable vault metadata remains there. This does not make the UUID reusable.
- Storage publication and reclamation share the internal per-vault `withVaultStorage` queue. Object uploads, owner creation/replays and the temporary legacy provisioning route all participate. Tombstoning itself remains synchronous/transactional and never waits on an upload. Cleanup waits for previously admitted writers; transactional upload/publication gates reject after tombstoning. Later writers recheck admission inside the queue, so they cannot write after completed reclamation. Reads recheck admission after awaited storage lookup.
- **Runtime ownership requirement:** reuse the same `Filesystem` instance for request services, owner operations and maintenance (as `runServer` does). The queue coordinates the single serving runtime, not independent server processes. Do not concurrently serve one metadata/storage directory from multiple runtimes; offline maintenance still requires exclusive control. After process restart no prior writer survives, and durable pending cleanup is retried.
- `runServer` starts mandatory, single-flight deletion cleanup immediately and every second, independently of integrity scanning; failures are reported and retried. Shutdown waits for active cleanup before closing metadata. Explicit deletion intentionally bypasses retention only within that deleted namespace. Legacy bootstrap storage has one dedicated unscoped type namespace; newer vaults use UUID namespaces.
- Recovery-wrap requests now return HTTP **410 `VAULT_DELETED`**, matching head/revision/object admission. Provisioning replays cannot recreate tombstoned UUIDs or publish late ciphertext after reclamation.
- `HttpRemote` does not retry deletion and supplies actionable preservation/disconnect/reconnection guidance. `SyncRunner` checks the remote head before journal replay/filesystem application. Watch reports deletion once and rejects terminally (allowing CLI failure exit), rather than polling forever. It does not remove bindings, stored keys, or plaintext. A future command adapter can catch this stable `RemoteError.code` for structured UX.

### Evidence

- Red observed for missing cleanup API, for watch retrying deletion, and for the late-owner-write cleanup race; then green through existing maintenance, request handler, owner service, remote and real-server sync seams.
- Real upload paused before ciphertext publication: tombstone immediately returns 410 on reads; late upload returns 410, cleanup waits and removes its uncataloged bytes, subsequent uploads remain blocked.
- Real revision publication paused during storage validation: cleanup completes first, then publication returns 410 without recreating history.
- Partial cleanup deletes one object then encounters injected disk failure; database reopen plus a fresh worker reclaims the remainder, preserves a second vault with the same object ID, and repeated cleanup is harmless.
- Real server/client watch test preserves unsynced plaintext and stored/caller key material, stops after one terminal error, and observes runtime cleanup completing without an explicit worker invocation.
- `bun test packages/server-metadata packages/server-core packages/server-object-storage packages/sync-core`: **165 passed, 0 failed**.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **249 passed, 0 failed**.

### Review handoff

Key functions: `ServerMaintenance.cleanupDeleted`, `MaintenanceRepository.deletedVaults/finishDeletion`, `withVaultStorage`, `ObjectService.put/putLocked/get/presence`, `OwnerOperations.createVault`, `handleVaultRoute`, `AuthenticationRepository.recoveryWrap`, `mapAuthRepositoryError`, `runServer`, `SyncRunner.run/watch`, `HttpRemote` error handling.

Changed paths:
- `packages/server-core/src/vault-storage.ts`
- `packages/server-core/src/maintenance.ts`
- `packages/server-core/src/object-service.ts`
- `packages/server-core/src/owner-operations.ts`
- `packages/server-core/src/vault-routes.ts`
- `packages/server-core/src/auth-service.ts`
- `packages/server-core/tests/maintenance.test.ts`
- `packages/server-core/tests/owner.test.ts`
- `packages/server-core/tests/server.test.ts`
- `packages/server-core/tests/revisions.test.ts`
- `packages/server-metadata/src/maintenance.ts`
- `packages/server-metadata/src/auth-repository.ts`
- `packages/sync-core/src/remote.ts`
- `packages/sync-core/tests/remote.test.ts`
- `packages/cli/src/server.ts`
- `packages/cli/src/sync-runner.ts`
- `packages/cli/tests/sync.test.ts`
- `docs/implementation-progress.md`

Surface confirmations, new CLI command routing and browser administration remain subsequent steps; this step does not expose a deletion HTTP endpoint or bypass their required confirmation/reauthentication workflows.

## Permanent deletion review fixes (completed)

### Public contracts / operational constraints

- `LocalFilesystem` now reclaims abandoned ciphertext staging during asynchronous initialization, before any public storage operation resolves. Staging unlink and directory fsync failures reject visibly; deletion maintenance cannot report completion through a failed storage initialization. This includes old UUID-only staging files and the two-link staging/publication window interrupted by a crash.
- New staging names include the writer PID. A process-wide active-path registry protects uploads across `LocalFilesystem` instances in the same runtime. A staging owner in another live process (including permission-denied liveness checks) causes initialization to fail with `UNSAFE_PATH`, rather than deleting active bytes or silently reporting reclamation. Continue to require exclusive server-runtime ownership of the directory. PID reuse is conservatively treated as a live owner: resolve exclusive ownership before manually removing that abandoned staging entry. UUID-only staging from the previous implementation is reclaimed under the existing exclusive-startup requirement.
- Object download failures recheck vault admission before integrity marking/transient error mapping. Revision storage validation rechecks admission on both success (including missing references) and failure. A tombstone therefore wins over deletion-induced storage absence: HTTP **410 `VAULT_DELETED`**, not 503 or HTTP 200 `missingObjects`. Ordinary live-vault missing-storage behavior is unchanged.

### Evidence

- Reproduced red through `createServerHandler`: paused download → tombstone/real cleanup → storage `NOT_FOUND` returned 503; paused revision stat → tombstone/cleanup → missing reference returned 200. Both now return 410; an additional paused `existsBatch` race also returns 410.
- Reproduced red with a real subprocess streaming into `LocalFilesystem`: waited for 4096 on-disk ciphertext bytes, SIGKILLed the writer, reopened metadata/storage, and ran deletion maintenance. Previously cleanup completed with staging left behind; now staging is empty when cleanup becomes complete.
- The subprocess regression also verifies a live external writer blocks storage initialization without removing its bytes. Storage regressions verify reopening during an active in-process upload preserves successful completion, and startup removes legacy staging plus interrupted publication hard links without damaging the published object.
- `bun test packages/server-metadata packages/server-core packages/server-object-storage packages/sync-core`: **171 passed, 0 failed**.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **255 passed, 0 failed**.
- `git diff --check`: passed.

### Review handoff

Key functions: `LocalFilesystem.initialize/reclaimAbandonedStaging/putIfAbsent`, `ObjectService.get`, `RevisionService.advance`.

Changed paths:
- `packages/server-object-storage/src/index.ts`
- `packages/server-object-storage/tests/local-filesystem.test.ts`
- `packages/server-core/src/object-service.ts`
- `packages/server-core/src/revision-service.ts`
- `packages/server-core/tests/maintenance.test.ts`
- `packages/server-core/tests/server.test.ts`
- `packages/server-core/tests/revisions.test.ts`
- `docs/implementation-progress.md`

## Permanent deletion follow-up review fixes (completed)

### Public contracts

- `ServerMaintenance.cleanupDeleted(): Promise<void>` now isolates failures per vault and attempts every pending deletion before rejecting with an `AggregateError`. Each contained error identifies the failed UUID and preserves the original cause; the aggregate message includes the failures. Failed vaults remain pending for runtime retries, while successful vaults complete normally. Existing runtime single-flight scheduling and visible failure reporting remain unchanged.
- Remote test setup now awaits the public `LocalFilesystem.list()` readiness boundary before returning. Constructor-started staging recovery therefore finishes before tests can remove their temporary root; production staging error handling is not suppressed or weakened.

### Evidence

- Reproduced cleanup starvation red at the existing maintenance/storage seams with two real metadata tombstones: a failing first namespace left the second pending. Regression now verifies two failed passes still reclaim the second namespace, retain the first ciphertext/tombstone for retry, and complete the first after storage recovery.
- Reproduced the reported asynchronous setup failure before changing setup: focused remote suite **14 passed, 2 failed**, including staging-directory `ENOENT`. After awaiting initialization: **16 passed, 0 failed**.
- `bun test packages/server-core/tests/maintenance.test.ts`: **12 passed, 0 failed**.
- `bun test packages/server-metadata packages/server-core packages/server-object-storage packages/sync-core`: **172 passed, 0 failed**, no unhandled errors.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **256 passed, 0 failed**, no unhandled errors (includes CLI sync preservation/runtime-cleanup tests).
- `git diff --check`: passed.

### Review handoff

Key functions: `ServerMaintenance.cleanupDeleted`, remote test `setup`.

Changed paths:
- `packages/server-core/src/maintenance.ts`
- `packages/server-core/tests/maintenance.test.ts`
- `packages/sync-core/tests/remote.test.ts`
- `docs/implementation-progress.md`

## Opt-in browser authentication and owner API (completed)

### Public contracts / integration

- `ServerConfigInput` / CLI runtime support `webUi` (`--web-ui`), `externalOrigin` (`--external-origin`), and exact-IP `trustedProxyAddresses` (CLI `--trusted-proxy` accepts one address). Browser endpoints and assets return 404 without opt-in. `runServer` wires one shared `OwnerOperations` instance to the same storage instance used by sync and cleanup.
- `ServerDependencies.owner` is required alongside concrete `authentication` when enabled. Optional `adminAssets: AdminAssets` is an explicit pathname → `{body: string | Uint8Array, contentType: string}` map; no implicit filesystem serving, fallback route, or frontend bundle is supplied. Frontend work must inject `/admin` and each asset. Assets receive no-store, nosniff and a restrictive same-origin CSP.
- `BrowserAdministration` handles only `/admin/api`: POST/GET/DELETE `session`, GET `devices` (devices plus pending enrollments/codes), POST `devices/:uuid/approve|deny|revoke` with `{}`, GET/POST `vaults`, POST `vaults/:uuid/rename` with `{name}`, POST `vaults/:uuid/delete` with `{confirmName,password}`, and GET `activity?limit=1..100`. All owner changes use `OwnerOperations` and trusted browser provenance, never client-supplied actors. Encrypted creation keeps the existing strict encrypted owner request/replay contract. Deletion confirms the current exact name after password verification and acknowledges the durable tombstone, not physical cleanup completion.
- Session cookies are `nanosync_admin`, HttpOnly, SameSite=Strict, Path=/admin, Secure for HTTPS; login has no Max-Age/Expires. Tokens and CSRF secrets are random 256-bit values in handler-local memory only. Exact 30-minute idle / 12-hour absolute expiry uses `ServerDependencies.clock`. Logout clears the session and expires its cookie; a fresh handler/restart rejects all old cookies. At most 1,000 sessions are retained; expired sessions are purged on requests.
- Login accepts exactly `{password}` and requires an exact allowed Origin plus a nonempty `X-Nanosync-CSRF` custom header. This is the login-CSRF/preflight defense; no CORS permission is granted. Login/GET session return `csrfToken`, required in that header on authenticated mutations. Foreign/null origins fail; browser routes reject Authorization headers entirely. Browser cookies mint no metadata password/enrollment/device session and cannot authorize any sync/recovery/device endpoint.
- Browser password checks reserve at most five attempts per rolling minute **before** asynchronous verification, shared across login and deletion, including successful attempts. Failures additionally enter the existing persistent account lockout. `AuthenticationService.verifyOwnerPassword` verifies without minting a bearer and rechecks lockout after verification. HTTP 429 includes Retry-After.
- Browser nonloopback HTTP fails regardless of insecure-sync acknowledgement. Trusted proxy addresses require a configured HTTPS external origin; only the actual Bun socket peer (`requestIP`) matches the allowlist. The configured origin is authoritative for trusted peers; no Forwarded/X-Forwarded-* headers are consumed. Proxies must enforce the configured public HTTPS origin and prevent untrusted access via the trusted backend peer. Direct browser requests must use HTTPS or loopback HTTP on a loopback listener and match the configured origin, if any.
- Capabilities require `webAdministration: {enabled:boolean,url?:string}`. URL is emitted only from a validated configured external origin, never request Host or forwarding headers. Enabled without an explicit origin advertises no URL. Protocol parsing strictly rejects unsafe URLs and disabled-with-URL advertisements.
- Removed device-authorized POST `/v1/vaults` and rename mutations (404 after device authentication); GET vault list and recovery-wrap remain device-authorized. Existing device-admin routes retain independent authority/safeguards. The subsequent CLI redesign must remove the now-unusable legacy client create/rename commands; tests now provision through owner browser APIs instead.

### Evidence

- Initial red at `createServerHandler`: enabled browser login returned 404 rather than enforcing login origin/CSRF; implemented the adapter and verified green.
- Focused handler tests cover disabled routes/assets for every method, login CSRF including null/foreign origins, cookie scope/lifetime, logout, restart invalidation, exact idle/absolute expiry, authority separation in both directions, approve/deny/revoke, activity bounds/provenance, spoofed forwarding/Host, explicit proxy peer matching, secure cookies, and password/deletion throttling.
- Five paused asynchronous verifier jobs plus a sixth HTTP login demonstrate pre-verification reservation: sixth returns 429 without entering the verifier. Persistent failure lockout survives a new handler and elapsed memory rate window.
- Real-server CLI integration now creates encrypted owner genesis via `/admin/api`, replays identical ciphertext safely, recovers client keys through retained approved-device recovery access, renames/deletes via owner authority, refuses wrong deletion names/passwords, observes terminal 410 immediately, preserves unrelated vaults, and synchronizes two real replicas. Submitted creation JSON contains neither the plaintext key nor displayed recovery secret.
- `bun test packages/server-core packages/server-metadata packages/protocol`: **121 passed, 0 failed** before final additional parallel/password and capability validation assertions; final checks recorded below.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **260 passed, 0 failed** before the final parallel-password regression; final checks recorded below.

### Review handoff

Key functions/types: `BrowserAdministration`, `AdminAssets`, `AuthenticationService.verifyOwnerPassword`, `createServerConfig`, `createServerHandler`, `startServer`, `parseCapabilityResponse`, `runServer`, `handleVaultRoute`.

Changed paths:
- `packages/server-core/src/browser-admin.ts`
- `packages/server-core/src/auth-service.ts`
- `packages/server-core/src/config.ts`
- `packages/server-core/src/index.ts`
- `packages/server-core/src/vault-routes.ts`
- `packages/server-core/tests/browser.test.ts`
- `packages/protocol/src/envelopes.ts`
- `packages/protocol/tests/protocol.test.ts`
- `packages/cli/src/server.ts`
- `packages/cli/src/main.ts`
- `packages/cli/tests/multi-vault.test.ts`
- `docs/architecture.md`
- `docs/security.md`
- `docs/sync-protocol.md`
- `docs/clients-and-operations.md`
- `docs/implementation-progress.md`

Frontend/Paper UI integration, browser recovery-delivery acknowledgement UI,
and the full client/server CLI redesign remain subsequent steps. No default UI
or Playwright UI coverage is claimed by this backend slice.

Final verification for this step:
- `bun test packages/server-core packages/server-metadata packages/protocol`: **122 passed, 0 failed**.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **261 passed, 0 failed**, no unhandled errors.
- `git diff --check`: passed.
