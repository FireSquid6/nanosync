# `@nanosync/cli` — explicit server and client commands

Install workspace dependencies with `bun install`. Run `bun packages/cli/src/main.ts --help`.
This is a breaking command/state redesign: no legacy aliases, bootstrap command, credential migration, `--env`, `--sync-dir` or `--continuous`.

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
nanosync server run --server-dir "$HOME/nanosync-server"
# On the client:
nanosync client connections add --url https://sync.example.com --alias home
# On the server, compare the verification code and use the exact printed UUID:
nanosync server devices approve --device-id UUID
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
# Deliver the creation recovery secret offline to the client:
nanosync client vaults connect --server home --vault documents --path "$HOME/Sync"
nanosync client sync --path "$HOME/Sync"
nanosync client sync --watch --path "$HOME/Sync"
```

## Commands and selection

- `server init`, `server run`: owner password initialization and foreground runtime. Run supports `--host`, `--port`, `--acknowledge-exposure`, `--web-ui`, `--external-origin`, and `--trusted-proxy` (exact peer IP).
- `server devices view|approve|deny|revoke`: local owner operations. Mutations use `--device-id UUID`, never display names. Revocation requires ordinary confirmation or `--yes`; it prevents access, not erasure of retained data/keys.
- `server vaults view|create|rename|delete`: creation uses `--name` and optional protected `--recovery-output FILE`. Rename uses `--vault UUID --name NAME`. Delete requires exact name entry interactively, or `--vault UUID --confirm-delete SAME_UUID --non-interactive` in scripts. Neither `--yes` nor `--force` substitutes.
- `server admin storage|retention-dry-run|gc-dry-run|scan|diagnostics`: existing local aggregate reports/maintenance. GC remains dry-run; scan processes a bounded batch.
- `client connections add|remove|view`: add uses `--url`, `--alias`, `--device-name`, `--wait-ms`, `--fresh`, `--password-file`. Alias is unique local selection vocabulary, independent of the owner-visible device name (hostname offered by default). Remove uses `--server ALIAS_OR_ID` and optional `--force`; it never remotely revokes. View omits credentials.
- `client vaults connect|disconnect|view`: connect uses `--server ALIAS_OR_ID`, `--vault NAME_OR_UUID`, `--path DIRECTORY`, `--confirm-nonempty`, `--recovery-file`. Interactive server/vault choices use maintained selection prompts. Path defaults to CWD. Recovery is requested only when the key is absent. Binding transfers no files. Multiple independent nonoverlapping directory replicas are allowed. Disconnect uses `--path` (CWD default) and optional `--force`, preserving files and remote data.
- `client sync`: nearest binding at CWD or an ancestor; explicit `--path` and foreground `--watch`. Deleted vaults return `VAULT_DELETED`, stop syncing, and preserve files and cached keys. Disconnect the obsolete binding; reconnect to a separately provisioned vault deliberately.

All server commands require `--server-dir DIRECTORY` or prompt for it; **no implicit server directory**. Every command accepts `--json --non-interactive --yes`. Non-terminal execution and `--non-interactive` never prompt. All selections have non-secret flags. `--yes` is only an ordinary confirmation, never permission to abandon unsynced work or bypass locks. Client state defaults to `~/.nanosync` (`--client-dir DIRECTORY`). Private state directories must be owned real directories with mode 0700.

Removal refuses attached bindings unless `--force` is explicit. Disconnect conservatively requires force when any user files or a replica database exist; the subsequent binding-safety slice will refine this into an exact dirty-files/journal check. Forced operations warn about discarded pending sync state, acquire every affected replica lock before mutation, and preserve local files. Force/yes never bypass a live lock.

## Enrollment, interruption and retry

Pending requests are independently persisted in protected files keyed by canonical server URL **before submission**. Retry the same URL/alias to resume without a password or identity change, including after Ctrl-C (exit 130) or lost responses. Approved credentials are fsynced before pending state is removed. Existing connections return safe summaries rather than re-enrolling. Successful enrollment suggests `client vaults connect`, never automatic binding/sync.

The CLI always prints `nanosync server devices approve --device-id UUID` and the request verification code to stderr. The approval command intentionally omits the unknown server directory, so it prompts on the server. The code is public comparison material, not authorization. An admin URL appears only when capability discovery advertises an enabled UI **and** a trustworthy configured URL; otherwise no link is invented.

Interactive enrollment waits until terminal status, interruption or 24-hour request expiry. Scripts default to submit-and-exit; `--wait-ms 0` explicitly does this, and a finite nonnegative integer waits that many milliseconds. Transient network failures, HTTP 429 and 5xx retry with 250ms exponential backoff capped at 5 seconds within the wait window. Temporary outages retain pending state. Denied/expired outcomes are retained and explained; only explicit `--fresh` replaces a terminal request. `connections view` reports the last observed terminal state (or local expiry); it does not contact servers to refresh approval status.

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

Server-local creation transiently handles plaintext key material (an intentional owner-machine exception), delivers a recovery secret with exact acknowledgement or a newly created protected output file, then persists **only encrypted creation bytes** in `owner-creation.json` for replay. Retry the same name after interruption; an acknowledged encrypted checkpoint replays without redelivery. If interrupted after delivery but before checkpoint persistence, no vault mutation occurred: retain the delivered file for inspection and explicitly choose a fresh unused output path for a new attempt. Do not persist plaintext vault master keys on the server. Recovery is not retrievable later. Keep recovery output and all private state outside sync roots; back up secrets offline.

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
