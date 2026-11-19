# `@nanosync/cli` — command and automation reference

Start with the authoritative [user guides](../../apps/site/content/docs/introduction.md), [source installation](../../apps/site/content/docs/installation.md), and [demo first sync](../../apps/site/content/docs/first-sync.md). No release is available yet. This reference retains detailed flags, state semantics, and machine contracts for operators and integrators; library-only history/restore features are not CLI commands.

For contributor use, install workspace dependencies with `bun install`. Run `bun packages/cli/src/main.ts --help`.
This is a breaking command/state redesign: no legacy aliases, bootstrap command, historical-format migration, `--env`, `--sync-dir` or `--continuous`.

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
# Provision locally while the runtime is stopped; save the vault recovery key.
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
nanosync server run --server-dir "$HOME/nanosync-server" --web-ui
# In another terminal/on the client:
nanosync client connections add --credential-mode protected-file --url https://sync.example.com --alias home
# On the server, compare the verification code and use the exact printed UUID:
nanosync server devices approve --device-id UUID
# Deliver the vault recovery key offline to the client:
mkdir -p "$HOME/Sync"
nanosync client vaults connect --server home --vault documents --path "$HOME/Sync"
nanosync client sync --path "$HOME/Sync"
nanosync client sync --watch --path "$HOME/Sync"
```

## Commands and selection

- `server init`, `server run`: owner password initialization and foreground runtime. Run supports `--host`, `--port`, `--acknowledge-exposure`, `--web-ui`, `--external-origin`, and `--trusted-proxy` (exact peer IP).
- `server devices view|approve|deny|revoke`: local owner operations. Mutations use `--device-id UUID` or an interactive device selector showing names and full UUIDs; display names are never accepted as identifiers. Revocation requires ordinary confirmation or `--yes`; it prevents access, not erasure of retained data/keys.
- `server vaults view|create|rename|delete`: creation uses `--name` and optional protected `--recovery-output FILE`. Rename uses `--vault UUID --name NAME`. Delete requires exact name entry interactively, or `--vault UUID --confirm-delete SAME_UUID --non-interactive` in scripts. Neither `--yes` nor `--force` substitutes.
- `server admin storage|retention-dry-run|gc-dry-run|scan|diagnostics`: local aggregate reports/maintenance, requiring the runtime to be stopped because report setup initializes/recovers object storage. GC remains dry-run; scan processes a bounded batch.
- `client connections add|remove|view`: add uses `--credential-mode protected-file|os-store` for a genuinely new root, `--retry-credential-write` for an interrupted unsubmitted OS credential write, `--url`, `--alias`, `--device-name`, `--wait-ms`, `--fresh`, `--password-file`. Alias is unique local selection vocabulary, independent of the owner-visible device name (hostname offered by default). Remove uses `--server ALIAS_OR_ID` and optional `--force`; it never remotely revokes. View omits credentials.
- `client vaults connect|disconnect|view`: connect uses `--server ALIAS_OR_ID`, `--vault NAME_OR_UUID`, `--path DIRECTORY`, `--confirm-nonempty`, `--recovery-file`. Interactive server/vault choices use maintained selection prompts. Path defaults to CWD. Recovery is requested only when the key is absent. Binding transfers no files. Multiple independent nonoverlapping directory replicas are allowed. Disconnect uses `--path` (CWD default) and optional `--force`, preserving files and remote data.
- `client settings view|set`: shared lifecycle and notification intent with revision-checked updates; native availability is separate. See below for exact flags and result shapes.
- `client status`, `pause|resume`, `open`, `conflicts view`, `ignores view|validate|set`, `removals view|resume`: shared observed status and checked local operations, detailed below.
- `client credentials view|migrate|resume|rollback`: explicit credential-mode decisions/recovery, detailed below.
- `client diagnostics export --output FILE [--include-identifiers]`: explicit allowlisted local report; never logs/credentials/full state. See [diagnostics contract](../../docs/desktop-diagnostics.md).
- `client sync`: nearest binding at CWD or an ancestor; explicit `--path` and foreground `--watch`. Deleted vaults return `VAULT_DELETED`, stop syncing, and preserve files and cached keys. Disconnect the obsolete binding; reconnect to a separately provisioned vault deliberately.

All server commands require `--server-dir DIRECTORY` or prompt for it; **no implicit server directory**. Every command accepts `--json --non-interactive --yes`. Non-terminal execution, `TERM=dumb`, and `--non-interactive` never prompt. Interactive server/vault/device selections require an explicit choice even when only one item is available. Server-local rename/delete also offer vault selectors when `--vault` is omitted. All selections have non-secret flags. `--yes` is only an ordinary confirmation, never permission to abandon unsynced work or bypass locks. Client state defaults to `~/.nanosync` (`--client-dir DIRECTORY`). Private state directories must be owned real directories with mode 0700.

Removal refuses attached bindings unless `--force` is explicit. Disconnect checks pending journals and a full, no-follow filesystem inventory/content hash against the last applied state, including edits not yet scanned by sync. Unsynced work requires explicit `--force`; synchronized plaintext can be disconnected without force. Forced operations discard pending sync state and preserve local files. All affected replica locks are acquired in UUID order before mutation. A contended lock leaves every binding intact. A process-identity registry gate serializes bind/repair/disconnect/server removal and sync lock handoff, preventing new bindings from racing credential removal. Force/yes never bypass either gate or a live replica lock. If a bound directory is absent, `client vaults disconnect --path ORIGINAL_PATH --force` or forced server removal can discard its saved binding. Existing replacement directories or symlinks still require a matching valid marker and are not silently accepted.

Client sync attaches to an existing compatible local owner instead of opening a
second writer. Attached `--watch` stays foreground; Ctrl-C detaches only that CLI,
leaving the external owner running. Owner origin remains the process that acquired
the replica lock. Any temporary one-shot owner (CLI or desktop Sync Now) refuses
an incoming watch with `OWNER_TEMPORARY` (local exit 2); retry after it finishes or
explicitly start continuous sync in its owner. `OWNER_UNAVAILABLE` means
a live owner has missing/incompatible/unreachable control: stop it normally and
retry, never remove its lock or use force to bypass it. Desktop Quit stops only its
own desktop-instance runners, not independently CLI-owned work. Local control uses
private authenticated Unix sockets and needs no desktop/keyring for protected-file
mode. Its fixed runtime discovery works across headless/session environments;
see [the implementation boundary](../../docs/desktop-implementation.md#step-5--single-owner-sessions-and-private-control).

Sync requests have a 30-second deadline covering the response body. Stopping the runner or interrupting watch mode cancels in-flight requests before releasing the replica lock. Offline reconciliation uses the same 16,384-node bound as history traversal and durably records the original local branch before changing inventory; interrupted merges resume without scanning intermediate merge content as local edits.

## Human output (default)

Results, prompts, progress, safety warnings, and command errors use **stdout** by default. Output uses readable headings and labeled details, full copyable identifiers, and actionable empty states. Errors show `Error [CODE]: explanation` without JSON or stack traces; exit codes remain the same as machine mode. Invoking a command group without a subcommand (for example, `nanosync client vaults`) prints that group's help and exits 0. Unknown commands and invalid flags still fail.

Terminal output uses colors and phase spinners during waits. Spinners pause for prompts and stop before persistent messages and on completion/failure. Redirected output stays human-readable but has no colors, animations, or cursor manipulation; it never silently switches to JSON. `NO_COLOR` disables colors, and `TERM=dumb` also disables animation and prompts. Watch mode reports changed revisions and errors/recovery rather than every idle poll. Enrollment approval commands and verification codes remain visible while waiting.

**Scripts must explicitly use `--json`** for the stable contract below. `--json` only changes presentation: it does not imply `--non-interactive`. JSON-mode prompts and diagnostics stay on stderr so stdout remains machine-readable. Unexpected runtime-level failures may still use stderr in either mode.

## Enrollment, interruption and retry

Pending identities are independently persisted as private metadata keyed by canonical server URL, with tokens in the selected credential provider, **before submission**. Retry the same URL/alias to resume without a password or identity change, including after Ctrl-C (exit 130) or lost responses. Approved credentials are persisted and verified before pending state is removed; private metadata/file writes are fsynced. Existing connections return safe summaries rather than re-enrolling. Successful enrollment suggests `client vaults connect`, never automatic binding/sync.

For enrollment requests, the CLI prints `nanosync server devices approve --device-id UUID` and the request verification code to stdout in human mode, or stderr with `--json`. The approval command intentionally omits the unknown server directory, so it prompts on the server. The code is public comparison material, not authorization. An admin URL appears only when capability discovery advertises an enabled UI **and** a trustworthy configured URL; otherwise no link is invented.

Interactive enrollment waits until terminal status, interruption or 24-hour request expiry. Scripts default to submit-and-exit; `--wait-ms 0` explicitly does this, and a finite nonnegative integer waits that many milliseconds. Transient network failures, HTTP 429 and 5xx retry with 250ms exponential backoff capped at 5 seconds within the wait window. Temporary outages retain pending state. Denied/expired outcomes are retained and explained; only explicit `--fresh` replaces a terminal request. `connections view` reports the last observed terminal state (or local expiry); it does not contact servers to refresh approval status.

Every enrollment HTTP exchange (including initial password login and `--fresh` status checks) has a 10-second timeout and is cancellable with Ctrl-C. Finite positive waits also bound in-flight requests by the remaining wait budget; persisted request expiry is always an upper bound. `--wait-ms 0` performs bounded discovery/submission without polling or retrying. Timeouts after pending state exists retain that identity and return pending/expired as appropriate. A login timeout before any identity is persisted returns `REQUEST_TIMEOUT` (exit 5); retry requires the password again. Initial login interruption returns `INTERRUPTED` (130) immediately, without waiting for the password exchange to finish. Retry backoff and polling sleeps are also interruptible. HTML/empty HTTP 429/5xx proxy responses follow the same retry policy as JSON errors.

## Stable machine contract (version 1)

With `--json`, stdout contains one result document: `{ "ok": true, "code": "OK", "data": ... }`. Pending uses code `PENDING_APPROVAL`; terminal enrollment uses `ENROLLMENT_DENIED` or `ENROLLMENT_EXPIRED`. These are successful workflow observations, not thrown errors. Progress, approval instructions, warnings and errors use stderr. Watch progress also uses stderr, leaving a single final stdout result.

Errors are `{ "ok": false, "code": "CODE", "message": "actionable explanation", "exitCode": N }` on stderr, with no stdout result. Parse codes, not human messages. Local codes include `INPUT_REQUIRED`, `INVALID_INPUT`, `CONFLICT`, `NOT_FOUND`, `CANCELLED`, `CONNECTION_IN_USE`, `OPERATION_FAILED`, `INTERRUPTED`; server protocol codes (including `VAULT_DELETED`, `UNAUTHORIZED`, `FORBIDDEN`) pass through. Help remains text even with `--json`.

| Exit | Meaning |
| --- | --- |
| 0 | Completed (including safe existing connection summary) / help |
| 2 | Invalid/missing input or local operation failure |
| 3 | Enrollment pending, resumable |
| 4 | Enrollment denied/expired; explicit fresh required |
| 5 | Remote protocol/authorization/deleted-vault error |
| 130 | Interrupted enrollment/prompt; pending identity retained |

Connection summaries contain only server ID, alias, canonical URL, device ID, status. Pending summaries additionally contain device display name. Tokens, passwords, master keys and recovery secrets never appear in ordinary results.

## Secrets and operational boundaries

The **vault recovery key** (previously called the recovery secret) unlocks the vault’s encryption key locally on new devices; it is not the owner password or a backup of files. Anyone with this key and the encrypted vault data can decrypt the vault. Keep it in a password manager or offline. Losing both it and every client’s saved vault key makes the data unrecoverable with the owner password alone.

Owner password: hidden prompt, `NANOSYNC_PASSWORD`, or `--password-file FILE` on init/add. Vault recovery key input: hidden prompt, `NANOSYNC_RECOVERY_SECRET`, or `--recovery-file FILE` on connect. Existing environment-variable and flag names remain unchanged for compatibility. Protected input files must be owned regular mode-0600 files; secret values are never accepted as arguments. `@inquirer/prompts` supplies input/password/selection/confirmation behavior; no readline/stty password handling.

Server-local creation transiently handles plaintext key material (an intentional owner-machine exception). It saves encrypted-only receipts before delivery and publishes only after exact interactive acknowledgement or verified protected file delivery. Scripted receipts live in `owner-creations/`, keyed by the absolute recovery-output path; retain the same name and path when retrying, including after lost stdout. The receipt verifies the protected file against a secret digest, so a crash after file delivery resumes the original encrypted request without redelivery or duplicate creation. Missing/modified/insecure delivered files fail visibly; restore the original protected output before retrying. An interruption before file delivery can safely regenerate unpublished material. Keep receipts for idempotence; a new output path explicitly starts a new creation. Interactive `owner-creation.json` retains the last acknowledged/completed encrypted request: retrying its name returns the same vault, while a different name can start after completion. Initialization, local creation (including receipt replay/recovery delivery), and the serving runtime share a process-identity `.sync-owner` lock in the server root, never bypassed by yes/force. The runtime holds it until shutdown completes, so a second runtime or local creation fails actionably before touching receipts, recovery output, or ciphertext. Stop the runtime and retry the same creation name/output; existing recovery delivery and receipts are preserved. Startup/provisioning failures and shutdown release ownership; definitively dead process owners are recovered automatically. Metadata-only device view/approve/deny/revoke and vault view/rename/delete remain available while serving; use the browser for live vault creation. Receipts contain no plaintext recovery secrets or vault keys. Do not persist plaintext vault master keys on the server. Recovery is not retrievable later. Keep recovery output and all private state outside sync roots; back up secrets offline.

Deletion immediately tombstones a vault; cleanup may still be pending. It destroys history, encrypted objects and wraps, regardless of offline clients' unsynced work. Recovery secrets cannot replace a server backup. Server backup must capture metadata and objects consistently while stopped. Runtime defaults to loopback; remote access needs external TLS and explicit exposure acknowledgement. Browser administration is opt-in with `server run --web-ui`; configure `--external-origin` to advertise a trustworthy link. Never run multiple serving runtimes against one server directory; stop the runtime for offline storage maintenance/provisioning. See [operations](../../docs/clients-and-operations.md) and [security](../../docs/security.md).

### Local ignore file

For the user-facing guide and examples, see [Ignore rules](../../apps/site/content/docs/ignore-rules.md). The detailed semantics below are retained as a CLI reference.

Create `.nanosyncignore` in the sync root **before first import** to exclude virtual environments and other local-only data. For example:

```gitignore
# local to this device; not uploaded
.venv/
__pycache__/
*.pyc
node_modules/
```

This is a deliberately limited gitignore-style format, **not** `.gitignore` integration. Blank lines and whole-line `#` comments are ignored. A basename (`.venv/`) matches at any depth; a leading `/` anchors to the sync root (`/build/`); a slash elsewhere anchors a relative path to the root (`project/cache/`). `*` and `?` match within one path segment; `**` spans segments. A trailing `/` matches directories and their descendants, not a file of the same name. Patterns without `/` match files or directories at any depth. Rules are exclusions only: `!` negation, bracket expressions, escaping and per-directory ignore files are not supported (invalid syntax fails the pass). Matching is case-sensitive; an excluded directory is never opened or inventoried. The root is never excluded. `.nanosyncignore` is a reserved local control file: it is not uploaded, downloaded or interpreted from other devices. Use an owner-owned regular file, with no group/other write access, at most 64 KiB; unsafe control files fail closed.

Each device can use different rules. Ignored paths are opaque: local changes there are never published as deletions, and remote additions, changes and deletions under those paths never touch local files. A previously tracked ignored entry remains in the shared manifest unchanged when this device publishes other changes; another device without that rule can still update or delete it. Local state records previously ignored identities durably. A remote rename of an ignored tracked entry to an included path fails before apply rather than moving or overwriting the local copy. Removing an ignore rule does **not** automatically reconcile absent, changed or remote-only paths: sync fails visibly rather than guessing whether to upload a local edit or publish a deletion. Move or back up the local copy and reconcile deliberately before unignoring; restore the ignore rule to keep syncing unrelated paths in the meantime. Avoid excluding a parent directory that contains files you still wish to sync; there is no negation to re-include children.

Continuous sync reloads this root file on watcher events and periodic full scans. Changing it during a scan or an in-progress apply aborts; for a persisted interrupted apply, restore the original rules until recovery completes. Do not edit ignore rules concurrently with sync. Ignoring existing remote data does not delete it from the server or reclaim storage. Included links, hardlinks and special files still fail safely.


### Unattended provisioning and deletion

```sh
# Private 0700 parent; secret is read from this owned 0600 file, never argv.
nanosync server init --server-dir /private/server --password-file /private/password --non-interactive --json
nanosync server vaults create --server-dir /private/server --name docs \
  --recovery-output /private/docs-recovery --non-interactive --json
# Destruction: exact UUID confirmation is mandatory even with --yes/--force.
nanosync server vaults delete --server-dir /private/server --vault UUID \
  --confirm-delete UUID --non-interactive --json
```

Use `--wait-ms 0 --json --non-interactive` on connections add to submit and exit 3;
resume the same URL/alias after approval to save credentials and exit 0. Do not treat
pending as success or automatically pass `--fresh` on a denied/expired request.

The embedded browser has separate password sessions, logout and expiry. Browser
creation requires saving the displayed secret, acknowledging it, saving an encrypted
receipt and reentering the secret to publish. Neither normal views nor APIs retrieve
existing secrets. A compromised server can serve malicious JavaScript; browser-side
encryption does not resist this. See [proxy setup](../../docs/clients-and-operations.md#reverse-proxy-example).
For this breaking release, preserve old state and plaintext backups, use fresh
server/client directories, and reconnect deliberately; there is no migration path.

## Credential storage (Linux)

A genuinely new root must explicitly select `--credential-mode protected-file|os-store`
on `client connections add`; interactive use asks if omitted. Recognized current-format
file roots continue without the flag or any display, session bus, or credential store.
Supplying a different mode never converts existing state. Historical `client.json` /
`enrollment.json` formats and partial upgrades are rejected, not treated as empty.

`protected-file` uses checked 0700 directories / 0600 files. Nanosync does **not**
encrypt these files at rest. `os-store` uses the same user's Secret Service default
collection through Bun.secrets (experimental API, validated with Bun 1.4.4,
revision 38afee6c8; the Nix CLI build also passed on Bun 1.4.2 / 744846f84). CLI and desktop share references under the same client root;
there is no desktop credential silo. Linux needs libsecret, GLib and a running,
unlocked user-session Secret Service. The Nix CLI wrapper supplies the libraries;
source installations must make them discoverable by their Bun runtime.

```sh
nanosync client credentials view --client-dir ~/.nanosync
# Stop all watches/owners, review this whole root and its pending enrollments first.
# This affects headless access and temporarily duplicates credentials for staging.
nanosync client credentials migrate --client-dir ~/.nanosync --confirm-migration
nanosync client credentials resume --client-dir ~/.nanosync --confirm-migration
# Only before durable source-cleanup intent:
nanosync client credentials rollback --client-dir ~/.nanosync --confirm-rollback
# Retry a previously authorized connection/fresh-enrollment credential deletion:
nanosync client credentials resume --client-dir ~/.nanosync --confirm-cleanup
```

`--yes` authorizes none of these operations. Migration is protected-file → OS store
only; reverse conversion is not implemented. All replica locks and a separate
credential-operation lease must be available; live owners are refused, never stopped
or bypassed. Stop old binaries before upgrading; concurrently running old versions
are unsupported and cannot be made to obey a new migration barrier.

Migration retains server/device/binding IDs, pending fingerprints/expiry/status,
unbound vault keys and journals. A private **secret-free** phase journal blocks
normal operations until explicit resume/rollback. Target entries are written and
read back before cleanup intent. After that intent recovery is roll-forward only.
Locked/unavailable stores or missing target entries preserve the barrier, not a
plaintext fallback. Do not reset state, re-enroll, or re-enter recovery keys merely
to work around interrupted migration.

Metadata listings never unlock the store. Required reference returning null,
access rejection, and other native errors produce actionable `CREDENTIALS_UNAVAILABLE`
(local exit 2); this deliberately does not claim exact locked/missing classification.
A recorded but inaccessible key is not the same as never having stored a key.
An already-running owner retains its loaded credentials until stopped; keyring
locking does not erase process memory or stop that owner. JS string zeroization
and cancellation of native credential operations are not guaranteed.

An interrupted **initial, unsubmitted** OS credential write retains identity. If
ordinary retry cannot access it, explicitly retry `connections add` with
`--retry-credential-write` and protected password input. Reauthentication is allowed
only while that durable pre-submission phase remains; it never rotates a submitted
identity. An interrupted initial vault-key write can similarly be retried via
`vaults connect --retry-credential-write --recovery-file FILE`; inaccessible committed
keys do not take this path. Password and recovery input are never stored or logged.

Removal preserves a durable secret-free cleanup inventory. Failed cleanup is not
reported as successful deletion. Under authorized cleanup only, a non-secret marker
is stored/read back, affirmatively deleted, and checked absent; replay repeats this
protocol because locked entries can yield false/null without actually being absent.
This covers application-owned entries in the default collection, not manually moved
or duplicated entries elsewhere. No forensic erasure from media/backups is promised.
Desktop trusted code can initialize OS mode explicitly; opening file mode returns a
decision-required result (leave unchanged/use CLI, or explicitly migrate the root).
Desktop onboarding now presents this explicit decision before secret-dependent operations.

## Shared lifecycle intent and explicit continuous Start

```sh
nanosync client settings view --json
nanosync client settings set --start-at-login false --tray-enabled false \
  --keep-syncing-after-close true --expected-revision 0 --json
nanosync client sync --path /absolute/folder --watch
```

`settings set` requires at least one change. Supplying any lifecycle flag requires all three lifecycle booleans, exactly `true` or `false`. Notification-only patches do not require unrelated lifecycle choices.
`--expected-revision` is optional (defaults to the revision just read); stale edits
fail with `CONFLICT`, local exit 2. View/set use the existing JSON envelope with
`data: {settings, nativeEffects:"not-applied"}`. Saving intent does **not** install
startup/tray integration or enforce window-close/background behavior in the CLI. The desktop reconciles real available native effects separately; see [lifecycle implementation and limits](../../docs/desktop-lifecycle.md).

The supported older settings v2 schema added `lifecycle:{startAtLogin,trayEnabled,keepSyncingAfterClose}` and
`continuousRequested:{[bindingId]:"desktop"|"cli"}` to the existing revision and
pause fields. Missing continuous entries mean not requested; the value is the
**accepting owner's origin**, not the latest requesting interface. Defaults are
startup false, tray null (not yet chosen), background-after-close true. Desktop
setup requires an explicit yes/no tray choice. Reads normalize v1/v2 to current v3 preferences in memory only;
explicit preference save, accepted watch, or a new shared runner durably upgrades the record. Runner admission publishes the settings-v3 compatibility barrier under the registry before observation-v2 incident writes, so older executables cannot start another writer after that upgrade. Pause-only
v1 roots stay v1 until that upgrade; the existing pause/resume JSON result remains
`{version:1,revision,globalPaused,bindingPaused}` even when stored settings are v2/v3.

Stop older clients before upgrading. Upgrade serializes registry then settings
and refuses live older/unadvertised owners (`OWNER_INCOMPATIBLE`, local exit 2)
before changing the record. New owner discovery metadata is version 3 (including explicit compatibility with settings v3 and observation v2); the private
control request protocol remains version 1. Old discovery is not silently accepted
or stolen. Older binaries reject unsupported settings versions instead of discarding new preferences.

Connecting and one-shot sync do not request continuous work. Explicit desktop
Start and CLI `sync --watch` persist accepted intent through the same shared watch
seam. A temporary owner rejects an incoming watch with `OWNER_TEMPORARY` (local
exit 2); retry after it finishes or explicitly start continuous sync in that owner.
The desktop never promotes or steals it. A continuous CLI owner remains CLI-owned
even after a desktop request and survives desktop Quit. On desktop restart only
previous desktop-origin accepted intent is eligible; never-started bindings and
CLI-origin intent are not auto-started. Pauses, credential availability, root
identity and owner locks still apply. Closing/Quit does not erase accepted intent.

Desktop setup has five real steps: server enrollment/resume, external approval,
vault/key/native existing folder, lifecycle intent, and finish or explicit Start.
Pending identity survives cancellation/restart; recovery is requested only for a
genuinely absent key (or explicitly retried interrupted key write), never for a
locked store. Existing nonempty folders require acknowledgment. Finish connects
without transfer. Start uses the actual shared continuous runner. Completion now returns
to the connected-folders list/inspector, also shown directly when saved bindings exist.

## Notifications and explicit client diagnostics

```sh
nanosync client settings set --notify-conflicts false --notifications-enabled true --expected-revision 2 --json
nanosync client settings set --notification-names-and-paths false --notify-revoked-access true --notify-persistent-failures true --json
nanosync client diagnostics export --output /absolute/owned/Documents/nanosync-report.json --json --non-interactive
# Optional for this report only: binding IDs and local root paths, never credentials.
nanosync client diagnostics export --output /absolute/owned/Documents/identifying-report.json --include-identifiers --json
```

Settings v3 adds exact `notifications:{enabled,conflicts,revokedAccess,persistentFailures,includeNamesAndPaths}` booleans. Global/category defaults are true; names/paths default false. CLI flags are `--notifications-enabled`, `--notify-conflicts`, `--notify-revoked-access`, `--notify-persistent-failures`, and `--notification-names-and-paths`, each accepting exactly `true|false`. A partial notification patch merges atomically with current preferences; a combined lifecycle+notification patch uses one revision. Empty changes, duplicate/invalid flags and partial lifecycle triples fail locally without modifying state. Global disable preserves independent choices and visible attention. Existing settings view/set envelope remains `{settings,nativeEffects:"not-applied"}`: CLI does not install native effects or promise headless notification delivery. See [native incident/dedup/availability policy](../../docs/desktop-notifications.md).

Default native bodies contain no names/paths/URLs/aliases/device names/remote text. Successes and brief outages do not alert. Confirmed unresolved failures must span five minutes, with a fresh failure after evaluator restart. Actual authorization refusal is not falsely labeled proven device revocation. Durable claim-before-native-submission prevents restart/reply-loss spam, but can lose an alert after a crash; in-app attention remains. A native accepted ID is not proof of display; only explicit native dismissal reason 2 is recorded as dismissed.

Diagnostics requires an explicit absolute `--output` filename in an existing owned directory (ordinary 0755 Documents works). It writes a fresh mode-0600 file with exclusive/no-follow creation, never overwrites any existing file/link, and rejects private/sync-root overlap and unsafe ancestry. No directories are created/chmodded. Success data is exactly `{version:1,exported:true,includeIdentifiers:boolean}`; report bytes are not dumped to stdout. Collection/unsafe destination/existing target/write failures are fixed `DIAGNOSTICS_*` local exit-2 errors, with no success result. A failed protected artifact may remain for inspection.

Reports allowlist real runtime/schema versions, counts, phases, head sequences, safe codes, mode/recovery state and native availability. Missing facts stay null, partial reports explicitly `complete:false`. No native store probing/unlock, sync, recovery, network upload, credentials/hashes/references, file contents/inventories, raw logs/HTTP or environment collection. Default excludes identifying paths/names/URLs. `--include-identifiers` adds only binding IDs and local root paths for that export, never credentials; it is not saved. Nonsecret export remains available during pending migration/removal when the actual registry lease is free. A live registry owner is refused, never bypassed. GUI uses the same collector/writer with a trusted native directory picker and generated filename; renderer paths are not authority.

## Checked local folder opening

```sh
nanosync client open --path /absolute/connected/folder --json
```

Open resolves the saved binding, validates its original root identity and marker,
and opens only that root. It does not create missing folders, unlock credentials,
start sync, or enable continuous intent. The JSON success data is
`{connectionId,opened:true}` in the existing version-1 envelope. An ancestor/CWD
selection follows normal client path selection; this is not an arbitrary file opener.

The Linux CLI adapter requires a desktop session and `xdg-open` on the current PATH;
it launches the resolved program with argv and discarded streams, never a shell.
Headless/unavailable integration returns `NATIVE_INTEGRATION_UNAVAILABLE`, local exit
2; a failed opener returns `OPEN_FAILED`, local exit 2. Ordinary sync/status/pauses
remain headless. The packaged desktop instead retains its build-selected trusted
Nix-store opener, exposed through a binding-UUID-only RPC, not a renderer path.

The desktop Folders list/inspector uses the same non-secret status and independent
pause flags. Protected-file/locked-store metadata and pause intent remain available
without probing a keyring; desktop transfers still require explicit OS-store mode.
Global resume preserves folder pauses; folder resume never bypasses a global pause.
Sync now corresponds to one-shot `client sync`, not `--watch`; it neither persists
continuous intent nor takes over a live owner. Closing its temporary session releases
only its own writer or detaches an external owner. Quit leaves independent CLI work.

Dashboard polling is serialized, stops during setup and rejects pre-mutation replies.
After a failed refresh, cached rows/owner counters are explicitly historical, never
shown as currently observed/up to date. Names not cached locally are not guessed:
server aliases, vault UUIDs and independent copy IDs are shown without secret network
lookups. Conflict/error attention stays visible alongside pause and progress; conflict,
ignore and durable removal tools now use the shared operations described below.

## Shared status and durable pauses

```sh
nanosync client status --client-dir ~/.nanosync
nanosync client status --path /absolute/folder --json
nanosync client pause --all
nanosync client pause --path /absolute/folder
nanosync client resume --all
nanosync client resume --path /absolute/folder
```

Pause/resume require **exactly one** target, `--all` or `--path`. Global and folder
flags are independent and durable; global resume does not clear folder pauses.
Saving a pause acknowledges intent, not completion of an in-flight operation.
Status reports `pausing` until an active owner reaches a checkpoint, then `paused`.
Already-started bounded ciphertext requests and atomic filesystem operations finish
safely; no next request/retry, cached chunk, publication producer step, scan, or apply
mutation starts past the paused checkpoint. Interrupted apply/hydration/proposal and
reconciliation intents remain recovery barriers, including after restart.

An explicit one-shot sync respects pauses (`SYNC_PAUSED`, local exit **2**), including
when forwarded to another owner. A foreground watch remains attached and retries on
its normal polling schedule after resume; pause is progress, not a sync failure.
Pause does not stop the owner or release its lock. Shutdown cancellation remains
separate. No desktop, daemon, display, or unlocked credential store is needed to
inspect status or change pause flags. A settings-only root has **uninitialized**
credential mode; it has not implicitly selected protected-file storage. Connect
still transfers nothing; these commands do not enable automatic or continuous work.

New commands use the existing version-1 JSON envelope and normal success code.
Pause/resume data is `{version:1,revision,globalPaused,bindingPaused}`. Service callers
can pass an expected settings revision to `setPaused`; stale edits fail with
`CONFLICT` and must refresh/retry. Updates serialize separately from credential
operations, reread current settings, atomically replace and fsync before returning.

Status data is `{settingsRevision,globalPaused,observedAt,bindings}`. Each binding has
its existing identity/path, `owner` (origin/instance), `ownerPresent`, independent
`pause` causes/effective flag, `phase`, `enginePhase`, `freshness`, `progressUnit`,
`progress`, `facts`, `upToDate`, `attentionRequired`, safe `error` code, `statusIssues`,
`observationTime`, `lastRemoteCheck`, `lastSuccessfulSync`, and `failureEpisode` (null or the sanitized durable episode ID/onset/last confirmation/code used by notification policy). Progress is completed
ciphertext-frame counts/bytes **reported by the observed owner**, not plaintext,
partial stream bytes, a percentage or a known total. The UI labels current-owner
counters separately from historical owner counters. Cache reads do not count as network transfers. Totals are
unknown. Stale progress is historical, not evidence of active work.

`facts` is null for an uninitialized journal; otherwise it contains observed,
accepted and applied heads, unresolved conflict count, recorded root identity, and
pending operation/transfer/apply/hydration/proposal/restore/reconciliation counts.
Counts reflect durable journal work, not a complete estimate of future transfers.
No raw SQL, plans, file inventory/content or credentials are returned. A bad journal,
unsafe owner record, or malformed saved observation affects only that binding.
`statusIssues` contains allowlisted codes, fixed safe messages, retryability and
recovery actions; normal snapshot races are retryable unknown observations, while
corruption/unsafe state/recovery-required journals require attention. Other folders
remain visible. Missing facts never imply up to date. Malformed settings instead
produce a safe global `SETTINGS_INVALID` error (local exit 2), since pause intent
cannot then be trusted. JSON/native error text is not echoed. Passive status
uses a checked noncreating/nonmigrating read-only SQLite snapshot, not the normal
writer constructor. Schema, migration/replica identity and fact shapes are checked on each poll; full
integrity/foreign-key scans remain at owner startup, not every dashboard read.
Live WAL snapshots use SQLite locking and existing sidecars;
closed journals use an explicitly read-only URI without creating WAL/SHM, rejecting
concurrent file/WAL changes. Missing sidecars requiring recovery fail closed; start
an owner to recover, rather than deleting/resetting the journal.

**Up to date** requires a completed verified observation, matching checked/applied
heads, no pending work/recovery, no conflicts and a matching live owner. Completion
with preserved conflict copies is not up to date. Observed local changes invalidate
it; a stopped/dead owner makes observations stale/unknown. It never proves absence
of edits or remote changes after observation. Last success is persisted separately
and survives pause, error, close and restart; merely opening status does not update it.
Errors remain allowlisted codes, not raw remote response bodies. Brief offline work
and pause do not by themselves require attention; conflicts and actionable failures do.

Missing/replaced roots report `folder-unavailable` (`FOLDER_UNAVAILABLE`, local exit
**2**). Status can select their original saved path. Retry with `client sync` only
after restoring the original owned directory/marker; Nanosync does not recreate it
or scan its absence as an empty tree. New bindings save device/inode identity at
connect. Scanned legacy bindings reuse journal identity. Never-scanned legacy
bindings have no historical inode to verify: only explicit validated first start,
under the replica lock, establishes their identity. A pre-upgrade replacement with
a copied original marker cannot be distinguished retrospectively. Explicit repair
remains the authority for deliberate moves/copies. For a scanned replica, library
`repairConnection(..., 'move')` requires the original filesystem identity (a rename,
not a copied/cross-filesystem tree). It holds replica ownership and refuses a changed
root before publishing repair. `MOVE_REQUIRES_COPY` recommends independent copy repair
for a clean replica; `MOVE_RECOVERY_REQUIRED` requires restoring/inspecting interrupted
state rather than silently discarding it. Same-inode renames retain pending recovery;
unscanned copies with no recovery/history can still be selected explicitly. No
journal reindexing or automatic abandonment is performed. Force disconnect preserves files
and remains subject to ownership locks. Stop old executables before upgrading: older
owners cannot be made to honor new pause, maintenance or removal barriers.

## Conflicts, ignore editing and durable removal

See [shared local operation contracts](../../docs/desktop-local-operations.md) for
exact result schemas, recovery phases and safety limits. CLI additions:

```text
client conflicts view [--path DIRECTORY]
client open [--path DIRECTORY] [--conflict UUID]
client ignores view [--path DIRECTORY]
client ignores validate --file PROTECTED_FILE [--path DIRECTORY]
client ignores set [--path DIRECTORY] --file PROTECTED_FILE --expected-signature SIGNATURE
client removals view [--path DIRECTORY | --server ALIAS_OR_ID]
client removals resume --request-id UUID --confirm-removal
```

Ignore files are bounded 64-KiB fatal UTF-8, owned/regular/nlink-1 mode-0600 input;
empty input is valid. Use the signature from view (`absent` or SHA256). Validation
uses the existing exclusions-only dialect, without printing invalid pattern text.
Saving retains the actual owner's lock/origin and start/pause intent; it starts no
work. Interrupted durable work requires recovery using its original rules first.
A final checked signature comparison precedes atomic rename/fsync; POSIX rename
is not a kernel conditional exchange against noncooperating external editors.

Conflicts have no acknowledge/resolve command: edit/remove unwanted preserved
copies deliberately and sync; applied-manifest reconciliation is authoritative.
The conflict UUID option opens only its checked containing directory.

Existing disconnect/server-remove flags and success shapes remain unchanged;
`--stop-owner` is added as separate explicit consent to safe handoff. `--yes` never
means `--force`, `--stop-owner` or `--confirm-removal`. Full content inventory includes
unscanned edits and yields during streamed hashing. A saved missing root requires
force; it is never recreated or scanned as empty. Foreign markers/replacement roots
and live lock contention are never bypassed by force. Partial removal persists
original identities in a secret-free intent and blocks normal mutation/start;
nonsecret listing and explicit removals resume remain available after records or
aliases disappear. Resume retains the existing provider cleanup inventory until
the outer operation is durably complete. Files, conflict copies, ignore rules and
remote data are preserved; remote access is not revoked. New local safety errors
are exit 2, using the existing version-1 JSON envelopes/streams.
