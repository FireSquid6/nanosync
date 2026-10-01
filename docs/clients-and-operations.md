# Clients and Operations

## Shared client engine

Linux and future Android clients can share a synchronization core where practical. Platform integrators implement storage, event observation, background execution, secure credentials, and user interaction. The shipped CLI handles server, enrollment, and administration, not local synchronization.

The shared libraries provide primitives and interfaces for (with scheduling and lifecycle orchestration supplied by the integrator):

- Local metadata schema and migrations.
- Object encoding, chunking, and cryptography.
- Durable transfer state and bounded retries.
- Revision creation and publication.
- Three-way merge and conflict rules.
- History inspection and restore logic.

### Bun local journal contract (initial adapter)

`packages/client-local` implements the portable `sync-core` `ChunkJournal` with Bun SQLite and private chunk files. Construct `new ClientLocal(privateDirectory, vaultId, deviceId, maxCacheBytes)` once per owner process. The directory must already be owner-only if it exists; database, WAL/SHM and cache files must be owner-only regular files without symlinks or hardlinks. The adapter creates its own subdirectory and files and refuses conflicting identities, schema changes, malformed migration ledgers, and failed SQLite integrity checks. No vault master, recovery secret, password, or bearer credential belongs in this database or in operation detail; the adapter currently accepts only empty operation detail.

Scanner/merge/integrator callers use `upsertEntry`/`entry`/`entries`, `recordHead`/`head`, `enqueueOperation`/`enqueueTransfer`/`addConflict`, `listWork`/`transition`, and `suppress`/`consumeSuppression`. Stable entry IDs survive path changes; evicted files retain metadata. `beginHydration` durably records same-revision eviction/download intent before changing the filesystem; `finishHydration` atomically updates hydration, identity, suppression and operation state. Interrupted hydration must be replayed before scanning. Operations and transfers retain running state across restart; the integrating runner decides which running operations to retry and must scan ambiguous filesystem changes. Head sequences never decrease, and equal sequences must name the same revision; accepted/applied ordering is enforced. Rollback protection assumes the private local state itself has not been replaced by an older backup; hardware-backed monotonic counters are not yet provided.

For publication, call `freezeProposal(request, encryptedManifestFrame)` **before** the first advance request. It saves the exact validated wire request (expected head, immutable envelope, idempotency key) and encrypted manifest frame in one FULL-synchronous transaction. On restart, `proposal()` retrieves those exact bytes and request; upload the manifest if needed and replay `HttpRemote.advance(proposal.request)` rather than calling `publish()` again. Keep the proposal for ambiguous responses and stale/missing-object resolution; `acceptProposal(sequence)` durably advances the accepted head and records the outcome together, and only an accepted proposal can be `clearProposal()`-ed. A new proposal cannot replace an unresolved one. This adapter does not yet integrate the publish workflow, perform merge/rebase, or persist every upload frame.

`put` accepts one caller-validated plaintext chunk of exactly the reference length and writes it to a staged 0600 file, fsyncs, renames, fsyncs the directory, then indexes it transactionally; `get` returns only complete indexed private files. Reopen removes abandoned staging files, orphan/partial files and missing indexes; budget eviction is least-recently-inserted order. The adapter cannot authenticate a plaintext chunk ID without the vault key: callers **must** verify checksum, decrypt, and validate the keyed chunk ID before `put`, and `HttpRemote.downloadChunks` re-encrypts and compares references on `get`. Cache is opportunistic, never an authoritative copy of a user file. Android storage requires a distinct adapter, not Bun imports in `sync-core`.

## Linux client

### Local directory

An integrator-provided Linux runner can manage an ordinary directory using the Linux adapter. Downloaded files are ordinary plaintext files usable by any application. Nanosync does not interpose a virtual filesystem.

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

An evicted file is absent from the sync directory. Its identity and remote file object reference remain available through the local metadata adapter for an integrator-provided UI; the shipped CLI does not list or download it.

Because absence can mean either eviction or deletion, caller-initiated eviction must write durable intent before removing the local file.

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

## CLI and user-managed client orchestration

The shipped CLI runs and initializes the server (`server init`, `server run`), bootstraps or enrolls a client (`bootstrap`, `enroll`), manages devices (`devices`, `approve`, `revoke`), and requests administrator maintenance reports (`admin storage`, `admin retention-dry-run`, `admin gc-dry-run`, `admin scan`, `admin diagnostics`). It does not ship a sync daemon, local IPC endpoint, or local sync/status/history/restore/conflict/eviction commands. Commands return JSON; successful commands exit 0, pending enrollment exits 3, and other command errors report `{error,state:"unknown",exitCode:2}` on stderr. API authorization errors can also return 3 (see the client API error handling).

Users who need ongoing synchronization must integrate and supervise their own runner around `sync-core`, `client-local`, and `linux-client`. The runner must serialize ownership of its data root and journal, handle watcher/scanner scheduling, credentials and restart recovery, replay unresolved publication and hydration intents, and surface errors rather than claim convergence based only on stored head sequences. The portable library APIs remain available for history, merge, restoration, conflicts and hydration; the CLI does not orchestrate them.

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

The v1 implementation stages steps 2–5: an explicitly bootstrap-authorized initialize request records the account verifier, opaque recovery wrap, singleton vault, and designated first-device identity; bootstrap-authorized encrypted objects are then streamed through the ordinary validated object path; completion atomically publishes the zero-parent genesis and seals bootstrap. Status is public but reveals only `uninitialized`, `initializedWithoutHead`, or `sealed`. A crash before completion leaves no head and permits repair/retry. Sealing is irreversible through the network API. First-device credential issuance, password login, approval, enrollment, and revocation are provided by the normal authentication API, not by bootstrap mutations.

The private client checkpoint contains the vault master key and exact encrypted genesis but no password or password-derived verifier; the recovery secret is displayed and confirmed once, not stored in the checkpoint. On retry, bootstrap completion uses the operator proof and saved genesis, then normal password login verifies the supplied password. A wrong password may seal an in-progress bootstrap before login rejects it; the checkpoint remains intact for retry with the correct password. Protect this owner-only file and its backups as a vault key until durable client credentials replace it.

After sealing, the designated first device obtains a password session and submits enrollment with a separate `X-Nanosync-Bootstrap-Authorization` operator proof. Operators should provision this proof through the same protected local/secret mechanism used by the injected bootstrap authorizer and make it one-time where practical. The server strips the password-session `Authorization` header before invoking that authorizer. This handoff activates only the exact persisted initial identity and does not re-enable initialize, bootstrap object upload, or completion. If the activation response is lost, the same enrolled session can safely retry without consuming another proof.

Migration 2 treats an empty migration-1 database as uninitialized and ready for bootstrap. A legacy migration-1 database that already contains `server_state` but lacks the migration-2 account/device/recovery/bootstrap identity set fails bootstrap status and initialization closed; it requires an offline operator migration or reset rather than guessing identities through the network API.

Administrative capabilities include:

- Review and approve device requests.
- Revoke device access.
- View storage and integrity status.
- Run retention and garbage-collection dry runs.
- Trigger integrity scans.
- Export diagnostics that exclude secrets and plaintext names.

Administration is CLI-only in version 1, backed by the same authenticated server API used for administration rather than a privileged side channel.

With an approved administrator's client directory, run `nanosync admin storage`, `nanosync admin retention-dry-run`, `nanosync admin gc-dry-run`, `nanosync admin scan`, or `nanosync admin diagnostics` (optionally `--json`). Reports are aggregate-only: no keys, tokens, object IDs, or plaintext names. Each `admin scan` verifies at most 100 catalog entries; repeat until `done: true` (scan position resets on server restart). Retention reports reject more than 10,000 revisions rather than silently truncating. No live GC execution command exists.

## Backup and restore

### Maintenance and offline GC (migration 4)

`MaintenanceRepository.retentionDryRun(nowMs)` chooses by **server UTC acceptance time**: all accepted revisions at age ≤3 days, newest per UTC day through 30 days, newest per UTC month through 365 days. It also reports protected head, prepared revisions and their ancestor bases. This is **reporting only**: no client acknowledgement of merge bases exists, so even unselected revisions and their referenced ciphertext remain durable. Do not infer deletion authorization from the retention report. Active upload sessions protect their objects (including expired sessions until explicitly resolved). `ServerMaintenance.scan` streams complete object frames and compares frame identity, SHA-256 and catalog length; missing/corrupt catalog rows are flagged, not removed. Unexpected I/O errors abort the scan. A scan is advisable before planning GC.

The production server entrypoint starts `PeriodicIntegrityScanner` with `ServerMaintenance` and awaits its stop on shutdown. It uses a positive interval and a batch size of at most 1,000 (one bounded catalog page per tick), reporting scan failures to stderr. Only one batch runs at once, errors do not crash the scheduler, and shutdown aborts an in-flight scan. A concurrent reupload that resets integrity state prevents an older scan result from overwriting it when the previous status/check time differs; the catalog has no generation counter for indistinguishable same-state writes.

`ServerMaintenance.gcDryRun` reports already marked candidates and their grace eligibility without changing state. The only executable GC is `collectOffline(control, nowMs)`, not an HTTP route, scheduler or live admin command. Stop every API instance and writer first; take operator-exclusive control of **both** the database and object-store paths (including other hosts and backup/restore jobs), hold that control through the entire run, and implement `assertExclusiveOffline` to fail if exclusivity is lost. SQLite transaction locks alone do not serialize physical deletion against uploads. No shipped server-wide lease exists: **never run this against a live server**. A first offline pass transactionally marks verified unreferenced catalog objects older than 24 hours; a later pass after an additional full 24-hour marking grace rechecks catalog identity, integrity, revision references (including prepared), head and active uploads before physical deletion. A failed deletion leaves a durable candidate for re-evaluation. Uncataloged files and uncertain/corrupt objects are deliberately not collected; investigate manually. GC is useful for cataloged abandoned uploads only, not retention-based historical reclamation. Review dry-run results and secure a verified backup before any offline collection.

### Backup and restore checklist

1. Prefer stopping all server instances and mutation jobs, then snapshot the closed SQLite database and entire immutable object store at the same point. Alternatively for online metadata use SQLite's **online backup API** (not a raw copy of a WAL database file); first establish a consistent immutable-object-store snapshot spanning every object referenced by the database snapshot, and block GC until both copies finish. A WAL checkpoint by itself is not an atomic backup, and a later object-store copy after concurrent GC is unsafe. Keep a manifest of SHA-256 checksums for the database snapshot and each ciphertext object, and verify the copy before rotating older backups. Never export client vault plaintext keys to the server backup.
2. Restore **into a private staging directory** with no server process attached, not over a running database. Require owned non-symlink directory mode 0700, database and WAL/SHM and object files mode 0600, no hard links; reject unexpected paths, owners, modes or missing manifest entries. Verify backup-manifest hashes before opening anything. Do not silently fix corrupted data.
3. Open the staged database with `ServerMetadataDatabase` to validate migration checksums, foreign keys and SQLite integrity; confirm head revision and sequence and verify every catalog object referenced by all persisted accepted **and prepared** revisions using `ServerMaintenance.scan` (a full scan also catches abandoned uploads). Any missing or corrupt object blocks promotion. Verify account/device registry and recovery-wrap availability, and inspect candidate GC state; missing candidates are not evidence of a good restore.
4. Only after verification atomically switch the stopped service to staged storage. Review and re-revoke credentials revoked since the backup, and reconcile clients that saw a newer head **before** network exposure. Preserve the previous copy until an operator confirms recovery. Never restore plaintext vault keys to the server.

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
