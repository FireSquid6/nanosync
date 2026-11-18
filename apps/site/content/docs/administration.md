# Administration

Possession of the private server directory authorizes local owner administration. Browser administration uses a separate owner-password session and is available only when the runtime starts with `--web-ui`. An enrolled client's credential is not a browser owner session.

Examples below use the server directory from the [server guide](server.md). All server commands require `--server-dir` or an interactive selection.

## Review devices and vaults

These commands can run while the server serves requests:

```sh
nanosync server devices view --server-dir "$HOME/nanosync-server"
nanosync server vaults view --server-dir "$HOME/nanosync-server"
```

Compare a pending request's verification code with the client through a trusted channel. Approve the exact UUID, never a display name. The code is comparison material, not a secret or authorization token.

```sh
printf 'Verified pending device UUID: '
read -r DEVICE_ID
nanosync server devices approve --server-dir "$HOME/nanosync-server" --device-id "$DEVICE_ID"
```

Use `devices deny` for an unwanted pending request, or `devices revoke` for an existing device, with the same `--device-id` selector. Revocation asks for confirmation. It blocks future access but does not erase plaintext, downloaded ciphertext, or cached vault keys, and does not rotate vault encryption keys.

Vault creation is covered in [Server](server.md). Stop the runtime for local creation, or create through the live browser UI. Vault rename uses `server vaults rename --vault UUID --name NAME`; it changes the display name, not the vault identity or existing bindings.

## Disconnect, remove, revoke, or delete?

These operations have different consequences:

| Operation | Effect |
| --- | --- |
| `client vaults disconnect --path DIRECTORY` | Removes the local binding; preserves local files and remote data. |
| `client connections remove --server ALIAS_OR_ID` | Removes local server configuration; does not revoke remote access. Refuses attached bindings unless explicitly forced. |
| `server devices revoke --device-id UUID` | Blocks that device's future server requests; retained files and keys remain. |
| `server vaults delete --vault UUID` | Permanently tombstones the server vault and destroys its server-side history, objects, and wraps; client plaintext remains. |

Disconnect checks for pending work and unscanned local edits. `--force` explicitly discards pending synchronization state while preserving local files; it is not a repair tool. `--yes` does not authorize abandoning unsynced work. Neither flag bypasses live locks. Stop sync processes and back up local edits before forcing removal.

Vault deletion is not cleanup of a client binding. Before deleting, inspect offline clients, preserve independent copies, and verify a server backup. Interactive deletion requires the exact current vault name. In scripts it requires `--vault UUID --confirm-delete SAME_UUID --non-interactive`; `--yes` cannot substitute. The browser requires the exact name and owner password. There is no undelete CLI.

Deletion rejects further sync with `VAULT_DELETED`. Physical cleanup may still be pending. Clients stop rather than apply an empty tree; disconnect obsolete bindings deliberately. A recovery secret cannot restore deleted ciphertext, and backups may retain data after deletion.

## Offline reports and scans

Stop the serving runtime first. These reports initialize/recover object storage and require exclusive ownership, even when they sound read-only:

```sh
nanosync server admin storage --server-dir "$HOME/nanosync-server"
nanosync server admin retention-dry-run --server-dir "$HOME/nanosync-server"
nanosync server admin gc-dry-run --server-dir "$HOME/nanosync-server"
nanosync server admin scan --server-dir "$HOME/nanosync-server"
nanosync server admin diagnostics --server-dir "$HOME/nanosync-server"
```

Reports contain aggregates, not plaintext filenames, keys, or tokens. The offline `admin scan` command checks only the first 100 catalog entries. It does not persist or accept a cursor, so repeating it checks the same batch rather than advancing. It cannot verify a larger store completely. Investigate missing or corrupt objects instead of deleting them to clear a report.

Retention and garbage collection are dry-run reports only. There is no CLI command to execute GC or prune history. A retention report is not authorization to delete objects manually. The running server also performs bounded periodic integrity scans and reports failures on stderr.

## Backups and recovery

Sync is not backup. Maintain independent plaintext backups as well as protected server backups. For the simplest consistent server backup:

1. Stop the runtime and all other writers, provisioning, and maintenance jobs.
2. Copy the complete private server directory, including metadata, object storage, credential pepper, and encrypted creation receipts, as one consistent set. Preserve private ownership and permissions. Do not copy only the SQLite database while leaving its objects behind.
3. Verify the copied bytes with a checksum manifest, store the backup with access controls, and retain a known-good older copy. Keep recovery secrets separately offline; do not add plaintext vault keys to server state.
4. Rehearse recovery into a separate private directory with no running process. Verify backup hashes and metadata/database integrity, and require complete object verification before considering promotion. The current offline CLI cannot complete that verification for a store larger than its first 100 entries; library-level tooling and expert review are needed. Do not treat a clean CLI scan as proof of a complete or safe restore.
5. Before exposing a restored service, review device access and re-revoke credentials revoked after the backup. Clients may have accepted newer heads; preserve their state and investigate rollback rather than resetting them to suppress errors.

There is no `backup` or `restore` CLI command. The CLI cannot fully automate restore verification or reconciliation with newer clients. Never restore over a running server or blindly roll back its database. Keep the original state untouched until recovery is verified.

## Automation and secrets

Use hidden prompts or protected files, not secret command-line arguments. `server init` and `client connections add` accept `--password-file`; `client vaults connect` accepts `--recovery-file`. Inputs must be owned regular 0600 files without symlinks or hard links. For unattended creation, `--recovery-output FILE --non-interactive` writes a new 0600 delivery file in a private 0700 parent outside sync roots.

After interrupted creation, retry the same name and absolute recovery-output path. Keep encrypted receipts and the original delivered file intact until the operation is complete; changing the path starts a new creation. After completion, deliver and back up the secret securely/offline before removing the operator's delivery copy. Replaying that same receipt later requires the original protected output file.

`--json` emits one successful result document on stdout; progress and errors use stderr. Pending enrollment exits 3, denied/expired enrollment 4, remote errors 5, local/input failures 2, and interruption 130. Non-terminal execution never prompts. See the [complete CLI contract](https://github.com/FireSquid6/nanosync/blob/main/packages/cli/README.md) for result codes, retries, and noninteractive confirmation rules.
