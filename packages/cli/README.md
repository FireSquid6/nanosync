# Bun CLI (Linux)

Install Bun and dependencies with `bun install` from the repository root. Run
`bun packages/cli/src/main.ts --help` or link the `@nanosync/cli` bin as `nanosync`.
The CLI uses a single daemon per private client directory; local commands require
its owner-only Unix socket and the separately provisioned IPC secret. Commands
return JSON and use stable process exit codes: 0 synchronized/success, 2 unknown
or command error, 3 authentication/approval required, 4 pending/active/paused
or remote-only state, 5 offline, 6 integrity failure, 7 capacity incomplete,
8 unresolved conflict. See `docs/clients-and-operations.md` for status details.

```sh
bun packages/cli/src/main.ts server init --server-dir "$HOME/nanosync-server"
bun packages/cli/src/main.ts server run --server-dir "$HOME/nanosync-server"
# In a second terminal: password is read from stdin, never an argv value.
read -rsp 'New password: ' PASSWORD; printf '\n'
printf '%s' "$PASSWORD" | bun packages/cli/src/main.ts bootstrap \
  --client-dir "$HOME/.local/share/nanosync" --url http://127.0.0.1:7337 \
  --proof-file "$HOME/nanosync-server/bootstrap.hex"
unset PASSWORD
bun packages/cli/src/main.ts daemon --client-dir "$HOME/.local/share/nanosync" --sync-dir "$HOME/Sync"
bun packages/cli/src/main.ts status --json
```

Bootstrap **requires `/dev/tty`** to show the recovery secret once, privately,
and demands an exact confirmation before any server mutation. Store it offline.
The client fsyncs a private 0600 `bootstrap.checkpoint` containing the vault
identity, master key, encrypted genesis and recovery *wrap* (not the recovery
secret, password, password verifier or password-derived digest) before
initialize. If interrupted, rerun the **same** bootstrap command against the
same client directory and server, supplying the password on stdin. When the
server has initialized but has no head, the operator proof authorizes
completion of the saved genesis independently of the supplied password.
**A wrong password on this retry may seal the server before normal login
rejects it**, but the checkpoint remains intact: rerun with the correct
password to recover the first device. If the server is still uninitialized,
it has no verifier: the password supplied on retry becomes the account
password. A failed login on an existing account never removes the checkpoint. The client
replays the saved genesis bytes and will not show the recovery key again.
Do not delete the checkpoint to start another vault: if
its secret file is lost after server initialization, offline operator recovery
is required. The checkpoint is removed only after `client.json` is durably
published using a no-replace link. The checkpoint contains a **plaintext vault
master key**: anyone able to copy it can decrypt the vault. Protect its
directory and all backups as rigorously as the eventual `client.json` key;
file mode 0600 does not protect against the owner account or compromised backups.
Passwords passed through a
shell variable may remain in shell memory; prefer an isolated password-input
helper with stdin and avoid shell history. Never paste secrets into arguments,
URLs, logs, or a world-readable file. `server init` creates owned 0600 pepper
and bootstrap-proof files in a real 0700 directory. Losing the pepper invalidates
all sessions. Back up the server metadata **and** immutable object store together.
For a consistent offline backup, stop the server, copy its entire private
directory (`metadata.sqlite`, any SQLite WAL/SHM files, `objects/`, pepper and
bootstrap proof), verify the copies and store them with equivalent permissions.
Do not copy a live SQLite database file. Restore to a separate private
directory while stopped; verify database integrity and referenced objects
before promotion. Review device revocations and client head sequences before
reconnecting clients: an older restored head is not automatically safe to
expose. There is no shipped backup/restore or migration CLI. Database schema
migrations run on open; back up before upgrading. Legacy migration-1 vaults
without account identities need offline operator migration, not network
bootstrap. See `docs/clients-and-operations.md` for the restore checklist.

Second device: choose and retain a UUID (`uuidgen`), then use
`printf '%s' "$PASSWORD" | nanosync enroll --client-dir "$HOME/second-client" \
--url http://127.0.0.1:7337 --device-id UUID`. The request creates a private
`enrollment.json` containing the pending session and stable fingerprint,
written **before** the enrollment request. A lost response is retried using
the same credential and fingerprint, not a new login. On the first device use
`nanosync devices`, `nanosync approve UUID` (or `nanosync revoke UUID`). Run
the same enroll command again **without stdin** after approval, with
`--recovery-file` pointing at an owned 0600 file containing the recovery key,
or answer its `/dev/tty` prompt. Delete the temporary recovery file securely.
The completed second client stores its token and vault key in `client.json`,
mode 0600. Restrict backups of this file accordingly. Expired enrollment
sessions require operator intervention; do not delete pending state casually.

Administrator maintenance reports use the authenticated server API and the
approved administrator's `--client-dir`: `nanosync admin storage`,
`nanosync admin retention-dry-run`, `nanosync admin gc-dry-run`,
`nanosync admin scan`, and `nanosync admin diagnostics` (all accept `--json`).
Reports contain aggregate counts only, never credentials, object IDs or file
names. Each `admin scan` checks at most 100 catalog objects; repeat until
`done: true` to finish a pass (the cursor is kept in server memory and resets
on restart). The retention report refuses more than 10,000 revisions rather
than returning an incomplete result. GC dry runs do not mark or delete anything;
there is no live GC execution command or HTTP endpoint.

The server binds 127.0.0.1:7337 by default. Keep `server run` running under a
service manager with persistent private storage. Non-loopback requires
`--host HOST --acknowledge-exposure` and **an external TLS/VPN boundary**;
the server has no built-in transport encryption. Clients reject non-loopback
HTTP URLs in enrollment/bootstrap; terminate HTTPS at a trusted proxy for all
routes (including uploads/downloads) or use a VPN, and use that HTTPS URL on
remote devices. Never publish the bare HTTP port to an untrusted network. The integrity
scanner starts on server startup and stops (cancelling active scans) on SIGINT
or SIGTERM. A missing/corrupt object or scan failure is reported to stderr;
offline GC is never run by the server.

`restore REVISION [PATH]` restores a historical tree, or one historical regular
file when `PATH` is given, as a new head; it does not rewind history. The tree
restore removes current additions from the live tree, restores historical
deletions with fresh identities, and retains past revisions as immutable history.
`evict PATH` requires an accepted unchanged
revision and remote ciphertext presence before recording durable intent and
removing verified local content. `download PATH` stages and verifies the
authenticated complete file before installing it without creating a revision.
Remote-only and downloaded file counts are shown in status. Both operations
require a running daemon; interrupted operations are recovered on restart.
Sync/pause/resume/history/restore/conflicts/doctor
go through authenticated local IPC, and devices/approve/revoke through the
server's administrator API. An interrupted restore is recovered from its
durable frozen proposal and authenticated manifest before normal scanning.
Synchronize all devices after a restore and confirm the expected files before
making further edits. Current local edits are synchronized before restore.

`conflicts` lists live conflict-copy records (the `entry_id` is the copy identity).
Inspect both files and use `resolve 'EXACT/CONFLICT COPY PATH' --confirm-discard`
only when you choose to keep the other file: this synchronizes pending local
edits, then publishes a new head tombstoning that named file copy. Both devices
remove the copy on sync; the prior accepted revision and encrypted file content
remain accessible through immutable history. A missing flag, ordinary file,
already resolved copy, or directory conflict is refused. Resolution does not
combine file contents or resolve location/name-only conflicts; edit the chosen
survivor before resolving if you need to combine content. If the remote head
changes during resolution, retry after syncing. The daemon must be running.
