# `@nanosync/cli` — explicit server and client commands

Install workspace dependencies with `bun install`. Run `bun packages/cli/src/main.ts --help`.
This is a breaking command/state redesign: no legacy aliases, bootstrap command, credential migration, `--env`, `--sync-dir` or `--continuous`.

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
# Provision locally while the runtime is stopped; save the recovery secret.
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
nanosync server run --server-dir "$HOME/nanosync-server" --web-ui
# In another terminal/on the client:
nanosync client connections add --url https://sync.example.com --alias home
# On the server, compare the verification code and use the exact printed UUID:
nanosync server devices approve --device-id UUID
# Deliver the creation recovery secret offline to the client:
mkdir -p "$HOME/Sync"
nanosync client vaults connect --server home --vault documents --path "$HOME/Sync"
nanosync client sync --path "$HOME/Sync"
nanosync client sync --watch --path "$HOME/Sync"
```

## Commands and selection

- `server init`, `server run`: owner password initialization and foreground runtime. Run supports `--host`, `--port`, `--acknowledge-exposure`, `--web-ui`, `--external-origin`, and `--trusted-proxy` (exact peer IP).
- `server devices view|approve|deny|revoke`: local owner operations. Mutations use `--device-id UUID`, never display names. Revocation requires ordinary confirmation or `--yes`; it prevents access, not erasure of retained data/keys.
- `server vaults view|create|rename|delete`: creation uses `--name` and optional protected `--recovery-output FILE`. Rename uses `--vault UUID --name NAME`. Delete requires exact name entry interactively, or `--vault UUID --confirm-delete SAME_UUID --non-interactive` in scripts. Neither `--yes` nor `--force` substitutes.
- `server admin storage|retention-dry-run|gc-dry-run|scan|diagnostics`: local aggregate reports/maintenance, requiring the runtime to be stopped because report setup initializes/recovers object storage. GC remains dry-run; scan processes a bounded batch.
- `client connections add|remove|view`: add uses `--url`, `--alias`, `--device-name`, `--wait-ms`, `--fresh`, `--password-file`. Alias is unique local selection vocabulary, independent of the owner-visible device name (hostname offered by default). Remove uses `--server ALIAS_OR_ID` and optional `--force`; it never remotely revokes. View omits credentials.
- `client vaults connect|disconnect|view`: connect uses `--server ALIAS_OR_ID`, `--vault NAME_OR_UUID`, `--path DIRECTORY`, `--confirm-nonempty`, `--recovery-file`. Interactive server/vault choices use maintained selection prompts. Path defaults to CWD. Recovery is requested only when the key is absent. Binding transfers no files. Multiple independent nonoverlapping directory replicas are allowed. Disconnect uses `--path` (CWD default) and optional `--force`, preserving files and remote data.
- `client sync`: nearest binding at CWD or an ancestor; explicit `--path` and foreground `--watch`. Deleted vaults return `VAULT_DELETED`, stop syncing, and preserve files and cached keys. Disconnect the obsolete binding; reconnect to a separately provisioned vault deliberately.

All server commands require `--server-dir DIRECTORY` or prompt for it; **no implicit server directory**. Every command accepts `--json --non-interactive --yes`. Non-terminal execution and `--non-interactive` never prompt. All selections have non-secret flags. `--yes` is only an ordinary confirmation, never permission to abandon unsynced work or bypass locks. Client state defaults to `~/.nanosync` (`--client-dir DIRECTORY`). Private state directories must be owned real directories with mode 0700.

Removal refuses attached bindings unless `--force` is explicit. Disconnect checks pending journals and a full, no-follow filesystem inventory/content hash against the last applied state, including edits not yet scanned by sync. Unsynced work requires explicit `--force`; synchronized plaintext can be disconnected without force. Forced operations discard pending sync state and preserve local files. All affected replica locks are acquired in UUID order before mutation. A contended lock leaves every binding intact. A process-identity registry gate serializes bind/repair/disconnect/server removal and sync lock handoff, preventing new bindings from racing credential removal. Force/yes never bypass either gate or a live replica lock.

## Enrollment, interruption and retry

Pending requests are independently persisted in protected files keyed by canonical server URL **before submission**. Retry the same URL/alias to resume without a password or identity change, including after Ctrl-C (exit 130) or lost responses. Approved credentials are fsynced before pending state is removed. Existing connections return safe summaries rather than re-enrolling. Successful enrollment suggests `client vaults connect`, never automatic binding/sync.

The CLI always prints `nanosync server devices approve --device-id UUID` and the request verification code to stderr. The approval command intentionally omits the unknown server directory, so it prompts on the server. The code is public comparison material, not authorization. An admin URL appears only when capability discovery advertises an enabled UI **and** a trustworthy configured URL; otherwise no link is invented.

Interactive enrollment waits until terminal status, interruption or 24-hour request expiry. Scripts default to submit-and-exit; `--wait-ms 0` explicitly does this, and a finite nonnegative integer waits that many milliseconds. Transient network failures, HTTP 429 and 5xx retry with 250ms exponential backoff capped at 5 seconds within the wait window. Temporary outages retain pending state. Denied/expired outcomes are retained and explained; only explicit `--fresh` replaces a terminal request. `connections view` reports the last observed terminal state (or local expiry); it does not contact servers to refresh approval status.

Every HTTP exchange (including initial password login and `--fresh` status checks) has a 10-second timeout and is cancellable with Ctrl-C. Finite positive waits also bound in-flight requests by the remaining wait budget; persisted request expiry is always an upper bound. `--wait-ms 0` performs bounded discovery/submission without polling or retrying. Timeouts after pending state exists retain that identity and return pending/expired as appropriate. A login timeout before any identity is persisted returns `REQUEST_TIMEOUT` (exit 5); retry requires the password again. Initial login interruption returns `INTERRUPTED` (130) immediately, without waiting for the password exchange to finish. Retry backoff and polling sleeps are also interruptible. HTML/empty HTTP 429/5xx proxy responses follow the same retry policy as JSON errors.

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

Owner password: hidden prompt, `NANOSYNC_PASSWORD`, or `--password-file FILE` on init/add. Recovery input: hidden prompt, `NANOSYNC_RECOVERY_SECRET`, or `--recovery-file FILE` on connect. Protected input files must be owned regular mode-0600 files; secret values are never accepted as arguments. `@inquirer/prompts` supplies input/password/selection/confirmation behavior; no readline/stty password handling.

Server-local creation transiently handles plaintext key material (an intentional owner-machine exception). It saves encrypted-only receipts before delivery and publishes only after exact interactive acknowledgement or verified protected file delivery. Scripted receipts live in `owner-creations/`, keyed by the absolute recovery-output path; retain the same name and path when retrying, including after lost stdout. The receipt verifies the protected file against a secret digest, so a crash after file delivery resumes the original encrypted request without redelivery or duplicate creation. Missing/modified/insecure delivered files fail visibly; restore the original protected output before retrying. An interruption before file delivery can safely regenerate unpublished material. Keep receipts for idempotence; a new output path explicitly starts a new creation. Interactive `owner-creation.json` retains the last acknowledged/completed encrypted request: retrying its name returns the same vault, while a different name can start after completion. Initialization, local creation (including receipt replay/recovery delivery), and the serving runtime share a process-identity `.sync-owner` lock in the server root, never bypassed by yes/force. The runtime holds it until shutdown completes, so a second runtime or local creation fails actionably before touching receipts, recovery output, or ciphertext. Stop the runtime and retry the same creation name/output; existing recovery delivery and receipts are preserved. Startup/provisioning failures and shutdown release ownership; definitively dead process owners are recovered automatically. Metadata-only device view/approve/deny/revoke and vault view/rename/delete remain available while serving; use the browser for live vault creation. Receipts contain no plaintext recovery secrets or vault keys. Do not persist plaintext vault master keys on the server. Recovery is not retrievable later. Keep recovery output and all private state outside sync roots; back up secrets offline.

Deletion immediately tombstones a vault; cleanup may still be pending. It destroys history, encrypted objects and wraps, regardless of offline clients' unsynced work. Recovery secrets cannot replace a server backup. Server backup must capture metadata and objects consistently while stopped. Runtime defaults to loopback; remote access needs external TLS and explicit exposure acknowledgement. Browser administration is opt-in with `server run --web-ui`; configure `--external-origin` to advertise a trustworthy link. Never run multiple serving runtimes against one server directory; stop the runtime for offline storage maintenance/provisioning. See [operations](../../docs/clients-and-operations.md) and [security](../../docs/security.md).

### Local ignore file

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
