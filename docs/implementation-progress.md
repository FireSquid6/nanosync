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

## Explicit server/client CLI and resumable enrollment (completed)

### Public contracts / integration

- Replaced the entire command surface with `server init|run`, `server devices view|approve|deny|revoke`, `server vaults view|create|rename|delete`, `server admin` reports; `client connections add|remove|view`, `client vaults connect|disconnect|view`, and `client sync`. No legacy aliases or production bootstrap/legacy credential workflow remains. Historical protocol setup helpers moved to `packages/cli/tests/support/legacy-fixture.ts` solely to retain regression coverage.
- Installed maintained `@inquirer/prompts` **with Bun**, locally in the CLI workspace. Input/password/select/confirm use that library; no production readline/stty implementation. Server directory omission prompts only on an interactive terminal. Non-terminal/`--non-interactive` missing selections fail `INPUT_REQUIRED`; server directories are never silently defaulted. All commands support `--json`, `--non-interactive`, ordinary `--yes`; all nonsecret selections have flags. Secrets use environment/protected files/hidden prompts.
- Stable version-1 JSON contract documented in `packages/cli/README.md`: stdout `{ok:true,code,data}`; stderr errors `{ok:false,code,message,exitCode}`. Exit 0 completed/help, 2 local/input failure, 3 `PENDING_APPROVAL`, 4 `ENROLLMENT_DENIED|ENROLLMENT_EXPIRED`, 5 remote protocol error (codes retained, including `VAULT_DELETED`), 130 interruption. Progress/warnings/instructions/watch events are stderr-only. No normal results contain credentials/recovery material.
- `enrollServer` persists request identity/token/fingerprint in protected `pending/<sha256(canonicalURL)>.json` **before submission**, independent per canonical server. Unique local aliases select connections; hostname-default device names remain owner-visible, separate identities. Resume needs no password, lost responses replay the same request, and existing connections return safe summaries. Terminal states are retained until explicit `--fresh`. Approved credentials are fsynced before pending unlink; retry detects/finishes the save-before-clear interruption window.
- Every enrollment attempt prints the exact `nanosync server devices approve --device-id UUID` plus request-bound verification code to stderr. Local approval/denial uses exact UUID owner authority/provenance and prints the matching code. Capability parsing gates admin links on enabled plus advertised trustworthy URL; no Host-derived fallback. Interactive waits are unbounded **up to request expiry**; scripts default to submit-and-exit; `--wait-ms 0`/finite supported. Transient submission/status/capability failures retry with exponential 250ms–5s backoff within the wait/expiry window. SIGINT aborts in-flight enrollment fetches and preserves pending state.
- `withLocalOwner` adapts local owner operations and validates provisioned pepper rather than inventing a server. Runtime web options are wired through the new command tree. `localAdminReport` now awaits scan/storage initialization before closing metadata (a real closed-database scan regression surfaced during integration).
- Server-local vault creation uses reserved owner genesis and portable encryption/MAC/wrap primitives. Recovery delivery/acknowledgement precedes mutation. Its protected `owner-creation.json` checkpoint stores **only encrypted creation request bytes**, not plaintext keys/secrets, and replays idempotently. Script output is a newly created protected file; normal JSON contains only identity/name. Deletion requires exact name interactively or exact UUID confirmation in scripts, warns about irrecoverability/backups/unsynced clients, and acknowledges tombstone + pending cleanup, never physical reclamation.
- Client connect selects stored server/remote vault, defaults destination to CWD, asks recovery only for an absent local key, confirms nonempty files, and binds without transfer. Sync exclusively discovers a binding (CWD ancestor or `--path`), preserving independent replica journals/locks and terminal deleted-vault propagation. View surfaces omit secrets.
- Remove/disconnect are functional, local-only and file-preserving. Removal refuses attached vaults without force. Forced operations acquire **all affected replica locks before mutation**, and neither yes nor force bypasses active locks. They warn about forgotten credentials versus remote revocation and discarded pending state.

### Explicit next-slice details (step 5)

- Disconnect is deliberately conservative: any user files or existing replica database require `--force`; refine to exact dirty-files/journal detection in the binding/removal safety step. Current commands do not silently discard potentially unsynced work.
- Refine transactional/crash-safe multi-binding removal and key-cache lifecycle. Current removal preflights all locks and preserves files, but record/marker removal is not an all-or-nothing transaction across directories.
- Refine provisioning recovery-delivery crash windows: acknowledged encrypted checkpoints replay safely. A crash after protected recovery file delivery but before checkpoint persistence makes **no server mutation**; retry currently requires explicit inspection/new unused output path. No claim of full provisioning UX/crash-window completion is made here.
- Continue the existing exclusive-runtime storage requirement: stop a serving runtime for offline storage maintenance/provisioning. Browser/runtime operations share the runtime storage instance; local CLI adapters are separate offline storage owners. Browser frontend/Paper UI is a later step, unchanged here.

### Evidence

- Red observed for the absent explicit command tree/missing-directory contract; green after replacement.
- Red observed for `connections view` incorrectly labeling a previously observed denial as pending; terminal status is now durably retained and displayed until explicit fresh.
- New real-server CLI workflows cover lost enrollment response/resume without password, aliases versus device names, exact UUID/code instructions, capability-gated links, independent pending servers, denial/fresh identities, SIGINT/resume, safe existing summary, secret-free results, local owner recovery delivery, connect/no transfer, remove refusal/force, deletion confirmation, terminal deleted-vault sync, and retained local directories.
- Real Python standard-library PTY subprocess test exercises actual Inquirer server-directory/password/confirmation prompts and verifies secret characters do not echo; no custom password handling or skipped terminal test.
- Existing CLI sync tests now use the new command tree and independent binding journals. Foreground watch proves forced disconnect/removal (including yes) refuses a live sync lock and retains the marker.
- `bun test packages/cli`: **44 passed, 0 failed** (includes workspace path matching client-local tests), 458 assertions.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **265 passed, 0 failed**, 1877 assertions, no unhandled errors.
- `git diff --check`: passed. Final rerun after documentation/expiry-bound retry refinement recorded below.

### Review handoff

Key functions/types: `main`, `CliError`, prompt adapters (`text/hidden/choose/acknowledge`), `enrollServer`, `PendingEnrollment`, `pendingEnrollments`, `connectionSummary`, `withLocalOwner`, `provisionLocalVault`, `disconnectConnections`, `secureReplace`, `localAdminReport`.

Changed paths:
- `bun.lock`
- `packages/cli/package.json`
- `packages/cli/README.md`
- `packages/cli/src/main.ts`
- `packages/cli/src/prompts.ts`
- `packages/cli/src/client.ts`
- `packages/cli/src/vault-client.ts`
- `packages/cli/src/local-provision.ts`
- `packages/cli/src/server.ts`
- `packages/cli/src/connections.ts`
- `packages/cli/src/security.ts`
- `packages/cli/tests/command-tree.test.ts`
- `packages/cli/tests/terminal.test.ts`
- `packages/cli/tests/cli.test.ts`
- `packages/cli/tests/multi-vault.test.ts`
- `packages/cli/tests/sync.test.ts`
- `packages/cli/tests/support/legacy-fixture.ts`
- `docs/clients-and-operations.md`
- `docs/implementation-progress.md`

Final refinement: forced detachment discards known journal/cache files while replica ownership is held, and never recursively removes the lock directory after release (which could race a new lock owner). Empty private replica directories may remain for the next safety/cleanup slice. Server initialization provisions the pepper before durable owner initialization so a crash cannot leave an initialized account without its required pepper.

Final verification after expiry-bound retries, documentation, locked cleanup and initialization ordering:
- `bun test packages/cli`: **44 passed, 0 failed**, 458 assertions.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **265 passed, 0 failed**, 1877 assertions; no unhandled errors.
- `git diff --check`: passed.

## CLI enrollment network/cancellation review fixes (completed)

### Public contracts

- Initial password login now receives the enrollment cancellation signal. Ctrl-C during login returns `INTERRUPTED` / exit 130 promptly; it no longer suppresses termination until a stalled login finishes. No enrollment identity exists before successful login, so retry at that stage still needs the password.
- All enrollment HTTP exchanges (including fresh-status validation and login) have a 10-second request timeout. Positive finite `--wait-ms` budgets additionally bound in-flight requests; persisted expiry caps discovery/submission/status requests even during interactive waits. Zero remains bounded submit-and-exit (no polling/retries), not a zero-duration network deadline. Timers are cleared after exchanges; polling/backoff sleeps observe cancellation immediately.
- Post-persistence timeout/outage preserves the exact pending identity and returns pending, or durably records expiry when reached. Before persistence, timeout returns documented `REQUEST_TIMEOUT` / exit 5. Credentials are still saved before pending state is cleared.
- HTTP error classification no longer depends on valid JSON: HTML/empty proxy failures retain their HTTP status and retry eligibility. Protocol JSON codes remain available; arbitrary proxy response bodies are not exposed.

### Evidence

- Reproduced all three reviewer findings red through the public CLI against a real HTTP listener: delayed login took ~806ms despite SIGINT; capability/submission exceeded finite waits by ~800ms; delayed status exceeded 1200ms by ~600ms; HTML 503 returned exit 2 without retry.
- New real-network regressions cover prompt login cancellation, stalled capability/submission/status deadlines, request-expiry cancellation and durable terminal state, and both HTML and empty 503 retries. Resumable state comparisons verify identity/token preservation. Seven new tests pass.
- Updated the existing multi-vault test's two 1ms calls to explicit zero submit-and-exit: they intentionally require submission even when login alone exceeds 1ms; genuinely bounded positive waits can no longer guarantee that.
- `bun test packages/cli`: **51 passed, 0 failed**, 480 assertions.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **272 passed, 0 failed**, 1899 assertions; no unhandled errors.
- `git diff --check`: passed.

### Review handoff

Key functions: `api`, `login`, `enrollServer` (bounded exchange, retry, interruptible pause).

Changed paths:
- `packages/cli/src/client.ts`
- `packages/cli/src/vault-client.ts`
- `packages/cli/tests/enrollment-network.test.ts`
- `packages/cli/tests/multi-vault.test.ts`
- `packages/cli/README.md`
- `docs/implementation-progress.md`

## Safe local binding/removal and recoverable owner provisioning (completed)

### Public contracts

- `LinuxScanner.hasUnsyncedChanges()` is a read-only full inventory/content-hash comparison against applied local entries. It uses the existing no-follow, descriptor-anchored scanner traversal and ignore rules; it detects unscanned additions, removals, renames and file edits without transferring or applying files. Disconnect also checks proposal/restore/hydration intents, unfinished operations/transfers and accepted-versus-applied heads. Synchronized plaintext can now disconnect without force; unsynced work still requires explicit `--force`, never `--yes`.
- `withConnectionRegistry` serializes binding creation/repair/disconnection, forced server removal and CLI sync's discovery-to-replica-lock handoff using the existing process-identity lock implementation. `connectRegisteredVault` revalidates the selected server inside that gate after remote discovery, preventing attachment to forgotten credentials. `removeServerConnection` reads the attachment set and forgets the server under one registry ownership interval. Neither force nor yes bypasses registry ownership.
- Multi-binding disconnection acquires **all** replica locks in connection-UUID order before dirty checks or any binding mutation. Any lock failure releases earlier acquired locks and leaves every marker, binding record and server credential intact. Successful forced removal discards replica journals/cache, preserves plaintext and remote data, and does not revoke remote device authorization. Ordinary disconnection retains cached vault keys for deliberate reconnection. Arbitrary filesystem I/O failures during mutation still report failure; this is not a cross-filesystem atomic transaction or a promise of rollback after power loss.
- `provisionLocalVault` now holds an owner-creation lock and persists encrypted receipts **before** protected output delivery. Script idempotency is the absolute `--recovery-output` path plus the original name: `owner-creations/<sha256(path)>.json` stores encrypted request bytes, delivery phase, output path and a recovery-secret digest, never plaintext secrets or master keys. After output delivery it verifies the protected file before advancing the receipt and publishing. A crash between output creation and delivery checkpoint reuses the original encrypted request after verifying the file. A prepared receipt with no output can safely regenerate unpublished material. Delivered-but-missing/modified/unsafe output fails visibly rather than guessing or provisioning another vault.
- Completed receipts are retained: retry after lost stdout/local completion failure returns the original vault through the existing idempotent owner operation. A different output path deliberately starts a new creation. Interactive creation retains its acknowledged/completed encrypted receipt in `owner-creation.json`; retrying the same name replays it, and a new name can replace a completed interactive receipt. Recovery acknowledgement failure publishes nothing. These receipt files are ordinary encrypted provisioning state, not a secret-retrieval facility.
- Existing owner list/rename/delete operations remain the authority. PTY tests now exercise recovery acknowledgement failure and exact-name deletion, including directory/name/UUID warning visibility and refusal despite `--yes`. Script UUID confirmation remains mandatory. Existing connect/no-transfer/recovery-only-when-key-missing contracts are covered with a second CLI-connected replica and independent journal creation.

### Evidence

- Observed red at the public CLI seam: a fully synchronized plaintext directory still required force. The new unscanned-edit/clean-disconnect regression now passes and preserves file contents throughout.
- Observed red at the public CLI seam: retrying successful owner creation with the same protected output returned failure instead of the original identity. Encrypted receipts now pass retry, failed output delivery, substituted output refusal and actual injected stdout loss **after durable publication**, with exactly one listed vault. Real-server CLI retry then recovers/connects using the original delivered secret.
- CLI regressions cover a locked second replica during multi-binding forced removal (all bindings/credential retained), registry contention (no force/yes bypass), successful removal with retained plaintext and still-authorized remote credential, and remote discovery racing local removal (no dangling new binding).
- Terminal integration uses Python's maintained standard-library `pty`/`subprocess` harness against actual Bun CLI processes and Inquirer prompts, without skips or custom production terminal/password handling. Hidden password tests remain green; added acknowledgement/deletion tests validate observable server results.
- `bun test packages/cli`: **56 passed, 0 failed**, 563 assertions.
- `bun run typecheck`: **all eight packages passed**.
- `bun test`: **277 passed, 0 failed**, 1982 assertions; no unhandled errors.
- `git diff --check`: passed.

### Review handoff

Key functions/types: `LinuxScanner.hasUnsyncedChanges`, `hasUnsyncedWork`, `withConnectionRegistry`, `connectRegisteredVault`, `removeServerConnection`, `disconnectConnections`/`disconnectLocked`, `provisionLocalVault`/encrypted `Receipt`, CLI binding/removal/sync adapters.

Changed paths:
- `packages/linux-client/src/index.ts`
- `packages/cli/src/connections.ts`
- `packages/cli/src/local-provision.ts`
- `packages/cli/src/main.ts`
- `packages/cli/tests/sync.test.ts`
- `packages/cli/tests/local-safety.test.ts`
- `packages/cli/tests/command-tree.test.ts`
- `packages/cli/tests/terminal.test.ts`
- `packages/cli/README.md`
- `docs/implementation-progress.md`

Continue to require exclusive server-runtime ownership for offline provisioning/storage operations, as in prior steps. Browser frontend/Paper UI delivery remains outside this local-workflow slice.
