# `@nanosync/cli` — Bun server, account and foreground sync commands

This package provides server initialization/runtime, server-wide device enrollment, independent encrypted vaults, administration, and foreground Linux synchronization. `sync` and `sync --watch` coordinate `@nanosync/sync-core`, `@nanosync/client-local`, and `@nanosync/linux-client` inside the CLI process. There is no separate service, local IPC, or automatic startup setup.

Install dependencies with `bun install` at the repository root. Run `bun packages/cli/src/main.ts --help` or link the `nanosync` executable. Commands emit JSON. Successful commands exit 0; pending enrollment and authorization failures exit 3; other command errors exit 2 and report structured `{error,state,exitCode}` on stderr.

Typical setup (commands prompt on `/dev/tty` for passwords and recovery secrets):

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
nanosync server run --server-dir "$HOME/nanosync-server"
# In another terminal:
nanosync enroll --url http://127.0.0.1:7337 --name desktop
# On the server, after the enrollment request appears:
nanosync approve desktop --server-dir "$HOME/nanosync-server"
# Retry enroll if the bounded wait expired; it resumes the pending request.
nanosync vault create --name documents
nanosync setup --path "$HOME/Sync" --vault documents
nanosync sync --path "$HOME/Sync"
nanosync sync --watch --path "$HOME/Sync" # optional foreground watcher
```

The default global private state is `~/.nanosync/` (override with `--client-dir`). `setup` creates a secret-free `.nanosync` marker in the selected directory and a private connection record and replica journal under the global state. `sync` finds the nearest marker from the current directory or `--path`; each connection has its own journal and lock, even for two directories connected to the same vault. A copied marker cannot reuse the original connection: use `setup --repair copy --confirm-nonempty --path NEW_ROOT` to create an independent replica, or `setup --repair move --path NEW_ROOT` after the original root no longer exists to preserve its journal. Nested/overlapping sync roots are rejected. Setup does not transfer files; for a nonempty directory, review its contents and pass `--confirm-nonempty`. The first sync merges existing local content with authenticated remote history. `vault list` and `vault rename VAULT --name NEW_NAME` manage names; connections remain bound to immutable vault UUIDs. Remote deletion is unavailable.

## Secrets, backup, and network boundary

`vault create` generates a different master key and recovery secret for each vault. It displays the secret on a terminal and requires exact confirmation before remote creation. Store it offline. An interrupted creation leaves an owner-only `vault-creation.json` checkpoint containing the **plaintext vault master key and recovery secret**; retry the same server and vault name to finish, then the checkpoint is removed. Protect the global state, its keys, and backups accordingly. For unattended creation supply an owner-only, previously nonexistent `--recovery-output FILE` outside sync roots; its contents are the deliberate recovery-secret delivery. Keep it offline. A lost key can be recovered during `setup` with the vault's secret; device approval by itself never distributes keys.

For automation, use `server init --env` with `NANOSYNC_PASSWORD`, and `enroll --env` with `NANOSYNC_SERVER`, `NANOSYNC_PASSWORD`, and `NANOSYNC_DEVICE_NAME` (a pending enrollment resumes without requiring the password). `setup --env` requires `--server`, `--vault`, `--path` when selection is ambiguous; supply `NANOSYNC_RECOVERY_SECRET` only when the local vault key is missing. Use `--wait-ms 0` to avoid waiting for approval and retry enrollment later. Use `--recovery-output` for automated vault creation; never pass secrets in command-line arguments. Back up metadata and immutable objects together while stopped, not by copying a live SQLite database; see the operations guide. The pepper invalidates sessions if lost.

The server defaults to `127.0.0.1:7337`. Non-loopback exposure requires `--host HOST --acknowledge-exposure` and an external TLS/VPN boundary; the server has no built-in transport encryption. Use HTTPS via a trusted proxy for all routes or a VPN. Never expose bare HTTP to an untrusted network. The integrity scanner runs on server startup; offline GC is not run by the server.

## Devices and administration

Enroll each device once per server with a unique name. The pending request is persisted for retries. On the server, use `nanosync approve NAME --server-dir DIR` (or `nanosync devices --server-dir DIR` to list); a locally approved device has access to all vaults, but needs each vault's recovery secret or previously stored key to decrypt it. A device name can be reused after revocation. Restrict backups of registration tokens and keys. Legacy `bootstrap`, `client.json`, `--sync-dir`, and `--continuous` remain for compatibility with existing tests and deployments, but new setups should use the separate commands above.

Admin commands (`admin storage`, `retention-dry-run`, `gc-dry-run`, `scan`, `diagnostics`) use an approved administrator client. Reports are aggregate-only; scans check at most 100 objects per invocation. GC commands are dry-run only; no live GC command exists. See [Clients and Operations](../../docs/clients-and-operations.md) for maintenance and backup procedures.

## Foreground sync

The one-shot command recovers interrupted work, reconciles encrypted revisions (including a pre-existing nonempty directory), and exits after a successful authenticated pass. The watcher first synchronizes, then debounces activity and periodically rescans/retries failures. SIGINT/SIGTERM stops it after any in-flight pass. Concurrent runs of the same connection are refused; independent connections may sync concurrently. There is no local IPC or CLI status/history/restore/conflict/eviction command.

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
