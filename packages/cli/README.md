# Bun CLI (Linux)

Run `bun packages/cli/src/main.ts --help` or link the `@nanosync/cli` bin as `nanosync`.
The CLI uses a single daemon per private client directory; local commands require
its owner-only Unix socket and the separately provisioned IPC secret. Commands
return JSON and exit 0 on success, 2 for invalid input/operational failures,
3 for authentication failures, 4 for approval, 5 for unavailable features.

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

The server binds 127.0.0.1 by default. Non-loopback requires
`--host HOST --acknowledge-exposure` and **an external TLS/VPN boundary**;
the server has no built-in transport encryption. Clients reject non-loopback
HTTP URLs in enrollment/bootstrap; configure HTTPS when remote. The integrity
scanner starts on server startup and stops (cancelling active scans) on SIGINT
or SIGTERM. A missing/corrupt object or scan failure is reported to stderr;
offline GC is never run by the server.

`restore REVISION PATH` restores a historical regular file as a new head;
it does not rewind history. `evict PATH` requires an accepted unchanged
revision and remote ciphertext presence before recording durable intent and
removing verified local content. `download PATH` stages and verifies the
authenticated complete file before installing it without creating a revision.
Remote-only and downloaded file counts are shown in status. Both operations
require a running daemon; interrupted operations are recovered on restart.
Sync/pause/resume/history/restore/conflicts/doctor
go through authenticated local IPC, and devices/approve/revoke through the
server's administrator API. An interrupted restore is recovered from its
durable frozen proposal and authenticated manifest before normal scanning.
