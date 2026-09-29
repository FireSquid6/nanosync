# Clients and Operations

## Shared client engine

The Linux, Android, and CLI experiences should share a synchronization core where practical. Platform adapters implement storage, event observation, background execution, secure credentials, and user interaction.

The shared engine owns:

- Local metadata schema and migrations.
- Object encoding, chunking, and cryptography.
- Transfer queues and retries.
- Revision creation and publication.
- Three-way merge and conflict rules.
- History inspection and restore logic.

## Linux client

### Local directory

The Linux client manages an ordinary directory. Downloaded files are ordinary plaintext files usable by any application. Nanosync does not interpose a virtual filesystem.

### Change observation

Use both:

- A filesystem watcher for low-latency change detection.
- Periodic full or incremental scans for recovery from missed events.

The client must safely handle:

- Editors that write temporary files and rename them over the original.
- Files changing while they are being read.
- Rapid sequences of writes.
- Directory moves.
- Watch limits and dropped events.
- Client-generated changes that should not be uploaded again.

### Remote-only entries

An evicted file is absent from the sync directory. It appears only in the desktop UI and CLI until the user requests download. The local metadata database retains its stable identity and remote file object reference.

Because absence can mean either eviction or deletion, app-initiated eviction must write durable intent before removing the local file.

### Unsupported filesystem cases

Version 1 is optimized for Linux. The implementation still needs explicit rules for:

- Symbolic links.
- Unix modes and executable bits.
- Hard links.
- Sockets, devices, and named pipes.
- Extended attributes and access-control lists.
- Case-only renames.
- Invalid or oversized names.

Version 1 synchronizes only regular files, directories, and the owner-executable bit. It rejects symlinks, hard-linked files, sockets, devices, FIFOs, and unsafe/invalid names visibly rather than following or skipping them. Extended attributes, ACLs, sparse-file fidelity, and other mode bits are not preserved.

## Android client

### Offline model

Android maintains a complete local vault. Synchronization succeeds only when every current file is stored and verified locally.

Before downloading a revision, the client estimates required additional storage. If space is insufficient:

- Stop before destructive local application.
- Preserve the last complete local revision.
- Display required and available capacity.
- Keep retry available after the user frees storage.

### Background limitations

Background synchronization is best-effort and must be supplemented by:

- Explicit foreground sync.
- Clear last-sync and pending-change status.
- Retry after connectivity or power restrictions lift.
- Durable queues that survive process termination.

### External file access

Opening or editing through another application may require temporary copies or platform-mediated document access. The Android client must detect the resulting edited content and clearly communicate when an external copy is no longer managed by Nanosync.

## CLI and daemon

One daemon process owns the synchronization directory, local metadata database, and operation journal. CLI commands communicate with it through a local authenticated IPC endpoint.

Suggested command surface:

```text
nanosync daemon
nanosync status [--json]
nanosync sync
nanosync pause
nanosync resume
nanosync history [PATH]
nanosync restore REVISION [PATH]
nanosync conflicts
nanosync evict PATH
nanosync download PATH
nanosync devices
nanosync doctor
```

Commands intended for scripts should provide stable structured output and meaningful exit codes. `status` should distinguish:

- Fully synchronized.
- Local changes pending.
- Uploading or downloading.
- Paused.
- Offline.
- Blocked by conflict.
- Authentication or approval required.
- Incomplete due to storage capacity.
- Integrity failure.

## Server process

The server is a single native process responsible for the API, metadata database, background maintenance, and object storage.

Suggested top-level configuration:

```text
listen_address
listen_port
public_base_url
metadata_database_path
object_storage_path
trusted_proxy_addresses
maximum_object_size
retention_policy
garbage_collection_grace_period
integrity_scan_schedule
log_level
```

The server should create storage with restrictive permissions and refuse to start when critical paths are unsafe or inconsistent.

## Administration

Version 1 needs an explicit bootstrap flow:

1. Start an uninitialized server on a trusted local interface.
2. Create the sole account.
3. Initialize the encrypted vault from the first client.
4. Generate and confirm storage of the recovery key.
5. Mark the first device approved.
6. Disable bootstrap endpoints permanently unless the server is reset through an offline administrative procedure.

The v1 implementation stages steps 2–5: an explicitly bootstrap-authorized initialize request records the account verifier, opaque recovery wrap, singleton vault, and designated first-device identity; bootstrap-authorized encrypted objects are then streamed through the ordinary validated object path; completion atomically publishes the zero-parent genesis and seals bootstrap. Status is public but reveals only `uninitialized`, `initializedWithoutHead`, or `sealed`. A crash before completion leaves no head and permits repair/retry. Sealing is irreversible through the network API. First-device credential issuance, password login, approval, enrollment, and revocation are Step 6 work and are intentionally not provided by bootstrap.

Migration 2 treats an empty migration-1 database as uninitialized and ready for bootstrap. A legacy migration-1 database that already contains `server_state` but lacks the migration-2 account/device/recovery/bootstrap identity set fails bootstrap status and initialization closed; it requires an offline operator migration or reset rather than guessing identities through the network API.

Administrative capabilities include:

- Review and approve device requests.
- Revoke device access.
- View storage and integrity status.
- Run retention and garbage-collection dry runs.
- Trigger integrity scans.
- Export diagnostics that exclude secrets and plaintext names.

Administration is CLI-only in version 1, backed by the same authenticated server API used for administration rather than a privileged side channel.

## Backup and restore

The operator must back up both metadata and immutable objects.

A supported backup procedure should provide one of:

- A server quiesce command that flushes metadata and pauses mutations.
- A metadata snapshot operation paired with a documented object-store consistency point.

Restore verification must check:

- Database readability and schema version.
- Presence of the current head revision.
- Presence and checksums of all objects reachable from retained revisions.
- Account and device registry consistency.

A restored server may contain device credentials that were revoked after the backup. Restore documentation must therefore require reviewing and re-revoking devices before network exposure.

## Observability

Logs and metrics must not include plaintext filenames, file contents, passwords, recovery keys, vault keys, or device secrets.

Useful operational signals include:

- Current head sequence.
- Object and ciphertext byte counts.
- Upload and download request results.
- Head comparison failures.
- Authentication and approval events.
- Integrity failures.
- Retention and garbage-collection results.
- Database transaction failures.

Metrics labels must avoid unbounded identifiers such as chunk IDs, revision IDs, or paths.

## Updates and compatibility

- Database migrations must be transactional or safely resumable.
- Stored object formats remain versioned independently from application releases.
- Server and clients negotiate supported protocol capabilities.
- A server must reject publication in an unsupported format before accepting it as head.
- Upgrades should preserve the ability to read retained historical revisions.

## Operational safety defaults

- Bind the server to loopback unless configured otherwise.
- Disable destructive maintenance by default until a dry run succeeds.
- Retain uncertain objects during garbage collection.
- Rate-limit authentication and expensive presence queries.
- Enforce configured limits before accepting large request bodies.
- Use temporary files and atomic publication for local object writes.
