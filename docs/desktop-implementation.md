# Desktop implementation contract — issue #18, step 1

**Status: design contract with implementation evidence appended below.** Step 1 was technical design only; section 10 records the step 3 extraction. Proposed migration, IPC, status and native integration contracts below are not backend acceptance results.

Requirements authority: [issue #18](https://github.com/FireSquid6/nanosync/issues/18), including its approved design-handoff comment. Visual authority is the **Field Guide**, pinned at [`2efb4794de0384d9e9f7bf97efc3d72020fa6671`](https://github.com/FireSquid6/nanosync/tree/2efb4794de0384d9e9f7bf97efc3d72020fa6671/docs/design/desktop-field-guide): [README](https://github.com/FireSquid6/nanosync/blob/2efb4794de0384d9e9f7bf97efc3d72020fa6671/docs/design/desktop-field-guide/README.md), [DESIGN.md](https://github.com/FireSquid6/nanosync/blob/2efb4794de0384d9e9f7bf97efc3d72020fa6671/docs/design/desktop-field-guide/DESIGN.md), and [REQUIREMENTS.md](https://github.com/FireSquid6/nanosync/blob/2efb4794de0384d9e9f7bf97efc3d72020fa6671/docs/design/desktop-field-guide/REQUIREMENTS.md). Use its Folders list/inspector, Conflicts, Connections, Settings, five-step setup, light/dark tokens, keyboard focus, and non-color statuses. Do not ship preview selectors, simulated responses, sample data, or synthetic diagnostics. Prototype browser checks are not native/backend validation.

Scope is client operation, Linux first, using Electrobun/TypeScript/Bun and existing synchronization, encryption, filesystem and database libraries. No server administration, vault provisioning/deletion, in-app approval, remote-file browser, eviction controls, history/restore UI, merge editor, or updater. Server administration opens externally only when capability discovery advertises a trustworthy URL. macOS/Windows are later validation targets, not supported platforms.

## 1. Inspected baseline and compatibility boundary

Source anchors (relative to repository root):

- `packages/cli/src/main.ts`: actual command tree, defaults, confirmations, output/exit mapping.
- `packages/client-service/src/vault-client.ts`: URL-keyed pending enrollment, registration/token files, vault-key files, retry/approval behavior.
- `packages/client-service/src/connections.ts`: binding records/markers, nonoverlap, registry gate, removal inventory and ordered replica locks.
- `packages/client-service/src/sync-lock.ts`: Linux PID plus `/proc` process-start identity, atomic hardlink lock publication, fail-closed stale recovery.
- `packages/client-service/src/sync-runner.ts`: one-shot/watch orchestration, cancellation, durable replay and conflict reconciliation.
- `packages/client-local/src/index.ts`: FULL-synchronous Bun SQLite journal, heads, proposals, applies, transfers, conflict lineage, ignored identities, plaintext chunk cache.
- `packages/linux-client/src/{index,apply,ignore}.ts`: no-follow filesystem scanning/application and root-local ignore rules.
- `packages/sync-core`: portable cryptography, publication, merging and remote protocol; do not duplicate these in the desktop.
- `packages/cli/README.md`, `packages/client-local/README.md`, `docs/clients-and-operations.md`, `docs/server-ui-and-client-cli-spec.md`, and user guides under `apps/site/content/docs/`: operational and automation context. Earlier exclusions of IPC/status commands describe the shipped baseline, not a restriction on issue #18.

Today the foreground CLI owns synchronization; libraries are not a daemon. A second sync fails on a live replica lock rather than forwarding a request. There is no client settings/status/IPC/notification/diagnostics service. Progress is human text plus transfer counters, not a complete structured status API.

Keep current client command paths, flags, CWD/ancestor selection, independent replicas, protected secret inputs, and headless execution. Existing `--json` version-1 envelopes, streams and exit codes remain stable: success on stdout `{ok:true,code,data}`; errors on stderr `{ok:false,code,message,exitCode}`; progress on stderr. Human mode remains human on stdout, even redirected. Pending/denied/expired enrollment are workflow results, exits 3/4; remote errors exit 5, local/input failures 2, interruption 130. `--json` does not imply noninteractive. `--yes` never abandons unsynced state or bypasses locks. Do not require a desktop process, display, session bus, or keyring for explicitly file-backed CLI use.

The previous redesign's lack of legacy-state migration does not authorize resetting current state for this issue. This design migrates the currently inspected client format only; unrelated older formats remain unsupported. Concurrent old/new executable versions are not supported during a state upgrade: detect incompatible state, fail actionably, and require all clients/owners to stop before upgrading. Never reinterpret incompatible state as empty.

## 2. Operation matrix

“Add” means new shared capability and CLI surface, not an existing command. Names below for additions are the implementation target; document their flags/result schemas when implementing, without changing existing result shapes.

| Existing CLI operation and exact behavior | Desktop counterpart | Shared work / additions |
| --- | --- | --- |
| `client connections add --url --alias --device-name --password-file --wait-ms --fresh` | Connections/setup: URL, alias, device name, password, verification code, wait/retry, explicit fresh after denial/expiry | Extract enrollment with typed events instead of CLI output callbacks. Keep canonical URLs, unique aliases, existing-connection summaries, resumable identity and wait semantics. |
| `client connections view` | Connections and pending enrollment list | Secret-free snapshot; current view is local and does not refresh approval. Explicit resume uses add/enrollment, not a side effect of listing. |
| `client connections remove --server ALIAS_OR_ID --force` | Remove connection, inspect attached folders and acknowledge abandoned state | No remote revocation. Without force refuse attached bindings; force remains subject to registry/replica ownership and preserves files/remote data. |
| `client vaults connect --server --vault NAME_OR_UUID --path --confirm-nonempty --recovery-file` | Choose remote vault, recovery key only if missing, native folder selection, reconciliation warning | Existing path defaults to CWD; destination must already be an owned real directory. Ambiguous vault names fail. No transfers on connect. Keep `--yes` as the current ordinary nonempty confirmation; desktop requires an explicit acknowledgment. |
| `client vaults view` | Folders list, server/vault/local-copy identity | Preserve binding IDs and server aliases; add status via a separate shared status API. |
| `client vaults disconnect --path --force` | Disconnect with pending-work warning and explicit abandonment | Full no-follow inventory/content check, not journal-only. Missing-root forced disconnect uses the original saved path. Preserve marker/identity checks for existing/replacement roots. |
| `client sync --path` | Sync now / explicit first Start syncing | One-shot result remains `{revisionId,sequence}`. Route to current owner, or own a temporary runner if unowned; respect pauses. |
| `client sync --path --watch` | Start continuous syncing | CLI remains foreground; existing owner receives a continuous-work request. CLI watches shared progress until interrupted; detaching does not stop a different process's owner. |
| No status command | Folder phase/progress, last success, owner, blocked/error detail | Add `client status [--path]`: secret-free snapshot, including stale/unknown observations. |
| No pause command | Independent global and folder pause/resume | Add `client pause` / `client resume`, requiring exactly `--all` or `--path`; persist separate flags. |
| Conflict copies/journal exist, no CLI controls | Persistent conflicts, open containing folder, manual resolution instructions | Add `client conflicts view [--path]`; no acknowledge-to-clear shortcut. Resolution is manual filesystem editing/removal and subsequent successful sync/manifest reconciliation. |
| Manual `.nanosyncignore`; no CLI editor/validator | Edit ignore rules, validate then save | Add `client ignores view\|validate\|set --path`, with protected/coordinated file input for set and validation-only input for validate. Same parser and safeguards; no pattern builder. |
| No open-folder command | Open local folder/conflict location in system file manager | Add `client open --path`; use native adapter without shell interpolation. On headless systems return actionable unsupported-integration error; ordinary sync still works. |
| No settings command | General/notification settings | Add `client settings view\|set` for the same typed settings, including startup/tray/background and notification categories; native effects report unsupported/unavailable separately from persisted intent. |
| No credential-mode command | Explicit migration/unlock decision | Add `client credentials view\|migrate`; unlock is a platform interaction, with locked status/errors exposed to both clients. No secret values in command arguments/results. |
| No client diagnostics (server admin diagnostics is distinct) | Explicit diagnostics export | Add `client diagnostics export`; same allowlisted redacted report. |

Native notifications have no headless delivery requirement: their shared category settings, actionable status and diagnostics are accessible in CLI. Native window/tray controls are desktop lifecycle, not a requirement to launch windows from every CLI operation. Library-only `repairConnection`, history, restore and hydration are not shipped client commands; this step does not invent new UI/CLI features for them.

## 3. Shared client boundary and state

Orchestration is extracted from CLI into `packages/client-service`, depending on `sync-core`, `client-local`, `linux-client` and existing safety helpers. CLI retains prompting, command parsing and presentation; Electrobun's trusted main process retains native adapters and renderer RPC. Neither presentation layer writes SQLite, credential files, markers or settings directly. `client-local` remains a journal, not a credential database or native UI library. Keep headless modules free of Electrobun/native-store imports until that mode is requested.

Use existing identities unchanged:

- **Server connection:** local UUID `serverId`, canonical URL, alias (`ServerRegistration.name` today), device UUID, credential reference/mode. The local serverId is not an advertised remote server identity.
- **Binding/local copy:** UUID `connectionId`, canonical absolute root, serverId/vaultId/deviceId; root `.nanosync` marker `{version:1,connectionId}`. Multiple copies of one vault have distinct IDs/journals. Roots cannot overlap one another or private state.
- **Replica:** `replicas/<connectionId>` journal/cache/lock. Never share a journal based only on vault ID.
- **Pending enrollment:** canonical URL identity, alias, device ID/name, fingerprint, expiry and last terminal state; its token is secret. Persist identity before enrollment submission, approved credential before pending removal. Password and recovery input are transient only.

Keep `--client-dir` (default `~/.nanosync`) authoritative for both interfaces. Share registrations, bindings, credential mode, settings and journal-derived status there; no separate desktop account/state silo. Private directories stay owned real 0700; sensitive files/SQLite sidecars remain checked regular 0600 with no symlink/hardlink substitutions. A versioned secret-free settings record is atomically replaced/fsynced under the registry gate, with a monotonic revision for compare-and-set updates. Concurrent edits refresh/retry rather than overwrite unrelated values. New state schemas must be transactional or explicitly resumable; keep current marker/journal contracts unless a versioned upgrade is necessary.

### Settings and start intent

- `globalPaused=false`; `bindingPaused[connectionId]=false`. Effective pause is their OR. Resume global never clears a binding pause. Persist before acknowledging; owner reports `pausing` until a safe boundary, then `paused`. Block new scans/publications/downloads/applies in both directions, while finishing already-started filesystem operations safely. Local editing remains unrestricted. Recovery barriers remain durable while paused.
- `continuousRequested[connectionId]=false` for a newly connected binding; connect does not transfer or enqueue a sync. Explicit desktop Start or CLI watch sets continuous intent; CLI one-shot explicitly transfers but does not enable continuous startup. Restart desktop continuous work only for desktop-managed bindings with explicit start intent, never every known binding. Do not automatically take over a previously CLI-owned watch after a crash.
- `startAtLogin=false`, `trayEnabled` explicitly selected during onboarding, `keepSyncingAfterClose=true`. Ask all lifecycle choices. Absence of a tray choice is not permission to enable an integration silently.
- Notifications: global enable and independent conflict/revoked-access/persistent-failure categories; notification filename/path display defaults off. Persist category choices independent of the global switch. No successful-sync or brief-outage category.

Settings intent is distinct from runtime availability (e.g. tray requested but unavailable, startup registration failed). Show both and an actionable error; never claim an OS integration was installed merely because a checkbox saved. Headless CLI can inspect/set shared intent; requesting unavailable native effects must not create a broken desktop dependency for sync.

### Status and errors

A shared snapshot contains settings revision, observation time, connections/pending summaries, and per-binding identity, owner kind/instance, effective pause and its causes, phase, progress, observed/accepted/applied heads, last remote check, last successful sync, unresolved conflict count and actionable errors. Paths are needed in an authorized local UI/status command, but not in notifications/diagnostics by default. Never include credentials, vault keys, passwords, recovery material or arbitrary raw HTTP/error bodies.

Expose facts independently, not one lossy enum: phase (`not-started`, `idle`, `syncing`, `pausing`, `paused`, `offline`, `credentials-locked`, `folder-unavailable`, `failed`), conflict/error attention, and owner. A paused folder may still have conflicts or revoked access. Progress uses actual completed transfer bytes/objects and engine phase; unknown totals are indeterminate, not a fabricated percentage.

**Up to date** is derived only after a completed verified pass: all observed local changes published, latest checked remote state applied, no pending transfer/apply/proposal/reconciliation work and no open conflicts. It is not proof against changes after the observation. A local edit/new remote observation invalidates it; stale or unknown observations must be labeled. Existing `syncOnce()` can return with conflict copies, so its success/result alone is insufficient. Last successful sync is persisted separately from current health and not reset to “now” on reopening.

Missing roots stop that binding and preserve its journal. Retry revalidates the original path/marker and filesystem safety, never recreates the root or treats absence as an empty inventory. Replacement roots/symlinks are not accepted automatically. `VAULT_DELETED` stops sync and preserves files/cached keys; revocation is actionable authorization failure, not file deletion. Brief network failure is offline/retryable, not automatically red. Overall/tray green means no intervention needed (including normal work/pause/brief offline); actionable failure or unresolved conflicts means red with distinct badge/shape and status text.

Shared errors carry stable code, scope (global/server/binding), retryability, safe message and recovery action; optional structured details are allowlisted. Preserve current protocol codes and CLI mappings. Add explicit local codes for locked/unavailable credentials, migration pending, unavailable folder, owner unavailable/incompatible, paused work and unavailable native integration; document their local exit mapping (2) before shipping. Do not map a new local error to remote exit 5 merely because it blocks network activity. CLI output adapters preserve existing enrollment workflow results and exit 130 cancellation. No secrets in exceptions sent to the renderer or serialized logs.

Conflicts remain open while live applied-manifest entries have conflict lineage (`ClientLocal.reconcileConflicts`); a local acknowledgment must not resolve them. List preserved copies persistently, explain manual resolution, and open their containing folders. Both versions stay available until the user deliberately changes files; sync is the authority for resolved status, not a prototype button.

Ignore validation reuses `IgnoreRules`, not another glob dialect. Extract a pure text-parse seam for validation-before-write, retaining safe-file checks and the 64 KiB/UTF-8 limit. Preserve exclusions-only syntax, root-local scope, reserved control files, ignored-entry markers, and fail-closed unignore/rename/recovery semantics. To save, coordinate a safe owner boundary, recheck expected file signature, validate, fsync staged file, atomically replace/fsync directory and resume only previously requested work. Reject save during incompatible interrupted apply; explain how to restore its original rules. Neither editing nor unignoring silently deletes/reconciles data.

## 4. Ownership, authenticated IPC and removal

No mandatory always-on daemon: each CLI watch or desktop trusted main process can host an owner; a CLI one-shot can host temporarily. An owner holds the existing replica `.sync-owner` lock through the runner's complete stop/close/key cleanup. Registry mutation and acquisition remain serialized by the registry gate; multi-binding mutation acquires replica locks in UUID order. PID alone, heartbeat timeout or failed IPC never proves death. Existing `/proc` start-time checks remain authoritative on Linux; permission/identity uncertainty fails closed.

Proposed Linux control transport: Unix-domain sockets in a validated per-user 0700 runtime directory, socket access restricted to the user. Endpoint discovery is secret-free metadata keyed by canonical client-state identity, owner instance nonce and process identity; it is not ownership authority. Authenticate requests with a per-owner random capability stored in checked 0600 private state; validate ownership, permissions and identity of the socket and its containing directory before connecting. Verify OS peer credentials where the runtime exposes them. These checks authorize the same-user client boundary, not arbitrary local callers. The capability is control-only, not a device token or vault key; never pass it through renderer RPC, argv, logs or exports. Missing peer-credential APIs do not justify unauthenticated localhost HTTP: private socket discovery and capability checks remain mandatory and require adversarial integration tests. No new application TCP sync-owner control listener or browser-accessible owner API. Electrobun's existing renderer bridge is a distinct, per-view authenticated/encrypted loopback WebSocket transport; the [validated SDK prerequisite](desktop-sdk-security.md) records its limits and source patches. Do not describe all application IPC as Unix-only.

Only same-user authorized clients are in scope; root or a compromised same-user process able to read private state is not isolated by a bearer capability. Do not claim otherwise. Authenticate before dispatch, version the protocol, bound frame sizes/queues, validate operation schemas/IDs and authorize operations against that endpoint's client root and bindings. No arbitrary SQL, filesystem read, shell execution, credential export or unrestricted native calls. Secret enrollment/recovery input may cross the trusted private client boundary only for the requested operation and is never echoed; synchronization forwarding uses credential references, not keys in IPC responses.

The renderer loads packaged local content only; deny remote navigation, embedded admin pages and untrusted script injection. Its narrow Electrobun RPC exposes typed client requests, sanitized snapshots and approved native actions. Main revalidates every payload, resolves binding IDs to checked paths, and constrains external URLs to advertised/validated HTTP(S) administration links. Never expose a generic main-process execution bridge. Sensitive input stays transient and is cleared from forms; JavaScript zeroization is best effort, not a memory-erasure guarantee.

Request rules:

1. Under registry serialization discover and validate binding/owner. If unowned, acquire replica lock before constructing `ClientLocal`/runner; advertise control only after initialization. Release registry gate before awaiting network/IPC work.
2. If live-owned, send authenticated request to that owner; never open a competing writable journal. Concurrent one-shot requests coalesce/serialize using the runner, returning its head result. Continuous requests are accepted by the current owner without changing its ownership origin. Shared pauses block work even for explicit sync requests, with an actionable paused result/error rather than a false success.
3. Mutations carry request ID and expected state revision/identity; retries return a recorded outcome or re-evaluate safely. Lost reply is unknown outcome, not authorization to run locally. Subscribers reconnect by fetching a fresh snapshot; bounded events are hints, not durable truth.
4. A live owner with unavailable/incompatible IPC yields actionable “owner unavailable; stop/retry with compatible client.” Do not steal its lock, kill by PID, or let force bypass it. Stale endpoints are removed only after definitive identity death and checked endpoint identity; normal lock recovery then permits a new owner.
5. Ownership handoff, when needed for disconnect/removal, is stop-at-safe-boundary and release, then acquire/revalidate under the registry gate. A new contender winning means retry/fail without mutation, not lock bypass. No implicit transfer of independently CLI-owned work to desktop ownership.

Removal first inspects all affected bindings and pending filesystem/journal work. Desktop must explicitly ask to stop an external CLI owner before removal; never stop it as an incidental list/quit action. After coordinated stop, acquire all locks and recheck inventory, identities and confirmation under the same safety gate. `--force`/desktop abandonment acknowledgment discards sync state only; `--yes` cannot substitute. A contended lock leaves all bindings intact. Current multi-binding disconnect is lock-safe but not a cross-file transaction: implement a durable secret-free removal intent/replay for partial filesystem failure/crash, keeping enough original binding identity to finish safely. Preserve files and remote data throughout; don't mistake a partially removed marker for an unbound directory to rescan.

Connection removal must include credential-provider cleanup without remotely revoking. Baseline `removeServerConnection` removes registration but does not delete the separate vault-key files; do not describe it as a complete key wipe. Implement deliberate provider cleanup/retry for removed credentials, never remove keys used by another server connection, and do not promise forensic erasure from backups or storage media.

### Quit and ownership origin

Owner kind is the process that acquired the lock (`desktop` or independent `cli`), not the interface issuing the latest request. Display external ownership even when idle/paused. Desktop Quit stops only its own runners: disallow new work, cancel in-flight remote requests, let filesystem operations reach recoverable boundaries, await runner stop/DB close, then release locks/endpoints and exit. Never release a lock while the runner still writes. A failed shutdown must not report completed safe stop prematurely. Independently CLI-owned work survives; shared global/folder pauses still affect it.

Closing with keep-syncing on hides the window even without a tray; launcher reopening shows the existing desktop instance. With it off, close performs desktop Quit. User-login startup is opt-in: hidden if keep-syncing on, visible if off. No pre-login service and no desktop-owned sync after logout; integrate session shutdown, with durable crash recovery as fallback. Tray is status plus reopen only: primary activation where supported, otherwise Linux menu containing only **Open Nanosync**. No tray pause/quit actions. Unavailable/disabled tray never prevents syncing or reopening via launcher.

## 5. Credential modes and crash-safe migration

Current credentials are protected files, **not OS-store-backed or encrypted-at-rest by Nanosync**: `servers/<serverId>.json` includes the token, `keys/<serverId>-<vaultId>.json` includes a hex master key, and `pending/<URL hash>.json` includes the enrollment token. Mode 0600/0700 protects access, not disk theft. The plaintext chunk cache is also private, not a secret store. Never put tokens/keys into `ClientLocal` or diagnostics.

Introduce one explicit credential-mode descriptor per client root: `protected-file` or `os-store`, schema/generation, and opaque provider references. Existing current-format roots are identified as file-backed without conversion. New desktop-managed state chooses OS store. CLI-created/headless roots must have an explicitly selected protected-file mode (add a non-secret credential-mode selection to creation); existing file-backed CLI usage continues without a display/keyring. New mode selection must not change existing commands' meaning or auto-migrate current roots.

Linux OS-store target is the user-session Secret Service, shared by CLI and desktop via the same service namespace and client-root identity. The Linux adapter uses the platform Bun.secrets API backed by maintained libsecret. Native rejection or a required recorded reference returning null is conservatively `CREDENTIALS_UNAVAILABLE` with unlock/session guidance; do not claim precise locked/missing/denied classification. Invalid token/key encoding is a state error. Locked/unavailable state blocks secret-dependent work with unlock/session guidance, no plaintext fallback or duplicate secret cache. Non-secret listings/settings remain available. Credentials already loaded by a running owner require an explicit lock policy in adapter integration; do not claim a keyring lock zeroizes process memory. Retain no account password/recovery input; store only required device/enrollment credentials and vault master keys. macOS Keychain/Windows credential adapters are later work.

Opening file-backed state in desktop presents: **leave unchanged and continue using CLI**, or **explicitly migrate this entire root to OS store**, explaining that unattended/headless CLI access will then need the unlocked user session. No syncing or enrollment from desktop against file-backed state before that decision. Cancel is non-mutating. Reverse migration to protected files is deferred; it is not required for the forward credential-mode slice and is never an automatic recovery action.

A filesystem and credential store have no common atomic transaction. Migration therefore uses a durable phase journal, blocks all secret use while incomplete, and permits only explicit, temporary staging duplication needed for crash safety—not two active modes:

1. Show affected root, mode, pending identities and headless implications; obtain explicit confirmation. Stop all owners with consent. Under registry gate and all replica locks, reject concurrent mutations; set a durable migration barrier checked by every new shared-service command. Never migrate around a live older executable.
2. Inventory/validate source credentials and metadata, preserving server/device/binding IDs, pending fingerprints/expiry and journal state. Write/fsync a secret-free migration intent with source/target generation, opaque item IDs and phase. Source remains authoritative but blocked for normal use.
3. Write target-generation secrets idempotently, read back/compare in memory, and verify every required item before recording target-ready. Store no values or secret digests in the journal. Failure/locked store retains source and barrier; explicit retry resumes the same generation. Before source cleanup, explicit rollback can remove staged target items and retain original mode.
4. Durably record cleanup intent, then remove source secret-bearing files/items and replace mixed registration/pending files with verified secret-free metadata, fsyncing each filesystem change. Keep target metadata/identities recoverable in the journal. From this phase roll forward only: never delete verified target secrets to roll back a partly removed source.
5. Verify source cleanup, atomically publish/fsync the target-mode descriptor, mark complete, then release barrier/locks. New normal operations resolve only the committed provider. A crash before final commit resumes under the barrier; a crash after commit with a leftover journal performs idempotent final cleanup, never falls back to source.

An unavailable target during cleanup/commit keeps migration blocked until it can be verified; do not invent replacement credentials or discard pending enrollment. Any staged-entry rollback deletion failure also keeps migration blocked until verified cleanup succeeds. Test crashes before/after each durable transition, partial source deletion, target-entry loss, locked store and cleanup failure. Temporary duplicate staging must be disclosed in migration UX and never silently left as a working fallback. Old backups/storage remnants cannot be guaranteed erased. No recovery-key re-entry or fresh enrollment should be required merely because migration was interrupted.

## 6. Notifications and diagnostics

Owners record durable actionable state; the desktop delivers notifications without competing sync writers. Deduplicate by binding, category and stable incident identity, not changing error text; persist delivery/dismissal state so reconnect/restart doesn't spam. Use fake clocks for the persistent-failure threshold (define the actual threshold during implementation). Brief outages and normal success never alert. Global/category disable affects delivery, not visible conflict/error status. Default bodies omit filenames/paths; secrets and content are never allowed even with path display enabled.

Diagnostics export is explicit in both interfaces: allowlist application/runtime/platform versions, schema versions, aggregate work/conflict counts, sanitized codes, owner kinds and integration availability. Default excludes filenames, paths, URLs/aliases/device names that may carry identifying content, credentials, keys, recovery material, file contents and raw logs/DB dumps. Do not offer an unrequested sensitive full-state export. Generate through the shared service with the same redaction, write safely to the selected destination, and report failures instead of silently producing an incomplete report.

## 7. Implementation sequence

Each completed step is verified, committed and pushed separately. Stop on a blocking prerequisite rather than claiming unvalidated completion.

1. **Shared contract (this document):** audit existing operations and define state, ownership, credentials and verification. Documentation only.
2. **Linux toolkit gate:** pin Electrobun; prove packaged Bun SQLite, Secret Service, native folder/browser opening, basic window/tray behavior and project-local Nix tooling. Record actual evidence before treating the toolkit as proven.
3. **Shared client extraction:** move reusable orchestration out of CLI without changing commands, JSON, exits or headless behavior; retain existing engine, journal and filesystem safety.
4. **Credential modes:** explicit OS-store/protected-file selection, adapter, resumable migration barrier/journal and secret-free snapshots; retain headless workflow.
5. **Ownership and secure control:** authenticated private IPC, single-writer routing, owner origin, safe shutdown, stale-owner recovery and independent CLI survival.
6. **Durable status and pauses:** separate global/folder flags, safe checkpoints, precise observed-state status/progress, missing-root safety and interrupted-work recovery.
7. **Terminal-free onboarding:** real enrollment/resume, vault/key/folder selection, nonempty warning, connect without transfer, explicit Start and lifecycle preferences.
8. **Connected-folders interface:** approved Field Guide light/dark UI backed by shared status/settings; multiple copies, ownership, errors, pauses and folder opening.
9. **Conflicts, ignores and removal:** persistent manual conflict workflow, coordinated validated ignore edits, dirty-state confirmation and durable file-preserving removal.
10. **Desktop lifecycle:** login/close/Quit/logout, singleton launcher, tray status/reopen fallback and operation without a tray.
11. **Notifications, diagnostics and parity:** category controls, persistent-failure/deduplication policy, privacy-safe exports and all remaining CLI equivalents.
12. **Packaging and release validation:** distributable Linux/Nix packages without updater, automated integration gates and recorded real desktop/keyboard smoke checks; open the pull request only after completion.

Each stage includes its focused tests; do not defer ownership, credential or recovery safety until UI completion. Implementation stages may be refined by observed runtime constraints, not expanded into new feature scope.

## 8. Requirement-to-verification mapping (planned, not executed)

Use existing Bun integration seams in `packages/cli/tests/{command-tree,cli,terminal,human-terminal,connections,local-safety,multi-vault,sync,enrollment-network}.test.ts`, `packages/client-local/tests/local.test.ts`, and `packages/linux-client/tests/{scanner,apply,ignore}.test.ts`; add service tests for the new shared boundary and desktop/native checks. These are test locations to extend, not evidence that new requirements pass. Use barriers, injected clocks/timers/network/store adapters and crash checkpoints; no sleep-based correctness/deadline assertions.

| Issue #18 acceptance requirement | Required evidence |
| --- | --- |
| Terminal-free onboarding/daily client use, external server administration | Real service-backed UI flow: URL/auth, verification/wait/denial/expiry, external advertised admin only, vault/recovery/folder, nonempty acknowledgment, finish without sync and explicit Start; keyboard-only native smoke. |
| Existing operations available in desktop; additions have CLI equivalents | Exercise every operation-matrix row through CLI and service-backed desktop; golden existing JSON/streams/exits/defaults; noninteractive secret-file/env and no-desktop headless cases. |
| Shared connections/bindings; multiple copies safe | Mutate through each adapter and refresh the other; multi-server/vault/copy tests with independent journals; reject overlap/copied marker/unsafe paths; concurrent settings updates preserve unrelated fields. |
| Single active writer under concurrent CLI/desktop | Multi-process barriers at acquisition/advertisement/shutdown; route/coalesce sync, authenticate/version IPC, reject unsafe socket ownership, wrong capability and malformed operations; fail closed on inaccessible live owner, recover definitively dead owner, preserve process-start identity/PID-reuse checks. |
| Desktop Quit leaves independent CLI sync | Start owners in both origins, route cross-interface requests, quit desktop during network/apply work; verify CLI owner continues and desktop locks release only after safe shutdown. |
| Enrollment resumes across interruption/restart | Lost submission/approval reply, cancellation, transient network/429/5xx, finite/zero waits, denial/expiry/fresh tests; compare exact persisted identity, fingerprint and token reference; no retained password. |
| Nonempty folders require acknowledgment and explicit start | Connect populates only binding metadata; no file transfer or deletion; preserve local/remote contents on first reconciliation; opening/restarting desktop does not start never-started binding. |
| Separate durable global/folder pause | Restart both adapters; global resume leaves individual pause; active apply reaches safe boundary; neither direction starts new work; CLI one-shot cannot bypass pause; editing files remains possible. |
| Interrupted sync recovery; missing roots never delete contents | Crash checkpoints around proposals/advance/apply/reconciliation/removal; reopen with exact intent; remove/rename/replace root mid-pass and before restart; no mass remote deletion, no automatic root recreation; explicit retry/disconnect. |
| Conflicts persistent and both versions accessible | Divergent replica edits, restart, inspect via both interfaces, open preserved copies, manual resolution + sync; acknowledgment alone cannot clear lineage. |
| Ignore validation and no implicit deletion | Shared parser cases/unsafe control files, save-vs-active-apply race, signature change, tracked ignored/unignored/renamed paths; invalid save leaves original rules and files untouched. |
| Disconnect pending work explicit and files preserved | Unscanned content edits, pending journals, missing root, attached server removal, force/yes distinctions, external owner contention, crash/partial removal replay; preserve every local file/remote datum. |
| Locked/unavailable store actionable; headless mode usable | Store adapter locked/absent/denied/missing cases, no fallback; all migration checkpoints/cleanup failures/rollback cutoff; exact pending identity retained; CLI file mode with no display/session bus; ordinary output/state/export secret scans. |
| Close/Quit/login/tray-disabled/reopen behavior | Native matrix: keep-on/off × login-on/off × tray-on/off/unavailable; singleton launcher, startup hidden/visible, session logout stop, independent CLI ownership. |
| Tray non-color distinction and Linux menu fallback | Real direct-activation and AppIndicator/menu-only backend checks; only Open Nanosync action, status text/badges, no pause/quit; absent tray does not block operation. |
| Category notification settings and privacy-safe diagnostics | Fake-clock persistent failures, restart dedupe, all category/global combinations; secret/path/filename sentinels absent from default notification/export/log/RPC errors; real desktop notification delivery separately. |
| Deterministic automation covers shared/recovery safety | Service/CLI integration tests above using explicit synchronization and fake clocks; current crypto/protocol/SQLite/fs regressions remain gates. |
| Real Linux desktop smoke | Record distribution/session/compositor, Electrobun/Bun version, SQLite/runtime deps, tray backend, Secret Service lock/unlock, keyboard onboarding, lifecycle/reopening/logout and installed package/Nix behavior. No platform claim from mocked tests alone. |

## 9. Unresolved design/runtime blockers

- Step 2 pins Electrobun 2.0.6 and records scoped Linux runtime evidence in `desktop-linux-validation.md`. Full packaged lifecycle, launcher singleton/reopen, logout and the supported-environment matrix still need release validation.
- Private socket/capability transport and runtime peer-credential support need implementation and adversarial tests; filesystem permissions alone are not the specified authenticated transport. No control interface should ship without validated authentication.
- Step 4 chooses Bun.secrets/libsecret on Linux with conservative unavailable errors, generation/reference validation and resumable forward migration. The API is experimental and pinned-runtime regression coverage remains required; never claim multi-resource atomicity or physical erasure.
- Safe pause checkpoints and durable multi-binding removal still need implementation and fault-injection tests. Step 4 covers credential migration recovery; current runner cancellation and locks are not an implemented pause/IPC protocol.
- Exact new CLI flag/result schemas, structured progress instrumentation and persistent-failure notification threshold must be finalized with their implementation tests; the existing command contracts cannot be changed to simplify this work.
- Linux tray backends, notification delivery, login registration, package/Nix runtime closure and keyboard-only onboarding remain native validation work. macOS/Windows remain unsupported until separately validated.

The original step 1 checked off no runtime acceptance criteria. Subsequent step 2 evidence and step 4 implementation notes below are explicitly scoped; they do not validate unfinished desktop behavior.


## 10. Step 3 — shared client extraction evidence

Extracted existing client orchestration into `packages/client-service`: HTTP/enrollment,
protected-file state, bindings, replica locks and the existing sync runner. Security and
lock helpers are unchanged; binding safety logic only changes its shared error import.
`startBoundSync` preserves the existing registry revalidation, key-copy/zeroization and
runner ownership ordering. Enrollment and sync expose optional typed callbacks; CLI
adapters retain existing human messages, JSON streams and exit mappings. Prompts,
signal handling, command defaults and presentation remain in CLI. Direct callers/tests
now import the shared package; `bun.lock` and generated `build/nix/bun.nix` include it.

Actual verification for this extraction:

- Focused service/event-adapter tests: **7 passed**, using request barriers rather than
  sleeps; cover silent/secret-free enrollment, resumable approval, cancellation,
  missing keys, device mismatch, specific live-owner lock refusal, stop/reacquisition,
  shared error identity and existing presentation strings.
- Existing focused CLI/service regression selection: **56 passed** before the final
  additional focused cases; final `bun test`: **343 passed, 0 failed** across 38 files.
- `bun run typecheck`: passed for all workspaces and build/browser tooling.
- `bun run --cwd apps/desktop typecheck:native`: passed.
- `bun run test:browser`: **7 passed** (existing browser suite).
- `bun run build:binary`: passed.
- Regenerated Nix dependency expression with the pinned bun2nix tool;
  `nix build path:. --no-link`: passed, including the new workspace. Explicit path input
  includes the not-yet-staged extraction files without changing the parent's index.
- Scoped codehygiene executed via Nix-provided Python/NumPy. Readability fixes were
  limited to new code; remaining warnings are a protocol-fixture naming false positive
  and long expected/output literals retained to preserve the existing CLI text.

No IPC, credential modes/migration, pauses, durable status or desktop product UI is
implemented by step 3. File-backed secrets remain trusted-process APIs, not renderer
payloads; sync completion events are not a durable “up to date” status. Existing removal
crash/credential-cleanup limitations remain unchanged. This evidence does not complete
issue #18 backend/native acceptance.


## Step 4 implementation boundary

The shared service now supports explicit protected-file/OS-store initialization,
secret-free listings, asynchronous secret access, forward migration/resume/rollback,
and retryable credential cleanup. See `packages/cli/README.md#credential-storage-linux`
for actual commands, explicit confirmations, initial-write retry flags and limitations.
Reverse migration, IPC, settings and renderer/native onboarding are not implemented.
The trusted desktop entry seam is `desktopCredentials` plus explicit
`initializeCredentials(root, 'os-store')`; file mode returns decision-required.

`Bun.secrets` 1.4.4+38afee6c8 was inspected against official pinned runtime source and
probed using disposable namespaced items. Native get/set/update/delete roundtrips
passed with packaged Bun and Nix Bun with discoverable libsecret/GLib. A private bus
and temporary HOME/XDG keyring showed locked get=null and delete=false while its own
item still existed; missing bus produced ERR_SECRETS_PLATFORM_ERROR. No user keyring
was locked or existing credentials inspected. Therefore required null/native failure
blocks with actionable local exit 2, never fallback or implicit re-enrollment.

Deletion after durable authorization uses a non-secret write/read/delete(true)/
read(null) marker protocol, including replay against already-absent entries. Staged
rollback may destroy only the target generation before cleanup intent; after intent,
only verified target data permits forward source cleanup. This covers application
entries in the default collection, not externally moved/duplicated entries. Already
running sync owners retain loaded credentials until stop. Native calls have no exposed
cancellation; JS-memory erasure, immediate lock revocation and forensic erasure are
not claimed. Network polling does not retain the registry gate: a separate process-
identity credential-operation lease prevents migration/removal racing enrollment.

## Step 5 — single-owner sessions and private control

`openBoundSync(root, from, {origin, instanceId, onEvent, ...credentialOptions})`
returns `{owner, syncOnce, watch, close}`. CLI sync now uses this API. Acquisition
and credential loading stay under the credential registry; attachment reads no
credentials, opens no journal, and releases the registry before IPC. The existing
replica `.sync-owner` PID/starttime lock remains the sole authority. Its checked
read-only `observeSyncLock` uses the same Linux identity/parser checks as acquisition,
not a timeout or a second stale-owner algorithm. Direct engine/legacy
`startBoundSync` callers remain exclusive, non-advertising owners; attachment to
these live owners fails closed rather than opening another writer.

Owner origin/instance are fixed at acquisition. `stopOwnedSync(instanceId)` stops
only this process's matching **desktop** hosts. Session close/CLI SIGINT detaches
an attached client, never its external owner. A hosted close cancels work, awaits
the active pass and database/key cleanup, then releases the lock and awaits graceful control shutdown (incomplete request readers are cancelled). A watcher-close
failure still waits for active work and deliberately retains ownership; uncertain
shutdown is not reported as a safe stop. Discovery missing/replaced during normal
cleanup does not prevent stopping the host transport or delete another owner's
record. Completed authenticated forwarding remains valid if the temporary host
releases before the client consumes its reply.

Any owner not already in a hosted continuous watch refuses incoming watches with
an actionable `OWNER_TEMPORARY`, including a desktop-origin Sync Now session.
Retry explicitly after release, or have the owner explicitly call hosted
`session.watch` (desktop Start/CLI watch). An incoming request never creates a
detached watch or changes origin/lifetime. Attached watches never auto-promote
on intentional stop, crash, lost reply, or unavailable control. The explicit
`stopBoundSyncForRemoval` consent hook stops an authorized owner at its safe
boundary and checks release. It is **not** called by Quit/list/force commands;
removal must still acquire locks and revalidate inventory and identities normally.

### Linux transport boundary

Bun 1.4.4 `Bun.serve({unix})` / `fetch({unix})` was runtime-probed with a real
Unix socket and is exercised across real child processes. There is no TCP control
listener, desktop dependency, FFI or peer-UID API requirement. The runtime root is
strictly owned/real 0700: `/run/user/UID/nanosync` for the standard validated XDG
session, otherwise `/tmp/nanosync-UID` (a supplied nonstandard XDG directory is
validated before using the private fallback). Discovery selects only these two
fixed locations, never an arbitrary socket path, and records the selected base's
filesystem identity. Owner and reader may have different XDG environments.
Each owner gets a random private instance directory, a 0600 socket, and a separate
checked 0600 single-link random 256-bit capability. Secret-free replica discovery
ties canonical client root/root filesystem identity, binding, acquiring
origin/instance, PID/starttime, lock inode, runtime/instance-directory inodes, and socket inode together.
Readers check private ancestry, UID/types/modes/no symlinks and authoritative lock;
the host revalidates discovery/lock/endpoint before dispatch. Connected clients recheck endpoint identity without requiring continued owner liveness after a completed reply. Bad or missing live
endpoints are not evidence of death. Definitively dead owners are recovered by
the existing lock acquisition routine. Crash-orphaned private runtime directories
are retained rather than deleting paths whose ownership cannot be re-proven;
they contain control material only, not device/vault credentials.

Control protocol version 1 accepts only sync, watch, and explicit stop-for-removal,
with exact request keys and UUID/root/binding/owner-instance checks. Authentication
is constant-time for well-formed capabilities and precedes body parsing/dispatch.
Content types/routes/redirects are constrained. Requests are streamed/bounded to
16 KiB; at most 16 requests/subscribers and 128 replay entries exist. Completed
oldest entries may be evicted; retries beyond that bounded window safely recheck
identity and coalesce/re-evaluate synchronization, not arbitrary mutations.
Responses contain only checked head IDs/sequences, allowlisted progress events,
and fixed-message local/allowlisted remote error codes (local exit 2, remote exit 5).
No raw exception or remote message crosses control. Sync/watch replies stream live
NDJSON progress before completion with no stream-lifetime event/byte limit. Each
frame is at most 2 KiB. Standard ReadableStream backpressure retains at most one
queued frame, one coalesced latest-progress frame, and one terminal frame per
subscriber (at most 6 KiB of encoded application state); slow readers skip stale
progress, never the final result. The decoder bounds each unfinished frame rather
than total legitimate stream/chunk size, and validates events even without a
callback. Detaching
cancels the subscription, not the owner's pass. Compromised same-UID processes able
to read private state, root, and credential-memory erasure remain out of scope.

### Step 5 verification

- 20 focused service tests, 7 private streaming-codec boundary tests, and 4 added
  CLI/engine lifecycle tests: real-process
  forwarding/coalescing, bounded subscribers/replay saturation, authentication and
  malformed/version/root/binding/instance/oversize rejection, unsafe permissions,
  symlink/hardlink capability and substituted socket refusal, unavailable live
  endpoint, pre/post-advertise process crash/recovery, cross-XDG forwarding,
  credential-free attachment, safe error redaction, live pre-completion progress,
  discovery cleanup races, completed-reply/host-close race, attached CLI SIGINT,
  independent CLI survival, explicit stop/no promotion, and controlled watcher
  failure with active work. Synchronization uses pipes/readiness/promises and
  awaited process exits, not sleep-based assertions. Streaming regressions cover
  1,000 delivered events beyond 16 KiB, a 10,000-update slow-reader burst coalesced
  to first/latest progress plus terminal result, large coalesced transport chunks,
  bounded unterminated frames, cancellation cleanup, and no-callback malformed
  events. Both CLI- and desktop-origin temporary owners refuse attached watches.
- Full suite: **407 passed, 0 failed** across 42 files.
- Workspace/tools typecheck and desktop native typecheck: passed.
- Existing browser suite: **7 passed**. Binary and `nix build path:. --no-link`:
  passed; no new workspace dependency or Nix dependency-expression change needed.
- Parent verification: **27 control/codec tests passed** under project Nix Bun
  **1.4.2 / 744846f84**, and the normal staged Git-visible `nix build --no-link`
  passed. The full 407-test suite and workspace/native typechecks also passed again.
- Scoped codehygiene run with Nix-provided NumPy; long-line readability fixes
  applied. Remaining findings include deliberate stream-cancel cleanup rejection
  suppression, TypeScript stream-controller naming, and existing compact-style
  declarations/validation expressions. This is an advisory readability check,
  not transport/security verification.

No product UI, pause/settings state, native lifecycle integration, user-keyring
locking, real-user credentials, or global keyboard injection was used for this
slice. The browser suite is not a native desktop smoke claim.

## Step 6 — durable status and pauses

Shared `readSettings`/`setPaused` provide versioned, fsynced global/folder OR pause
intent, a separate settings gate, and optional revision-CAS. Valid settings-only
state (including checked interrupted replacement stages) remains credential-
uninitialized. No native preferences, automatic startup or continuous adoption are
introduced. Connect retains its no-transfer behavior.

The existing engine now accepts optional `beforeWork` checkpoints: each HTTP request
and retry, cached download reference, publication producer `next`, scanner inventory/
content step, apply staging/mutation/cleanup unit and hydration boundaries. Producer
iterators and file descriptors close on checkpoint rejection. The shared runner
checks persisted intent and root/marker identity; it yields a macrotask at least
every 16 guarded steps so synchronous work cannot starve same-process control.
Atomic filesystem mutation/fsync/bookkeeping units finish uninterrupted. Pause is
an allowlisted `paused` progress event and local `SYNC_PAUSED` exit 2, not a failure;
watch keeps ownership and retries on its usual schedule. Shutdown still cancels,
awaits the active pass, closes journal/keys, then releases ownership.

New bindings record root device/inode at connect; scanned legacy roots reuse journal
identity. Never-scanned legacy roots establish identity only at explicit validated
first start under the replica lock; pre-upgrade replacement with a copied marker
cannot be detected retrospectively. Retry never creates/adopts a replacement root.
Known root/status metadata is removed with discarded replica state. Interrupted
apply recovery now recognizes only the exact planned two-link stage/destination
pair, not unrelated hardlinks.

`clientStatus`/`client status [--path]` return secret-free observed facts, owner origin/
instance, independent pause causes, coarse/engine phases, actual completed ciphertext
counters, heads and pending/conflict counts, safe error codes and separately persisted
check/success times. Up-to-date needs verified completion, no local invalidation,
matching checked/applied heads, no work/recovery/conflicts and a matching live owner;
completion alone is insufficient. Closed/dead-owner status is stale/unknown, retaining
history. Missing roots remain selectable by saved binding path. Passive observation
never loads keys and uses the checked `ClientLocal.readStatus` snapshot rather than
a competing writer. CLI/schema/recovery details are in `packages/cli/README.md` and
SQLite WAL/URI branch evidence is documented in `packages/client-local/README.md`.

This stage does not implement product UI, notifications, login/tray lifecycle,
continuous-start persistence/adoption, or the later full removal/ignore-edit upgrade.

Step 6 verification (disposable fixtures only): full suite **426 passed** on both
Bun 1.4.4 / 38afee6c8 and project Nix Bun 1.4.2 / 744846f84; workspace/tools and
native SDK typechecks, existing browser suite **7 passed**, binary build and
`nix build path:. --no-link`. Deterministic tests cover independent pause intent,
forwarded requests, cached/network/retry/producer boundaries and iterator cleanup,
same-process macrotask delivery, paused watches avoiding new readiness scans,
filesystem-unit pause/restart, frozen proposal identity replay, root loss before
publication and mid-apply/restart, read-only live/closed WAL snapshots, stale/conflict/
pending facts and success/error retention. The existing deferred enrollment fixture
uses Connection: close to avoid a reproducible Bun 1.4.2 keepalive-parser 400; no
credential behavior changed for that runtime fixture adjustment. Scoped codehygiene
was run using Nix Python/NumPy; new settings is clean, remaining advisory findings
are primarily long validation/aggregate expressions and existing engine style.
No native GUI, real user folders/credentials/keyring or host-keyboard tests were run.

### Step 6 review corrections

- Root identity publication now flushes the replica directory (with its file),
  containing `replicas`, client root and its parent **before** publishing the
  connection record and marker. Connect and copy repair have fsync-order and
  injected-failure regressions; these verify call ordering/failure behavior, not
  physical power-loss survival.
- Settings/status JSON errors are fixed actionable local errors with no input/native
  snippets. Saved observation owner/lock/progress/facts/issue shapes are fully
  checked; stored locks contain only the process and inode identity summary.
- One journal/owner/cache error no longer aborts all-folder status. Each binding has
  safe `statusIssues` codes/messages/retryability/actions. Snapshot races remain
  retryable unknown, while unsafe/incompatible/corrupt state or recovery-required
  WAL requires attention. All such observations fail closed for up-to-date.
  Primary credential-unavailable guidance survives secondary journal/status failure;
  facts stay unknown and secondary issues are surfaced. If status cannot be written,
  the primary credential error gains a fixed status-recording warning instead of
  being replaced by a native exception.
- Passive snapshots retain schema/migration/identity and specific aggregate shape
  validation, while full integrity and foreign-key checks run at owner startup.
  The disposable 100k-entry manual probe `/tmp/nanosync-status-read-benchmark.ts`
  returned identical facts at approximately 1.1 ms versus 0.18 ms for owned facts
  on Bun 1.4.4 (previous full-scan snapshot approximately 80 ms); project Nix Bun
  1.4.2 measured approximately 1.2 ms versus 0.20 ms. These are individual manual
  measurements, not performance guarantees or timing-test assertions.
- Additional real bound-runner tests hold upload/download requests at explicit
  barriers, persist pause mid-pass, complete only the already-started chunk, restart
  paused, and resume without retransferring it. The held-download case changes
  pending-apply facts before the cached observation is rewritten: checked ownership
  retains `pausing` despite stale facts, until the owner confirms `paused`.
  Connected apply tests interrupt
  immediately after an actual atomic link with pause or root loss, retain intent,
  refuse missing/replacement/copied-marker roots, and replay after restoration.
  The existing bound-runner frozen-proposal test compares the replayed advance
  request with the exact persisted request, not just its final head.

Review-fix verification in the shared checkout: full suites **453 passed** on Bun
1.4.4 and project Nix Bun 1.4.2, workspace/tools typecheck and Nix build passed.
The separate SDK-security agent owns native SDK validation and related desktop/
flake artifacts; no new native/UI validation is claimed by these shared fixes.

### Legacy journal recovery before root validation

A legacy binding can lack `root-identity.json` while retaining historical root
identity in a valid journal whose WAL has no SHM after a crash/backup restore.
Read-only status must not repair that journal. Explicit `startBoundSync` now acquires
the replica lock and opens/recovers only private journal/cache state first; inside
the constructor cleanup boundary it then validates the marker and recovered
historical root identity **before creating the scanner or starting user-root work**.
A rejected root closes the journal, clears the copied key and releases ownership.
An unreadable/incompatible journal cannot authorize capturing a new root identity.
The existing never-scanned legacy compatibility limit remains unchanged.

`assertBindingRoot` preserves typed journal recovery/race errors instead of turning
them into `FOLDER_UNAVAILABLE`. Passive status collects those identity-observation
issues before deriving freshness/attention: a second-read race stays retryable
unknown, and a present root with an unrecovered journal reports journal recovery,
not physical folder loss. Transfer guards still reject unverified identity.
Root identity capture and comparison use BigInt filesystem stats and exact decimal
strings, consistent with the Linux scanner; ownership/path checks retain their
existing behavior. Adjacent inode IDs above 2^53 are no longer rounded together.

Verification: 28 focused status/root tests passed; full core suites (`bun test
packages`) **454 passed** on both Bun 1.4.4 and project Nix Bun 1.4.2, workspace/tools
typecheck and diff checks passed. The disposable parent reproduction now reports
`Public owner start recovered legacy WAL: yes` on both runtimes without a manual
journal open. Regressions cover scanned/unscanned legacy startup, passive recovery
reporting without mutation, a race only in the second identity snapshot, rejection
of a replaced root/copied marker after owned recovery with zero scans/transfers and
unchanged pending facts, lock cleanup, and high-bit identity precision. No physical
power-loss, deployed-state, native SDK or GUI validation is claimed by this fix.

### Explicit move repair compatibility and constructor cleanup

A disposable scanned-root copy/remove probe reproduced a false success: move repair
published the new path, then public start rejected the journal's old root inode.
The pre-step-6 baseline (`1e90d5c`, `apply.ts::planApply`, lines 273–280) already
required each recorded entry **and root** device/inode to match. Existing move tests
exercise `renameSync`, not cross-filesystem identity rebinding. Cross-inode move was
therefore not a generally valid retained-journal operation; no new reindexing API or
filesystem reconciliation engine is introduced here.

Explicit move repair now acquires replica ownership under the existing registry gate,
recovers private state if necessary, and verifies compatibility before changing the
root metadata or binding record. Scanned cross-inode moves return `MOVE_REQUIRES_COPY`
for clean state, or `MOVE_RECOVERY_REQUIRED` for interrupted/uncertain state. Records,
markers and pending intent remain intact on refusal; an independent copy remains an
explicit separate choice, never automatic abandonment. Same-inode renames preserve
pending work and can publicly start afterwards. Never-scanned roots without recovery
work remain explicitly movable; ordinary replacement-root checks are unchanged.

Constructor error cleanup now zeroes the runner's copied key in a `finally` even if
journal close throws, consistent with stop cleanup. A controlled close-failure test
inspects only a disposable fake-key copy and confirms the caller-owned input remains
unchanged; it makes no physical-memory erasure claim.

Move/cleanup verification: **40 focused tests** (status/root plus existing connection
callers), **460 core tests** on both default Bun 1.4.4 and project Nix Bun 1.4.2,
workspace/tools typecheck and diff checks passed. The no-HTTP copy/remove probe
`/tmp/nanosync-scanned-move-probe.ts` now refuses with `MOVE_REQUIRES_COPY` before
publishing; copied-root start remains blocked by the original binding/marker guard.
Tests also cover same-inode repair with WAL recovery and retained pending work,
interrupted cross-inode refusal, live-owner contention without journal mutation,
unchanged unscanned/no-recovery behavior, and key cleanup after a controlled close
failure. These fixtures do not claim physical cross-filesystem/power-loss testing.

Parent checkpoint: **464 workspace tests** passed on Bun 1.4.4 and locked-nixpkgs
Bun 1.4.2; workspace/tools types, 7 browser tests, CLI binary and default Nix build
passed. The independent public legacy-WAL recovery probe also passed. The separate
SDK security prerequisite is committed at `e039823`; its packaged fatal/normal Quit,
privacy, authenticated loopback transport and navigation gates passed independently.
Scoped codehygiene retained density advisories and intentional issue-reporting catches;
its optional 0.6.1 update is available. No real credentials or physical power-loss
validation is claimed.

## Step 7 — service-backed terminal-free setup

The desktop now replaces spike actions with the Field Guide five-step React setup:
real enrollment and retained pending resume, verification/external capability-only
administration, approved vault/key and native existing-folder selection, shared
lifecycle intentions, and connect-without-transfer or explicit continuous Start.
Existing Paper controls and theme leaves are reused without admin application code.
No production fixtures, response selectors or fake keyring adapters are present.

Credential decisions precede secret use. Protected-file roots offer leave-unchanged
CLI use or confirmed whole-root migration; interrupted migration exposes only a
validated safe phase/rollback decision. Cleanup intent is forward-only. OS-store
unavailability blocks access without recovery prompts or file fallback. Only a
truly absent vault key or explicitly retried pending write requests recovery input.
Renderer RPC has exact bounded runtime schemas, fixed allowlisted errors and picked
folder tokens, never generic filesystem/SQL/credential/native access. Typed enrollment
results supply actual status, alias and canonical URL, including existing connections
whose alias differs from new form input. Malformed successful capability/vault/recovery
responses become fixed `INVALID_RESPONSE` errors (remote exit 5), not parser paths. Password and
recovery fields are cleared on submission, completion, cancellation, back and unmount;
JavaScript strings cannot guarantee physical zeroization.

Shared settings v2 retains independent pauses and CAS revision, adds three lifecycle
intentions and accepted continuous origin per binding. Missing continuous entries
mean false/not requested. The origin-valued map avoids a second provenance map and
records the accepting owner, not the requesting interface. Lifecycle defaults are
login false, tray null/unanswered, background-after-close true. Reads normalize v1
without writes; explicit save/watch upgrades under registry then settings locking.
Upgrade refuses older/unadvertised live owners before changing state. Owner discovery
metadata v2 advertises this compatibility; control requests remain v1. Existing
pause/resume CLI envelopes/data remain v1. `client settings view|set` exposes shared
intent with `nativeEffects:not-applied`; CLI watch and desktop Start share the same
acceptance/persistence seam, while one-shot does not set continuous intent.

Start invokes real authenticated bound watch and coalesces duplicate requests. An
attached temporary owner is rejected actionably, never promoted/stolen. A continuous
CLI owner retains its origin and survives desktop Quit. Only the host persists accepted
origin; attachment replies never write it. A barrier regression delays an old desktop
acceptance until a replacement CLI watch has persisted its origin, then proves the
late reply cannot overwrite CLI provenance. The authenticated acceptance operation
also does not wait for a held remote transfer/pass. Restart resumes only accepted
desktop-origin work, not new bindings or CLI-origin intent. A failed Start after
connect leaves one connected binding with a retry action. Main resolves the saved
binding and holds real watch promises; renderer does not own the engine lifetime.

The validated SDK bootstrap, hashes, aliases, trusted argv opener and packaged-only
navigation remain intact. Main creates about:blank, sets rules, then loads local
content. No tray is initialized and no spike probes run. The synchronous cancelable
before-quit hook vetoes immediately, asynchronously awaits own-runner cleanup and
CLI detachment, drains in-flight operations (including uncancellable credential-store
writes), then reissues Quit only on success; it does not assume SDK event handlers
are awaited. Startup/tray/background effects are explicitly not installed
or applied in this slice; closing currently safely quits. Full lifecycle policy is
step 10, and the small completion view is not step 8's full folders dashboard.

UI concurrency regressions hold replies at explicit barriers: old cancelled enrollment
cannot erase a new password; mutable drafts are disabled while busy without disabling
cancellation; lifecycle values and their base revision are captured together on entering
the background step. Unrelated metadata refresh cannot bless an older draft. An explicit
conflict refresh replaces both draft and revision, and Ready displays actual saved
snapshot values. Enrollment retry, key retry, fresh enrollment and migration confirmation
have separate consent state, reset on identity changes/attempt/cancel. No consent carries
from one credential/key operation to another.

New secret-bearing product HTML adds a restrictive CSP: packaged `views:` scripts and
styles, only loopback SDK WebSocket connections, no inline/eval scripts, forms, frames,
workers, objects or base injection. Inline styles are allowed for house controls.
This is additional hardening over the spike's absent product CSP, not a regression
claim or a trusted-preload/renderer sandbox. The actual native SDK RPC fixture uses
the identical policy, verified by a default unit test and the real packaged gate;
trusted WebKit console-observer injection remains functional. No SDK source/patches,
bootstrap, hashes, build pipeline or opener protections were changed. Product package
inspection also checks real linked JS/CSS assets; Hutch names the CSS `view.css`, not
`index.css`, so the shipped HTML links the actual bundled stylesheet.

Verification on this slice:

- **492 default tests passed** on Bun 1.4.4 and locked-nixpkgs Bun 1.4.2, run sequentially.
  An earlier simultaneous two-runtime run collided on existing fixed-port server tests;
  sequential reruns passed. New tests use barriers/event synchronization, not sleeps or
  wall-clock deadline correctness assertions.
- Workspace/tools and native desktop types passed. **18 browser tests passed**, including
  **11 desktop presentation cases**, light/dark axe checks, focus, nonempty acknowledgment,
  canonical/existing enrollment identities, separate Start/Finish, stale replies, shared
  settings revisions and operation-scoped consent. Presentation fixtures are separate
  from real service/HTTP/credential-adapter integration and never enter the product bundle.
- Real disposable server/vault integration proves recovery, locked-vs-missing handling,
  no journal/transfer on connect, real continuous work on a subsequent file edit,
  coalesced Start, desktop-only restart intent, temporary-owner refusal and independent
  CLI survival. Memory credential adapters are test-only; no real keyring is used.
- CLI binary, default Nix build and stable desktop build passed. `bun2nix` was regenerated
  using the pinned project input; its generated expression was unchanged because all
  dependencies already existed. Workspace dependency declarations and `bun.lock` changed.
- CSP-aligned packaged SDK gate passed fatal **1** / normal Quit **0**, actual RPC,
  privacy/auth/navigation checks and zero remaining fixture process groups; original
  core/preload hashes remained unchanged. This is SDK-policy evidence, not product GUI
  onboarding/lifecycle certification.
- Scoped codehygiene ran with project-pinned Nix Python/NumPy. Shared onboarding code
  passed; remaining advisories are JSX nesting/layout and long fixed recovery messages.
  New UI/backend code was formatted for readability; no schema/framework abstraction
  was introduced solely to satisfy these early-preview advisories. Optional 0.6.1 update
  is available. Diff whitespace checks passed.

Native picker/session behavior and keyboard onboarding in an installed product are
not claimed by headless integration/browser presentation tests; those remain release
validation. No user client roots, credentials, host display or global input are used.

Parent acceptance independently repeated 492 tests on both Bun runtimes, full
workspace/tools/native types, all 18 browser tests, CLI binary/default Nix builds,
the CSP-aligned packaged native gate (fatal 1 / normal 0), and the stable desktop
build. Independent safety review closed both provenance and reflected-parser findings.
The actual stable payload also includes the unchanged Paper UI provenance notice;
its existing licensing-review warning is retained, not replaced with a license grant.

## Step 8 — connected folders and observation-safe dashboard

Existing bindings now open directly in the Field Guide Folders list and selected-copy
inspector. The setup wizard is a separate mounted screen and returns to this dashboard;
its former nested completion placeholder is removed. Shared aliases, original roots,
server/vault/device/copy UUIDs, actual owner origin or unavailable ownership, pause
causes, health, conflict/error attention and last success/check times remain distinct.
Multiple copies of one vault stay separate rows/journals. Vault names are explicitly
not cached rather than guessed or fetched using credentials merely to render a list.
Layout uses the approved rail/list/288px inspector, compact light/dark tokens and
small-window inspector stacking, with keyboard buttons and non-color status labels.

The dashboard uses metadata-only shared snapshots, including protected-file roots and
OS-store-unavailable observations. Snapshot and pause/settings operations never probe
or unlock the credential provider. The credential decision still blocks desktop
secret-dependent enrollment and transfers, with no file fallback. Migration/recovery
barriers remain barriers; missing inventory is not treated as empty client state.

New exact RPCs use binding UUIDs only for Sync now/open, and UUID/boolean/expected
revision for folder pause (boolean/revision for global pause). Native main resolves
saved bindings, validates original root/marker identity and calls the existing trusted
argv opener. The shared checked-root helper also serves `client open --path`; Linux
CLI integration uses an explicit PATH-resolved xdg-open argv, and unavailable/headless
integration returns a local exit-2 error without affecting headless synchronization.
No renderer path, URL, SQL, secret-store or generic shell capability was introduced.

Sync now routes through `openBoundSync`, coalesces per-copy duplicate requests, and
closes its own temporary session or detaches an existing owner. It never enables
continuous intent. Explicit Start keeps step 7's host-owned provenance, compatible
owner routing and honest temporary-owner refusal. Quit also cancels/detaches active
one-shot sessions before draining requests, without stopping independent CLI owners
or releasing an active writer early. Global/folder pauses retain independent flags;
resuming a folder explains when global pause still prevents work.

Polling is serialized and confined to the dashboard. An epoch rejects pre-mutation
snapshots; failed mutation refreshes never silently retry/rebase an action. Setup
unmounts dashboard polling entirely, so no poll can invalidate enrollment or clear a
new password/recovery field. A failed read explicitly demotes all cached healthy
markers/freshness/owner observations and engine progress until a successful reply.
Counters are labeled current-owner or historical owner counters with completed
ciphertext-frame units and unknown totals, never invented percentages or totals.
Only the shared `upToDate` predicate permits the healthy label; last success is not
reset by viewing. Historical local request errors are labeled separately from shared
current attention. Pauses do not hide conflicts, revoked access or missing roots.

Step 9 conflict/ignore/removal tools, step 10 integrations, and step 11 notification/
diagnostics screens are not implemented or simulated. The sidebar states unavailable
surfaces honestly; saved lifecycle intent still reports native effects as not applied.
The maintained SDK bootstrap/hash/navigation/CSP/opener source pipeline and copied
Paper provenance/licensing-review notice remain unchanged.

Step-8 verification:

- **498 default tests passed** on Bun 1.4.4 and locked-nixpkgs Bun 1.4.2, sequentially.
  Six new backend/CLI cases cover strict payloads, real independent copy identities,
  zero provider reads for protected/locked metadata and pause/open, stale-revision
  refusal, replacement/missing roots, real verified one-shot sync/coalescing without
  continuous intent, routing to an independent CLI owner, and Quit during held own/
  external one-shot work. Test native opening uses an isolated fake executable only.
- **24 browser tests passed**, including six new Folders cases and all eleven setup
  regressions. Folders cases cover real DTO identity/alias distinctions, independent
  pause causes with conflict/error attention, actual/unavailable owners, unknown
  counters, locked/missing-root guidance, explicit retry, light/dark axe checks,
  keyboard selection and 1280/960/700px layouts. Fake clocks and deferred replies prove
  failure demotion/recovery, pre-mutation poll rejection and setup isolation without
  wall-clock sleeps/deadline correctness assertions.
- Workspace/tools and native desktop types passed; CLI binary, default Nix and stable
  desktop builds passed. No dependency/lock/generated Nix changes were needed.
- Actual extracted stable payload checks passed for Folders JS, linked CSS, unchanged
  CSP and byte-identical Paper notice; presentation RPC names/sample paths are absent.
  The notice's licensing-review warning remains intact, not a license grant.
- Post-build packaged SDK gate passed fatal **1** / normal Quit **0**, real RPC,
  privacy/auth/navigation assertions and zero remaining fixture process groups.
  Core/preload hashes and the maintained SDK source pipeline remain unchanged.
- Scoped codehygiene passed the small app shell. Remaining advisories are formatted
  JSX nesting/layout, long fixed recovery messages and an intentional headless-session
  availability guard (not a swallowed exception). Optional 0.6.1 update is available.
  Diff whitespace checks passed. Evidence logs are `/tmp/nanosync-step8-*.log`.

Native installed folder-opening/onboarding/lifecycle smoke remains release validation;
tests use only temporary state, isolated credential adapters/HTTP servers and headless
browser input. No user client root/keyring, host windows, focus or global input is used.
No staging, commit or push was performed by the implementation agent.

Parent acceptance repeated all 498 tests on both Bun versions, 24 browser tests,
workspace/tools/native types, binary/default Nix/stable desktop builds, and the
packaged fatal/normal SDK gates with zero remaining fixture groups. Independent
review found no concrete ownership, credential or false-success issue in the new
folder actions. Real installed-session native smoke remains unclaimed.

## Step 9 — conflicts, coordinated ignore editing and durable local removal

The Folders rail now opens persistent manual Conflicts and Connections/removal;
folder inspectors open the exact-dialect ignore editor and disconnect inspection.
Paper controls and existing Field Guide light/dark tokens are reused. Trusted main
accepts IDs and narrow typed requests, never arbitrary renderer paths or native
execution. [Local operation contracts](desktop-local-operations.md) document exact
CLI flags/results, JSON bounds, state schemas, recovery phases and POSIX CAS limits.
All new operations have headless CLI equivalents; existing removal result shapes
and version-1 envelopes/exits are retained.

Conflict listing extends the existing checked readonly SQLite snapshot path; there
is no new database/migration, writer constructor or full-integrity poll. Open
containing resolves current lineage by trusted IDs, checks root/path components,
then uses the existing argv opener. No acknowledge/resolve API was added. Real
engine tests retain both divergent versions across reopen; deliberate manual file
changes clear conflicts only after successful manifest reconciliation.

Ignore parsing is the existing exclusions-only implementation extracted behind a
pure text seam. A runtime owner maintenance gate blocks new pass/readiness admission
without making the active pass wait on its own gate. It waits admitted work, checks
durable pending basis, persists verified=false before committing any rules, then
checks the expected signature and stage identity/content, renames and fsyncs.
Post-rename durability failure cannot leave status verified, even without a watcher.
Stop waits maintenance before close/key cleanup/unlock. Actual owner origin/lock and
continuous intent stay unchanged; no persistent pause toggles, promotion, implicit
scan/start or competing writable journal is used. An unowned edit first recovers
its owned private WAL, then checks historical root identity and pending basis;
passive view never recovers/writes. Exact root-local ignore stage names are reserved,
not all `.nanosync-*` apply/hydration names. Invalid/stale/incompatible work preserves
rules and reports safe code/line information without reflected patterns.

Removal inventories full content with bounded streamed hashing and event-loop
yields. Separate abandonment and stop-owner consent are required; --yes supplies
neither. Safe stop occurs outside gates; all UUID-ordered locks and identities are
reacquired/rechecked before durable intent or destruction. Missing saved roots are
never recreated; replacement roots and foreign markers are preserved/refused.
Secret-free original identities survive partial marker/record/server deletion in
`removal.json`; listings/status/recovery remain available and normal mutation/start
cannot run through it. Replay interprets absence only under that intent, not by
rescanning an apparently unbound root. It fsyncs absent-entry directories again and
reestablishes journal-file plus containing-directory durability before irreversible
work; visible publication after a failed fsync is not accepted as durable proof.

Provider cleanup reuses the existing marker-set/readback/delete/get erasure
algorithm, not delete-false-as-absent or a replacement provider. Its exact reference
inventory is atomically published and retained until the outer credentials-complete
phase is durable; replay flushes that inventory before erasure/finalization. Every
server-associated key/pending path is validated; different servers' references,
local files, conflict copies, ignore rules and remote data are preserved. There is
no rollback after destructive cleanup and no remote revocation/forensic-erasure
claim. Intent/device/inode/path schemas and malformed JSON diagnostics are checked
without leaking raw parse snippets. No generic transaction/store/daemon framework
was introduced.

The existing transfer-caption wording is corrected to observed/historical **pass**
counters: the runner already resets them at each pass; no backend counter semantics
were changed. SDK patches/bootstrap/CSP/navigation, argv opener constraints, Paper
provenance notice, dependency locks and build pipeline are unchanged. Lifecycle,
notifications/diagnostics and release packaging remain steps 10–12.

Verification of this slice (implementation-agent evidence, pending parent acceptance):

- **539 tests passed, 0 failed** on Bun **1.4.4** and locked-nixpkgs Bun **1.4.2**,
  run sequentially; workspace/tools and native desktop typechecks passed. New tests
  use explicit promise barriers, fake/in-memory providers, temporary roots and
  failpoints rather than sleeps or wall-clock correctness assertions. Earlier
  simultaneous full-runtime runs collided on existing fixed-port server fixtures;
  sequential final runs passed.
- **26 browser tests passed**, including manual conflict/open, validated ignore CAS,
  separate abandonment/owner-stop confirmation, missing-record/locked-provider
  recovery, keyboard, light/dark axe and responsive layouts. Browser mocks are
  presentation-only; actual shared backend/HTTP/engine/journal tests are separate.
- Crash tests cover original identities after partial marker/record removal,
  staged/published intents, every removal/provider phase, copied/missing roots,
  unsafe schema/parse diagnostics, unlink-to-fsync failures and visible-but-not-yet-
  durable publication. Fsync-order traces prove checked journal-file plus directory
  flushes precede marker deletion, provider erasure and retained-inventory unlink.
  These are deterministic failure-injection proofs, not physical power-loss tests.
- A post-ignore-rename directory-fsync failure changes rules while verified status
  is already false, with no watcher timing dependency or blind write retry. Owned
  legacy WAL/no-SHM tests recover before historical root verification; copied-marker
  replacements still refuse before writing rules and passive view remains readonly.
  Streamed hashing tests prove bounded chunk yielding; no 50-GB hardware benchmark
  is claimed.
- CLI binary, `nix build path:. --no-link`, and stable desktop build passed; no
  dependency/lock/generated Nix, SDK patch, build-pipeline or flake changes were
  necessary. Tools were obtained from the project's pinned Nix input, not global
  mutable installs.
- Packaged SDK gate passed fatal **1** / normal Quit **0**, authenticated RPC/privacy/
  navigation checks and zero remaining fixture process groups. Core/preload hashes
  remain unchanged. The product was rebuilt after the SDK fixture gate, and its
  extracted stable payload contains actual local-operation screens, linked CSS,
  byte-identical CSP HTML and Paper notice, with presentation fixtures absent.
- Scoped codehygiene ran on the new parser/state/action seams; formatting removed
  density warnings. Its remaining advisory is the retained exact-dialect regex
  expression. The optional 0.6.1 tool update was not installed. Whitespace checks
  passed. Logs are `/tmp/nanosync-step9-*.log`.

No real user client roots, keyring, host windows, focus or global input were used.
Installed-session native operation, hardware-scale performance and steps 10–12
remain unclaimed. No staging, commit or push was performed by this agent.

Post-parent-review RPC fix: desktop ignore save now passes a concrete binding UUID
selector directly to the shared service. Selection occurs under its initial registry
gate, before replica/owner coordination; there is no premature readonly historical
root check and no outer registry lease while awaiting owner IPC. CLI path semantics
are unchanged. Three additional real-backend tests prove protected-file legacy WAL
recovery with no OS-provider access, copied-marker historical-root refusal, and a
barrier-injected disconnect/rebind at the same path that cannot redirect the old
UUID request. The parent's additional post-rename durability/status test was left
untouched. Final suites pass **543 tests** on each Bun runtime, workspace/tools/native
types, binary/default Nix/stable desktop builds, and fatal/normal SDK gates. Evidence
for this fix is `/tmp/nanosync-step9-rpc-id-*.log`.

Parent acceptance repeated 543 tests on both Bun versions, all 26 browser tests,
workspace/tools/native types, CLI binary/default Nix/stable desktop builds, and the
packaged fatal/normal SDK gates with no orphan fixture groups. Independent replay
review verified the original missing-fsync finding closed before destructive work;
the parent's post-rename ignore fault test also passed. New action/state seams passed
scoped codehygiene. These checks do not claim physical power-loss or installed-session
validation.

## Step 10 — desktop lifecycle and honest native availability

Implemented login/Close/Quit/logout policy, profile-scoped authenticated singleton
activation and optional status/reopen tray in trusted main. The exact security,
association, startup-launcher contract and limits are in
[desktop-lifecycle.md](desktop-lifecycle.md). No synchronization/encryption engine,
SQLite location, recovery/ignore barrier, daemon or notification delivery was added.
Existing CSP, SDK source/provenance/bootstrap, argv opener and Paper notice remain;
the app alone selects the validated GTK X11/XWayland backend before SDK import.

Close vetoes synchronously and hides with keep-on even without a tray. Keep-off
and explicit Quit coalesce existing own-only backend cleanup before approved SDK
Quit. New work is refused, attached CLI clients detach, independent CLI owners and
pause flags survive. Authenticated launcher activation restores the known window
or creates a fresh window/view after destruction; uncertain/live ownership and
cross-session activation never authorize a second owner. The singleton reuses
shared checked private state and PID/starttime/inode locks, including definitive
stale recovery and root-replacement refusal. Initially absent roots get only an
empty private directory before identity capture, not credential initialization.

Native availability/applied/error observations are separate from persisted intent.
Periodic reconciliation rereads CLI preferences without cached writeback and skips
busy ticks rather than accumulating slow-probe follow-ups. General settings shows
fresh native observations without rebasing an unsaved draft/CAS revision. Its save
and explicit refresh share the Folders epoch; old pre-save polls are rejected and
failed observations become unknown/historical instead of stale Available/Applied.

Session shutdown uses maintained libsystemd session association/state/monitor APIs,
rechecked at work admission and every second. Closing/removal or observation loss
invokes own-only shutdown, not shared pause or CLI termination. Own-PID Wayland
login association can support the XWayland app backend; native GTK Wayland remains
unvalidated. Inherited IDs retain provenance and need a positive display match;
a stale inherited Wayland session-A ID plus empty logind display/current display B
fails closed and cannot become singleton session authority. Unknown association
blocks desktop sync honestly. No arbitrary UID-session choice or user-manager
cgroup inference is used; actual installed login/logout remains step 12.

Tray construction requires explicit true choice and a real registered host, not
`Tray.visible` or watcher-name ownership alone. Applied status also observes this
process/current native item registration. Menu-only Linux exposes exactly Open
Nanosync. Shared actionable attention selects red diamond/exclamation vs normal
green and status text without vault filenames/paths. Missing/disabled tray never
blocks hiding, syncing or authenticated launcher reopening.

Startup manages only an exactly marked profile-specific owned XDG entry, using
Desktop Entry argv escaping and a proven active consumer/generator. Foreign or
unsafe/read-only entries are preserved, failures retain intent, and durability is
rechecked before claiming installation. Startup remains unavailable until a trusted
installed public wrapper has actual verified Resources/main.js → Worker argv
forwarding evidence. The parent-owned SDK prerequisite `82f6117` fixes and verifies
the Worker seam; it does **not** make the upstream outer launcher forward argv or
certify the unbuilt step-12 Nix wrapper. No development/inner Bun path, covert argv
environment channel or runtime-verification bypass is registered as startup.

Final implementation-agent verification (all after the review fixes):

- `bun test`: **560 passed, 0 failed**, Bun **1.4.4**.
- `nix shell --inputs-from . nixpkgs#bun --command bun test`: **560 passed, 0 failed**,
  locked-nixpkgs Bun **1.4.2**; suites run sequentially.
- `bun run typecheck` and `bun run --cwd apps/desktop typecheck:native`: passed.
- `bun run test:browser`: **28 passed**, including General native-loss/draft/CAS,
  failed-read demotion and deferred pre-save poll tests with fake clocks/barriers.
- `bun run build:binary` and `nix build path:. --no-link`: passed. Project Nix adds
  libsystemd/systemctl plus test-only Python dbus-next; no Bun dependency/lock or
  generated Nix dependency expression changed.
- `nix develop --command bun build/desktop/lifecycle-gate.ts`: passed both explicit
  Quit and keep-off Close. Actual private fake watcher proves owned-but-host-false
  remains unavailable, registration, sole Open menu activation, title/icon updates
  and host loss. Actual helpers/backend/singleton prove no-tray hide/reopen, fresh
  window recreation, authenticated cross-process activation and deferred cleanup.
  Private gio launch checks Desktop Entry special-character argv. **Zero fixture
  process groups remain.** No host panel/system bus/service activation is used.
- `nix develop --command bun run --cwd apps/desktop security:gate`: fatal **1** and
  normal Quit **0**, real RPC/privacy/auth/navigation checks, zero fixture groups;
  core `0660514…` and preload `de08a1…` unchanged. Parent prerequisite separately
  validated inner-runtime argv on its four-gate run; the outer launcher still drops
  ordinary argv, as its gate honestly records.
- Rebuilt the stable product after fixture gates with
  `nix develop --command bun run --cwd apps/desktop build`. Extracted actual payload
  verification passed: current SDK/runtime manifest, product lifecycle code, linked
  CSS, byte-identical CSP HTML/Paper notice, both tray images and no fixture entry.
- Scoped codehygiene executed with project-pinned Nix Python/NumPy. Lifecycle
  passes; retained advisories (including General) are long fixed guidance text, intentional
  repeated security revalidation/descriptor cleanup and fail-closed missing-display
  handling. Optional codehygiene 0.6.1 update was not installed. Whitespace checks
  passed. Logs: `/tmp/nanosync-step10-*.log`.

Tests use deferred barriers/fake clocks, private roots and synthetic credential or
session adapters, never correctness sleeps. Existing real held-transfer tests now
exercise Quit, session-closing and monitor-loss for both own desktop and independent
CLI owners. No real client root, keyring, host window/focus/input, compositor/PAM or
startup state was used. Installed-session startup/logout/focus and host-panel smoke,
native GTK Wayland and steps 11/12 remain unclaimed. No staging, commit or push was
performed by the step-10 implementation agent.

Parent acceptance reran the final Git-visible scope independently: **560 tests / 6484 assertions** on each Bun, **28 browser tests**, workspace/tools/native types, binary/default Nix builds, stable product build and actual compressed-payload notice/CSP/SDK verification. Actual lifecycle and SDK fatal/normal gates passed again with **zero fixture process groups**. Independent reviewer verified the stale inherited-Wayland association finding closed (13 focused tests / 118 assertions); no remaining concrete safety issue in that bounded review. Scoped hygiene retained intentional fail-closed catches and repeated descriptor/security checks. Initial concurrent parent Bun-suite runs collided on existing fixed server ports 7570/7571; both passed when rerun sequentially, so the two full suites must not be run together. Evidence: `/tmp/nanosync-step10-parent-*.log`. Installed-session claims remain reserved for step 12.
