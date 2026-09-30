# `@nanosync/cli` — Bun commands for Linux

This package is Nanosync's Bun command entrypoint for setting up/running the local server and daemon, managing a Linux client, and performing authenticated administrator tasks. It uses the daemon's private local IPC for client operations and the server API for enrollment and administration.

Install Bun and dependencies with `bun install` at the repository root. Run `bun packages/cli/src/main.ts --help` or link the package's `nanosync` executable. Commands emit JSON and stable status exit codes: 0 synchronized, 2 command error, 3 authorization/approval, 4 pending/active/paused/remote-only, 5 offline, 6 integrity, 7 capacity, 8 conflict. See [Clients and Operations](../../docs/clients-and-operations.md) for details.

Typical local setup (password is read from stdin, not an argument):

```sh
bun packages/cli/src/main.ts server init --server-dir "$HOME/nanosync-server"
bun packages/cli/src/main.ts server run --server-dir "$HOME/nanosync-server"
read -rsp 'New password: ' PASSWORD; printf '\n'
printf '%s' "$PASSWORD" | bun packages/cli/src/main.ts bootstrap \
  --client-dir "$HOME/.local/share/nanosync" --url http://127.0.0.1:7337 \
  --proof-file "$HOME/nanosync-server/bootstrap.hex"
unset PASSWORD
bun packages/cli/src/main.ts daemon --client-dir "$HOME/.local/share/nanosync" --sync-dir "$HOME/Sync"
```

## Secrets, backup, and network boundary

Bootstrap displays the recovery secret privately through `/dev/tty` and requires exact confirmation. Store it offline. Before server initialization, the client fsyncs `bootstrap.checkpoint`, mode 0600, containing a **plaintext vault master key**, encrypted genesis, and recovery wrap (not the recovery secret or password). Protect the checkpoint directory and backups like the eventual `client.json` key; mode 0600 does not protect against the owner or compromised backups. Rerun the same bootstrap command and retain the checkpoint if interrupted: a wrong password on a retry may seal bootstrap before login fails. Never delete it to start over; loss after initialization requires offline operator recovery.

Read passwords from stdin; avoid shell history/arguments and remember shell variables remain in memory. Never put secrets in URLs or logs. `server init` creates private pepper and bootstrap-proof files; losing the pepper invalidates sessions. Back up metadata and immutable objects together: stop the server and copy its private directory, including SQLite WAL/SHM files. Never copy a live SQLite database. Restore into a separate private directory while stopped, verify database integrity and referenced objects, then review device revocations and client heads before reconnecting. There is no backup/restore CLI; migrations run on open, so back up before upgrading. Legacy migration-1 vaults without account identities need offline operator migration.

The server defaults to `127.0.0.1:7337`. Non-loopback exposure requires `--host HOST --acknowledge-exposure` and an external TLS/VPN boundary; the server has no built-in transport encryption. Use HTTPS via a trusted proxy for all routes or a VPN. Never expose bare HTTP to an untrusted network. The integrity scanner runs on server startup; offline GC is not run by the server.

## Devices and conflict resolution

Enroll each device with its own retained UUID, for example `nanosync enroll --client-dir "$HOME/second-client" --url https://SERVER --device-id UUID`. Enrollment state is written before the request so retries reuse the same pending session/fingerprint. Approve it from the first device with `nanosync devices` and `nanosync approve UUID`; after approval, repeat enrollment and supply the recovery key via an owned mode-0600 file or `/dev/tty`. The completed `client.json` holds the token and vault key; restrict backups. Do not casually remove pending enrollment state.

Admin commands (`admin storage`, `retention-dry-run`, `gc-dry-run`, `scan`, `diagnostics`) use an approved administrator client. Reports are aggregate-only; scans check at most 100 objects per invocation. GC commands are dry-run only; no live GC command exists. See the operations guide for maintenance and backup procedures.

`restore REVISION [PATH]` publishes a new revision, not a history rewind; synchronize devices afterward. `conflicts` lists live conflict copies. Inspect both files before `resolve 'EXACT/PATH' --confirm-discard`: it synchronizes pending edits and tombstones that file copy, leaving prior bytes in immutable history. It does not merge contents or resolve directory/location conflicts and requires a running daemon.
