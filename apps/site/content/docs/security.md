# Security

nanosync encrypts file contents and manifests before upload, but encryption is not a substitute for secure endpoints, transport, backups, or careful administration. The cryptographic design, including deterministic vault-scoped chunk encryption, requires independent review before production use. Do not treat this release as an independently audited storage system.

## What the server can see and do

Ordinary persisted server data contains encrypted objects and wrapped vault keys, not plaintext file contents or recovery secrets. Encrypted manifests hide filenames and paths from ordinary server inspection. The server still sees account/device records, revision relationships and timing, object types and sizes, reference membership, reuse within a vault, and network access information.

The server controls availability and ordering. It can deny access, omit revisions, or replay older data. Clients detect integrity failures and some rollback using retained local state; complete anti-rollback protection against a malicious server is not promised. Replacing a client's private state with an older backup also weakens that protection.

Server-local vault creation is an explicit exception to client-only plaintext handling: newly generated vault keys and recovery material exist transiently on the operator machine. An explicitly requested protected recovery-output file is a secret delivery artifact. Do not treat it as ordinary encrypted server state.

## Password, device credential, and recovery secret

These are different authorities:

- The **owner password** authenticates enrollment and browser owner administration. It does not derive the vault encryption key or recover lost encrypted data.
- A **device credential** authorizes that approved installation's server requests. Protect client state as a secret, even when command output hides credentials.
- A **vault recovery secret** unlocks that vault's wrapped key. Store it offline, separately from the server and sync folders. It is shown/delivered at creation and is not retrievable later.

A new client needs the owner password for enrollment, owner approval of its exact request, and the vault recovery secret if it lacks that vault key. Compare verification codes over a trusted channel. Codes and device names are not authenticators.

If every usable client key and the recovery secret are lost, an administrator cannot reset encryption to recover the files. Conversely, a recovery secret alone cannot recreate missing or deleted ciphertext. Back up data and secrets independently.

## Keep secrets out of ordinary output

Prefer hidden prompts. For automation, use owned regular 0600 `--password-file` or `--recovery-file` inputs without symlinks/hard links; keep private parents mode 0700. `NANOSYNC_PASSWORD` and `NANOSYNC_RECOVERY_SECRET` are also supported, but environment variables can leak through process tooling or inherited environments. Never put literal passwords or recovery secrets in command-line arguments, shared shell history, logs, or bug reports.

Keep server state, client state, and recovery-output files outside sync roots. Client state includes credentials, cached vault keys, and plaintext cache data. Ordinary synchronized files are plaintext on disk. Use operating-system access controls and disk encryption; nanosync does not protect an unlocked or compromised client. Memory clearing is not guaranteed erasure from swap, crash dumps, or a JavaScript runtime.

## Protect the network and browser origin

The server speaks HTTP. Loopback HTTP is suitable for same-machine testing; use an HTTPS reverse proxy for remote enrollment, synchronization, and administration. An exposure acknowledgement is not encryption. Browser administration requires HTTPS for nonloopback use even on a VPN.

Configure the exact external HTTPS origin and exact observed trusted-proxy peer IP as described in [Server](server.md). Forwarding headers do not establish trust. Restrict access to the backend and constrain the proxy's public hostname routing. Do not log Authorization, cookies, passwords, or request bodies.

Browser administration is opt-in. Its password sessions are separate from client credentials; logout, expiry, and server restart invalidate sessions. The application enforces same-origin/CSRF checks, but those controls cannot make malicious server-delivered JavaScript trustworthy. A compromised server origin can steal browser-entered passwords, recovery secrets, and keys despite TLS. Use a trusted native CLI build when stronger separation from served browser code matters.

## Revocation and destruction have limits

Revoking a device blocks future server access. It does not wipe plaintext, erase downloaded ciphertext or keys, rotate the vault key, or prevent offline decryption of retained data. Local disconnect/removal is not remote revocation. If a device is lost, revoke access and assess the data it already held; do not assume it has become unreadable.

Deleting a vault destroys its server-side history, objects, and recovery wraps, regardless of offline clients' unsynced work. It preserves client plaintext and does not erase backups. A successful tombstone may precede physical cleanup. Recovery secrets do not undo deletion. Keep separate verified backups and control their retention and access.

A restored server backup can resurrect credentials revoked since that snapshot. Restore privately, verify consistency, review device access, and re-revoke before network exposure. See [Administration](administration.md).
