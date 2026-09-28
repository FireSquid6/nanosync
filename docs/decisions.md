# Decisions and Open Questions

## Confirmed product decisions

| Area | Decision |
|---|---|
| Initial audience | One household or small trusted team, initially one user |
| Server tenancy | One user and one vault per server |
| Topology | Central authoritative server |
| Initial clients | Linux desktop, Android, and CLI daemon |
| Encryption | Client-side encryption; server does not have the vault master key |
| Recovery | User-held recovery key; no server-side plaintext recovery |
| Device enrollment | Password authentication, admin approval, then recovery-key entry |
| Sharing | No multi-user sharing in version 1 |
| Conflict policy | Preserve both concurrent versions |
| Delete/edit conflict | Preserve tombstone and create a conflict copy |
| Rename tracking | Stable file identity across moves and renames |
| File size | Up to 50 GB per file |
| Chunking | Fixed-size chunks |
| Transfer restart | Resume at completed chunk boundaries |
| Deduplication | Within the one-user vault |
| Server storage | Local filesystem through an abstract `Filesystem` interface |
| Linux local model | Ordinary folder; evicted entries visible only in app and CLI |
| Linux local encryption | Plaintext files; rely on device disk encryption |
| Android local model | Complete offline vault |
| Android capacity failure | Fail visibly if the vault does not fit |
| History trigger | Debounced completed filesystem changes |
| Retention | All for 3 days, daily through 30 days, monthly through one year, then current state |
| Server durability | Validate checksums; operator manages backups |
| Device revocation | Prevent future server access only |
| Transport security | External reverse proxy, VPN, or trusted network; no built-in TLS |
| CLI role | Continuous daemon plus status, history, restore, and management commands |

## Recommended architectural decisions

These recommendations follow from the confirmed requirements but should be explicitly accepted during implementation planning.

### Immutable encrypted objects

Store chunks, manifests, and revisions as immutable objects. Publish them by atomically advancing a mutable vault-head record.

### Compare-and-swap publication

Require every revision proposal to name its expected base head. A stale proposal triggers client-side merge rather than server-side last-writer-wins.

### Encrypted manifests

Encrypt names, paths, supported metadata, plaintext digests, and chunk lists. Allow the server to observe object sizes, timing, revision relationships required for coordination, and vault-scoped equality.

### Transactional embedded metadata database

Use a transactional embedded database for account, device, revision, upload, retention, and garbage-collection metadata. Do not store large encrypted file bodies in the database.

### Shared synchronization core

Keep protocol, cryptography, merge logic, and local metadata semantics in a reusable core with Linux and Android adapters.

## Unresolved implementation decisions

### Chunk size

Choose a fixed size after benchmarking:

- Small-note workloads.
- 50 GB sequential files.
- Encryption and hashing overhead.
- Request overhead and server memory.
- Interrupted-transfer behavior.

The format must record its chunking parameters so they can evolve without reinterpreting old objects.

### Cryptographic primitives

Select and review:

- Authenticated-encryption construction.
- Key-derivation function and context labels.
- Recovery-key encoding and derivation.
- Vault-scoped deterministic chunk identifier.
- Safe deterministic per-chunk encryption for deduplication.
- Manifest authenticity and revision-parent binding.

This decision requires a written threat-model review rather than only a library choice.

### Password and device credentials

Decide:

- Password hashing primitive and versioned parameters.
- Whether device authentication uses opaque bearer credentials or public-key signatures.
- Credential rotation and expiry behavior.
- Login rate limits and administrative recovery procedure.

### Server metadata database

Select the database and define:

- Transaction boundaries.
- Migration behavior.
- Backup snapshot procedure.
- Concurrency and durability settings.
- Corruption recovery behavior.

### Wire protocol

Specify:

- Endpoint shapes and error model.
- Capability negotiation.
- Idempotency semantics.
- Pagination and batch-presence limits.
- Streaming and range behavior.
- Request-size and resource limits.
- Authentication headers.

### Filesystem semantics

Define version 1 behavior for:

- Symbolic and hard links.
- Executable bits and modes.
- Extended attributes and ACLs.
- Special files.
- Case-only renames.
- Invalid or oversized names.
- Sparse files.

A safe initial choice is to support regular files, directories, and a minimal executable hint while rejecting unsupported entries visibly.

### Save debouncing

Determine:

- Debounce interval.
- File stability interval.
- Maximum batching window.
- Treatment of constantly changing files.
- Revision grouping across several paths.

### Retention boundaries

Specify:

- Timezone used for daily and monthly buckets.
- Which revision represents a bucket.
- Whether named checkpoints can override pruning.
- Grace period before deleting unreachable objects.
- Protection of merge bases and interrupted uploads.

### Conflict naming

Choose a deterministic, Linux-safe convention that includes enough information to identify the source device and time without causing repeated collisions.

### Administration surface

Decide whether account setup, device approval, revocation, and maintenance use:

- A small web console.
- CLI-only administration.
- Both, backed by the same administrative API.

### Technology stack

Choose implementation languages and UI toolkits only after establishing:

- Shared-core portability to Linux and Android.
- Cryptographic library quality.
- Reliable streaming of large files.
- Filesystem watcher support.
- Embedded database support.
- Packaging and cross-compilation requirements.

## Deferred design areas

These should not constrain version 1 unless a chosen data format would make them impossible later:

- Multiple vaults.
- Multiple users and folder sharing.
- S3-compatible object storage.
- Windows and macOS clients.
- iOS client.
- Peer-assisted transfer.
- Search over client-generated encrypted indexes.
- Key rotation and cryptographic device removal.

## Exit criteria for architecture phase

Architecture is ready for implementation planning when:

- The threat model and concrete key hierarchy are reviewed.
- The object formats and protocol are specified and versioned.
- Crash-consistency invariants are written for client and server.
- Filesystem edge-case behavior is explicit.
- Retention and garbage collection have executable acceptance tests.
- A prototype validates chunked upload, interruption recovery, stale-head merge, and 50 GB streaming without loading whole files into memory.
