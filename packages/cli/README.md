# `@nanosync/cli` — Bun server and account commands

This package provides server initialization/runtime, client bootstrap/enrollment, device approval/revocation, and administrator maintenance reports. It does **not** ship a client daemon, local IPC, or CLI sync/status/history/restore/conflict/eviction commands. Users integrate and supervise their own sync runner using `@nanosync/sync-core`, `@nanosync/client-local`, and `@nanosync/linux-client`.

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

## Secrets, backup, and network boundary

Bootstrap displays the recovery secret privately through `/dev/tty` and requires exact confirmation. Store it offline. Before server initialization, the client fsyncs `bootstrap.checkpoint`, mode 0600, containing a **plaintext vault master key**, encrypted genesis, and recovery wrap (not the recovery secret or password). Protect the checkpoint directory and backups like the eventual `client.json` key; mode 0600 does not protect against the owner or compromised backups. Rerun the same bootstrap command and retain the checkpoint if interrupted: a wrong password on a retry may seal bootstrap before login fails. Never delete it to start over; loss after initialization requires offline operator recovery.

Read passwords from stdin; avoid shell history/arguments and remember shell variables remain in memory. Never put secrets in URLs or logs. `server init` creates private pepper and bootstrap-proof files; losing the pepper invalidates sessions. Back up metadata and immutable objects together: stop the server and copy its private directory, including SQLite WAL/SHM files. Never copy a live SQLite database. Restore into a separate private directory while stopped, verify database integrity and referenced objects, then review device revocations and client heads before reconnecting. There is no backup/restore CLI; migrations run on open, so back up before upgrading. Legacy migration-1 vaults without account identities need offline operator migration.

The server defaults to `127.0.0.1:7337`. Non-loopback exposure requires `--host HOST --acknowledge-exposure` and an external TLS/VPN boundary; the server has no built-in transport encryption. Use HTTPS via a trusted proxy for all routes or a VPN. Never expose bare HTTP to an untrusted network. The integrity scanner runs on server startup; offline GC is not run by the server.

## Devices and administration

Enroll each device with its own retained UUID, for example `nanosync enroll --client-dir "$HOME/second-client" --url https://SERVER --device-id UUID`. Enrollment state is written before the request so retries reuse the same pending session/fingerprint. Approve it from the first device with `nanosync devices` and `nanosync approve UUID`; after approval, repeat enrollment and supply the recovery key via an owned mode-0600 file or `/dev/tty`. The completed `client.json` holds the token and vault key; restrict backups. Do not casually remove pending enrollment state.

Admin commands (`admin storage`, `retention-dry-run`, `gc-dry-run`, `scan`, `diagnostics`) use an approved administrator client. Reports are aggregate-only; scans check at most 100 objects per invocation. GC commands are dry-run only; no live GC command exists. See [Clients and Operations](../../docs/clients-and-operations.md) for maintenance and backup procedures.
