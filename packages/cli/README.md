# `@nanosync/cli` — Bun server, account and foreground sync commands

This package provides server initialization/runtime, client bootstrap/enrollment, device approval/revocation, administrator maintenance reports, and foreground Linux synchronization. `sync` and `sync --continuous` coordinate `@nanosync/sync-core`, `@nanosync/client-local`, and `@nanosync/linux-client` inside the CLI process. There is no separate service package, local IPC, or automatic startup setup.

Install dependencies with `bun install` at the repository root. Run `bun packages/cli/src/main.ts --help` or link the `nanosync` executable. Commands emit JSON. Successful commands exit 0; pending enrollment and authorization failures exit 3; other command errors exit 2 and report structured `{error,state,exitCode}` on stderr.

Typical local setup (password is read from stdin, not an argument):

```sh
bun packages/cli/src/main.ts server init --server-dir "$HOME/nanosync-server"
bun packages/cli/src/main.ts server run --server-dir "$HOME/nanosync-server"
read -rsp 'New password: ' PASSWORD; printf '\n'
printf '%s' "$PASSWORD" | bun packages/cli/src/main.ts bootstrap \
  --client-dir "$HOME/.local/share/nanosync" --url http://127.0.0.1:7337 \
  --proof-file "$HOME/nanosync-server/bootstrap.hex"
unset PASSWORD
```

Create an owner-only ordinary sync directory, separate from the private client directory. In another terminal run `nanosync sync --client-dir "$HOME/.local/share/nanosync" --sync-dir "$HOME/Sync"` for one pass, or add `--continuous` for foreground watching. You decide how to launch it at login; no service or startup configuration is installed.

## Secrets, backup, and network boundary

Bootstrap displays the recovery secret privately through `/dev/tty` and requires exact confirmation. Store it offline. Before server initialization, the client fsyncs `bootstrap.checkpoint`, mode 0600, containing a **plaintext vault master key**, encrypted genesis, and recovery wrap (not the recovery secret or password). Protect the checkpoint directory and backups like the eventual `client.json` key; mode 0600 does not protect against the owner or compromised backups. Rerun the same bootstrap command and retain the checkpoint if interrupted: a wrong password on a retry may seal bootstrap before login fails. Never delete it to start over; loss after initialization requires offline operator recovery.

Read passwords from stdin; avoid shell history/arguments and remember shell variables remain in memory. Never put secrets in URLs or logs. `server init` creates private pepper and bootstrap-proof files; losing the pepper invalidates sessions. Back up metadata and immutable objects together: stop the server and copy its private directory, including SQLite WAL/SHM files. Never copy a live SQLite database. Restore into a separate private directory while stopped, verify database integrity and referenced objects, then review device revocations and client heads before reconnecting. There is no backup/restore CLI; migrations run on open, so back up before upgrading. Legacy migration-1 vaults without account identities need offline operator migration.

The server defaults to `127.0.0.1:7337`. Non-loopback exposure requires `--host HOST --acknowledge-exposure` and an external TLS/VPN boundary; the server has no built-in transport encryption. Use HTTPS via a trusted proxy for all routes or a VPN. Never expose bare HTTP to an untrusted network. The integrity scanner runs on server startup; offline GC is not run by the server.

## Devices and administration

Enroll each device with its own retained UUID, for example `nanosync enroll --client-dir "$HOME/second-client" --url https://SERVER --device-id UUID`. Enrollment state is written before the request so retries reuse the same pending session/fingerprint. Approve it from the first device with `nanosync devices` and `nanosync approve UUID`; after approval, repeat enrollment and supply the recovery key via an owned mode-0600 file or `/dev/tty`. The completed `client.json` holds the token and vault key; restrict backups. Do not casually remove pending enrollment state.

Admin commands (`admin storage`, `retention-dry-run`, `gc-dry-run`, `scan`, `diagnostics`) use an approved administrator client. Reports are aggregate-only; scans check at most 100 objects per invocation. GC commands are dry-run only; no live GC command exists. See [Clients and Operations](../../docs/clients-and-operations.md) for maintenance and backup procedures.

## Foreground sync

The one-shot command recovers interrupted work, reconciles encrypted revisions, and exits after a successful authenticated pass. An existing folder can be imported on first sync only if the server still has empty genesis; when the remote already contains files, a fresh device must start with an empty local sync directory rather than risk overwriting or deleting its untracked files. The continuous command first synchronizes, then debounces file activity (250 ms quiet plus two stable snapshots at least 500 ms apart), periodically rescans and retries failures. SIGINT/SIGTERM ends the foreground loop after any in-flight pass. Concurrent runs for the same client directory are refused. There is no local IPC or CLI status/history/restore/conflict/eviction command.

### Local ignore file

Create `--sync-dir/.nanosyncignore` **before first import** to exclude virtual environments and other local-only data. For example:

```gitignore
# local to this device; not uploaded
.venv/
__pycache__/
*.pyc
node_modules/
```

This is a deliberately limited gitignore-style format, **not** `.gitignore` integration. Blank lines and whole-line `#` comments are ignored. A basename (`.venv/`) matches at any depth; a leading `/` anchors to the sync root (`/build/`); a slash elsewhere anchors a relative path to the root (`project/cache/`). `*` and `?` match within one path segment; `**` spans segments. A trailing `/` matches directories and their descendants, not a file of the same name. Patterns without `/` match files or directories at any depth. Rules are exclusions only: `!` negation, bracket expressions, escaping and per-directory ignore files are not supported (invalid syntax fails the pass). Matching is case-sensitive; an excluded directory is never opened or inventoried. The root is never excluded. `.nanosyncignore` is a reserved local control file: it is not uploaded, downloaded or interpreted from other devices. Use an owner-owned regular file, with no group/other write access, at most 64 KiB; unsafe control files fail closed.

Each device can use different rules. Ignored paths are opaque: local changes there are never published as deletions, and remote additions, changes and deletions under those paths never touch local files. A previously tracked ignored entry remains in the shared manifest unchanged when this device publishes other changes; another device without that rule can still update or delete it. Local state records previously ignored identities durably. Removing an ignore rule does **not** automatically reconcile absent, changed or remote-only paths: sync fails visibly rather than guessing whether to upload a local edit or publish a deletion. Move or back up the local copy and reconcile deliberately before unignoring; restore the ignore rule to keep syncing unrelated paths in the meantime. Avoid excluding a parent directory that contains files you still wish to sync; there is no negation to re-include children.

Continuous sync reloads this root file on watcher events and periodic full scans. Changing it during a scan or an in-progress apply aborts; for a persisted interrupted apply, restore the original rules until recovery completes. Do not edit ignore rules concurrently with sync. Ignoring existing remote data does not delete it from the server or reclaim storage. Included links, hardlinks and special files still fail safely.
