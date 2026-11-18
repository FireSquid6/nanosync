# Requirements and Scope

## Actors

### Vault owner

The single user who owns the server account, vault, recovery key, and synchronized data.

### Approved device

An approved Linux CLI client, native Android client, or integrator-provided client authorized to authenticate, obtain encrypted vault objects, and publish revisions. The CLI provisions credentials, manages enrollment, and can synchronize a Linux directory in the foreground.

### Server operator

The person operating the server process, storage, network exposure, TLS termination, and backups. In version 1, this will normally be the vault owner.

## Functional requirements

### Synchronization

- The server is the authoritative synchronization point.
- Clients synchronize through the server rather than directly with one another.
- Clients may edit files while disconnected.
- Each stable file has an identity independent of its path.
- Moves and renames preserve file identity and history.
- Concurrent modifications preserve both versions and require later user resolution.
- A concurrent delete and modification preserves the deletion and creates a conflict copy from the modified content.
- Filesystem activity is debounced before creating an automatic revision.
- Interrupted transfers resume at completed chunk boundaries.

### Files and storage

- Individual files may be as large as 50 GB.
- Typical vault size is approximately 2 GB and primarily contains notes.
- Version 1 uses fixed-size chunks.
- Deduplication is scoped to each vault, never across vaults.
- Version 1 stores server objects on the local filesystem.
- Storage access is defined through an abstract `Filesystem` interface.

### History

Every completed, debounced save or change creates a revision. The default retention policy is:

- Every revision for the most recent 3 days.
- One daily revision for the remainder of the most recent 30 days.
- One monthly revision through one year.
- Beyond one year, only the current state is guaranteed to remain.

Retention must never remove the current head, an unresolved conflict required by current state, or objects needed by an active transfer.

### Linux

- Synchronize into an ordinary local directory.
- Store downloaded files as plaintext, relying on device-level disk encryption.
- Allow explicit eviction of downloaded files.
- Remove evicted files from the ordinary directory.
- Expose remote-only entries through local client state for an integrator-provided UI, not as transparent filesystem placeholders.

### Android

- Native Android 12+ dashboard; the real-device acceptance target is Pixel 9 on Android 17.
- Connect existing vaults from multiple independent servers; no mobile vault creation or server administration.
- Keep every current non-ignored vault file available offline in one user-selected supported shared folder per connection.
- Android manages external applications' access; Nanosync does not enforce an application allowlist.
- Keep credentials, vault keys, journals and synchronization metadata in private application storage, with Android Keystore-backed encryption for stored credentials and keys.
- Reject overlapping synchronization roots; safely reconcile populated folders and preserve conflicting versions.
- Follow device-local `.nanosyncignore` rules without editor-specific exclusions.
- Fail synchronization visibly if the vault cannot fit or the selected folder becomes inaccessible. Never interpret failed access/enumeration as deletion.
- Never report complete synchronization while required non-ignored files are missing or unverified.
- Provide explicit per-vault background enablement and pause, plus one-shot Sync now that leaves persistent preferences unchanged.
- Background execution uses Android-supported foreground work with an ongoing notification and best-effort reboot/unlock recovery. Expose restrictions and stopped execution honestly; uninterrupted execution is not guaranteed.
- Use a global mobile-data default chosen during onboarding, with clearly scoped per-vault inherit/allow/Wi-Fi-only overrides and prompted one-time manual exceptions.
- Require HTTPS by default, with an easily discoverable global Allow HTTP connections developer setting. HTTPS certificate validation remains enforced.
- A blocked connection must not prevent unrelated vaults progressing. Disconnecting leaves shared files untouched and removes unneeded private state and credentials.

### CLI

Provide CLI commands for owner-password initialization/runtime, server-wide enrollment and local approval, vault creation/list/rename, directory setup/repair, administrator reports, one-shot Linux sync and foreground `sync --watch` with periodic rescan. Legacy bootstrap remains for existing deployments. Users choose how to launch the watcher at startup. Separate background services, local IPC, and local status/history/restore/conflict/eviction commands are out of scope; portable libraries retain primitives for integrators.

## Security requirements

- File contents and manifests are encrypted by clients.
- The running synchronization server does not possess the vault master key. Offline server-local provisioning may handle keys transiently, without persisting plaintext keys, as described in the security and owner-operation contracts.
- The account password authenticates the user but is not the sole source of the vault encryption key.
- Each approved device receives a unique server credential.
- A new device requires password authentication, administrator approval, and the recovery key before it can decrypt the vault.
- The server can revoke future requests from a device.
- Revocation does not erase data or keys already copied to a lost device.
- The server validates ciphertext integrity; clients validate decrypted content.
- Nanosync does not provide built-in TLS in version 1. The operator must use a reverse proxy, VPN, or otherwise trusted network.

## Durability requirements

- Server metadata updates must be transactional.
- Immutable objects must be completely written and checksum-verified before publication.
- A revision cannot become head until all referenced objects exist.
- The server periodically verifies stored ciphertext checksums.
  The server runtime must start the bounded single-flight `PeriodicIntegrityScanner` on startup and stop it on shutdown, supply error reporting, and choose an interval/batch size; the Step 15 scheduler API alone does not start automatically. It never runs destructive GC.
- The operator is responsible for backups.
- Backup documentation must cover both the metadata database and object storage.

## Non-goals for version 1

- A separately packaged client service, its local IPC, or built-in startup integration.
- Multiple users on one server (multiple independent vaults for one owner are supported).
- Shared folders or access-control lists.
- Peer-to-peer synchronization.
- macOS, Windows, or iOS clients.
- Transparent Linux placeholders.
- Server-side search, previews, thumbnails, or indexing.
- Application-aware document merging.
- Full cross-platform filename and metadata fidelity.
- Cryptographic erasure of access after device revocation.
- Built-in certificate management.
- Built-in replicated storage or remote backup.
- An S3 storage implementation.
