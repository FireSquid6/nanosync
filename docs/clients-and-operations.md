# Clients and Operations

## Shared client engine

Linux and future Android clients can share a synchronization core where practical. The shipped CLI orchestrates foreground Linux synchronization in addition to server, enrollment, and administration. Integrators of other clients provide their own storage, event observation, background execution, secure credentials, and user interaction.

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

An evicted file is absent from the sync directory. Its identity and remote file object reference remain available through the local metadata adapter for an integrator-provided UI; the shipped CLI does not expose eviction or download commands.

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

## CLI and foreground sync

The CLI initializes an owner password locally (`server init`), enrolls server-wide devices (`client connections add` and local `server devices approve --device-id UUID --server-dir DIR`), provisions vaults (`server vaults view|create|rename|delete`), connects directories (`client vaults connect`), and synchronizes (`client sync` or `client sync --watch`). See [CLI workflow](../packages/cli/README.md) for the commands and safe automation options. `sync` searches upward from cwd or `--path` for a secret-free `.nanosync` marker; `--watch` runs in the foreground and periodically rescans/retries. Supply your own user service manager if needed.

Each connection has its own global-state journal, cache, pending proposals, and lock. Keep sync roots separate from global private state and each other. Initial sync reconciles existing local files against the verified empty genesis even when another replica has already published remote data; it never treats untracked local files as implicit deletions. On each run, interrupted hydration/apply and frozen proposals resume before new edits. The CLI has no local IPC, status, history, restore, conflict-resolution, eviction, or download controls. By default the CLI presents readable, labeled output, prompts, warnings, and command errors on stdout, with colors and phase spinners on capable terminals. Redirecting output disables terminal styling, not human formatting. Command groups without a subcommand print their help and exit 0. Use `--json` explicitly in scripts: successful commands print `{ok:true,code,data}` and exit 0; pending enrollment exits 3, denied/expired enrollment exits 4, remote errors exit 5, local/input errors exit 2, and interruption exits 130. With `--json`, errors are structured on stderr and progress/instructions also remain on stderr. `--json` does not disable prompts; add `--non-interactive` for unattended execution. See the CLI README for the stable contract.

Integrators of other clients can use `sync-core`, `client-local`, and `linux-client` directly. The portable library APIs remain available for history, merge, restoration, conflicts and hydration; these are not separate CLI commands.

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

This release intentionally breaks old command names and stored client/server setup state.
There is no supported migration or legacy bootstrap CLI. Back up old metadata,
objects, recovery material and plaintext before resetting; do not delete your only
copy. Initialize a new private server directory and client state directory, provision
new vaults, and deliberately reconnect/import retained files. Do not reuse an old
`.nanosync` marker with new credentials. Disconnect with the matching old tool/state
first, or archive the old root and import a separate plaintext copy.

1. `nanosync server init --server-dir DIR` establishes the owner password.
2. Provision locally while the runtime is stopped:
   `nanosync server vaults create --server-dir DIR --name documents`.
   Save and acknowledge the newly delivered recovery secret.
3. `nanosync server run --server-dir DIR --web-ui` serves sync and optional owner UI.
4. `nanosync client connections add --url URL --alias home` enrolls a device.
   Compare the printed request code and approve its exact UUID in `/admin` or with
   `nanosync server devices approve --server-dir DIR --device-id UUID`.
5. `nanosync client vaults connect --server home --vault documents --path DIRECTORY`
   binds without transfer; `nanosync client sync --path DIRECTORY` starts transfer.

Local owner operations require possession of the private server directory; browser
operations require the owner password. Use the browser for live provisioning. Stop
the runtime before local storage provisioning or offline maintenance. Initialization,
local creation/replay (including recovery delivery), and `server run` enforce this
with the same process-identity `.sync-owner` gate in the private server root.
The runtime holds ownership through completed shutdown; another runtime or local
provisioning attempt fails before mutation. Stop the runtime and retry the same
name/output path: contention preserves encrypted receipts and recovery output.
Failures release ownership; definitively dead owners are recovered automatically,
not by manually deleting a live lock. Device view/approve/deny/revoke and vault
view/rename/delete are metadata-only and remain usable while serving.
Multiple approved devices and multiple
nonoverlapping directory replicas are supported; each replica has its own lock/journal.

Remove/disconnect changes local configuration and preserves files; revoke removes
future server access without erasing retained files or keys; delete destroys the
server vault, not client plaintext. Explicit deletion overrides retention only for
that UUID, immediately rejects access with HTTP 410 `VAULT_DELETED`, and schedules
restart-safe cleanup. Successful deletion means tombstoned, not necessarily reclaimed.
Backups may still hold deleted data and revoked credentials; control their retention
separately. Recovery secrets alone cannot restore deleted ciphertext.

Administrative capabilities include:

- Review and approve device requests.
- Revoke device access.
- View storage and integrity status.
- Run retention and garbage-collection dry runs.
- Trigger integrity scans.
- Export diagnostics that exclude secrets and plaintext names.

Local access to the server's private metadata directory authorizes exact-UUID owner approval, denial, revocation and vault administration without a sync client. Browser owner administration is separately opt-in; existing device-admin HTTP routes retain their distinct authority and safeguards.

On the server, run `nanosync server admin storage`, `nanosync server admin retention-dry-run`, `nanosync server admin gc-dry-run`, `nanosync server admin scan`, or `nanosync server admin diagnostics`, supplying `--server-dir DIR` (or selecting it interactively), optionally `--json`. Stop the serving runtime before these offline reports: their storage initialization/recovery shares the exclusive runtime/provisioning ownership gate, and scan reads ciphertext. Device view/approve/deny/revoke and vault view/rename/delete are metadata-only and remain available while serving, including during staged uploads. Reports are aggregate-only: no keys, tokens, object IDs, or plaintext names. Each `admin scan` verifies at most 100 catalog entries; repeat until `done: true` (scan position resets on server restart). Retention reports reject more than 10,000 revisions rather than silently truncating. No live GC execution command exists.

## Backup and restore

### Maintenance and offline GC (migration 4)

`MaintenanceRepository.retentionDryRun(nowMs)` chooses **per vault** by server UTC acceptance time: all accepted revisions at age ≤3 days, newest per UTC day through 30 days, newest per UTC month through 365 days. It also reports protected heads, prepared revisions and their ancestor bases. This is **reporting only**: no client acknowledgement of merge bases exists, so even unselected revisions and their referenced ciphertext remain durable. Do not infer deletion authorization from the retention report. Active upload sessions protect their objects (including expired sessions until explicitly resolved). `ServerMaintenance.scan` pages the entire catalog by vault and object ID and compares complete frames, SHA-256 and catalog length; missing/corrupt rows are flagged, not removed. Unexpected I/O errors abort the scan.

The production server entrypoint starts `PeriodicIntegrityScanner` with `ServerMaintenance` and awaits its stop on shutdown. It uses a positive interval and a batch size of at most 1,000 (one bounded catalog page per tick), reporting scan failures to stdout in human mode or stderr with `--json`. Only one batch runs at once, errors do not crash the scheduler, and shutdown aborts an in-flight scan. A concurrent reupload that resets integrity state prevents an older scan result from overwriting it when the previous status/check time differs; the catalog has no generation counter for indistinguishable same-state writes.

`ServerMaintenance.gcDryRun` reports already marked candidates and their grace eligibility without changing state. The only executable GC is `collectOffline(control, nowMs)`, not an HTTP route, scheduler or live admin command. Stop every API instance and writer first; take operator-exclusive control of **both** the database and object-store paths (including other hosts and backup/restore jobs), hold that control through the entire run, and implement `assertExclusiveOffline` to fail if exclusivity is lost. SQLite transaction locks alone do not serialize physical deletion against uploads. The shipped CLI runtime/provisioning ownership gate does not wrap this programmatic GC API or coordinate other hosts/external writers: **never run this against a live server**. A first offline pass transactionally marks verified unreferenced catalog objects older than 24 hours; a later pass after an additional full 24-hour marking grace rechecks catalog identity, integrity, revision references (including prepared), head and active uploads before physical deletion. A failed deletion leaves a durable candidate for re-evaluation. Uncataloged files and uncertain/corrupt objects are deliberately not collected; investigate manually. GC is useful for cataloged abandoned uploads only, not retention-based historical reclamation. Review dry-run results and secure a verified backup before any offline collection.

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

### Browser API runtime options

Browser administration is disabled by default. Enable with
`nanosync server run --server-dir <dir> --web-ui`. For an existing HTTPS proxy,
add `--external-origin https://sync.example --trusted-proxy <exact-peer-IP>`.
The insecure-sync exposure acknowledgement never permits public browser HTTP.
No forwarded headers establish trust. See [security.md](security.md) before
exposing the backend listener. The runtime embeds the React/Paper UI HTML and content-hashed JS/CSS in the
source asset map and standalone executable. No adjacent assets, CDN, or frontend
service is needed. Unknown assets have no fallback. HTML/API are no-store; exact
hashed assets are immutable. The programmatic `adminAssets` map is an explicit
override for integrators/tests.
Client provisioning mutations and legacy CLI aliases have been removed. Use `server vaults create|rename|delete` locally, or the owner browser API, for provisioning. The CLI no longer exposes a bootstrap workflow; historical protocol fixtures remain test-only.


### Reverse proxy example

For a TLS terminator on the same machine:

```sh
nanosync server run --server-dir /srv/nanosync --host 127.0.0.1 --port 8787 \
  --web-ui --external-origin https://sync.example.com --trusted-proxy 127.0.0.1
```

Configure the proxy's HTTPS virtual host for **only** `sync.example.com`, forward
all paths to `http://127.0.0.1:8787`, preserve the browser Origin/custom CSRF header,
and disable shared caching for `/admin` HTML/API. Serve assets on that same origin.
Forwarded/X-Forwarded-* headers are neither needed nor trusted. Restrict backend
access to the proxy; a shared trusted source IP is not an identity boundary.
For a remote proxy use its exact observed socket IP, firewall the backend, and add
`--acknowledge-exposure` when binding nonloopback. Proxy body/time limits must allow
streamed sync uploads; do not log Authorization, cookies, passwords or request bodies.
A VPN or insecure-sync acknowledgement alone does not permit nonloopback browser HTTP.

### Secret delivery and automation

Use hidden prompts, `NANOSYNC_PASSWORD`/`NANOSYNC_RECOVERY_SECRET`, or protected
`--password-file`/`--recovery-file` inputs, never literal secret arguments. For
scripted creation use `--recovery-output /private/new-secret` in a private 0700
parent; the new output is owner-only 0600. Retry the same name and absolute output
path after interruption to replay the encrypted receipt. Do not change/delete the
output before retry. Deliver it securely/offline to the client and remove the
operator copy after durable independent backup. This explicit delivery file is
not ordinary server key persistence. Browser creation acknowledges backup, stores
only an encrypted receipt, and requires secret reentry after refresh before publish.
There is no recovery-secret retrieval API. See the [CLI contract](../packages/cli/README.md)
for complete JSON/exit and confirmation rules.
