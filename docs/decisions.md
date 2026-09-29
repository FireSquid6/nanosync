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

## Frozen version 1 implementation decisions

These choices are part of persistent format `1` and protocol `1`. Details and limits are normative in [formats.md](formats.md), [security.md](security.md), and [threat-model.md](threat-model.md).

| Area | Version 1 decision |
|---|---|
| Runtime | Bun/TypeScript for server and Linux CLI; shared core uses portable Web Crypto and WHATWG interfaces. Android integration is later platform work. |
| Chunking | Fixed 4 MiB, recorded per file/format; only the final chunk may be smaller; all 50 GB paths stream. |
| Crypto | SHA-256 ciphertext checksums, HMAC-SHA-256 vault chunk IDs, HKDF-SHA-256 domain derivation, and AES-256-GCM as specified in `security.md`; independent review is required. |
| Authentication | Argon2id password verifier and independent random 256-bit per-device bearer credentials; no v1 credential expiry, rotation on re-enrollment. |
| Metadata DB | SQLite through `bun:sqlite`, WAL, foreign keys, 5-second busy timeout, `synchronous=FULL`, and explicit `BEGIN IMMEDIATE` writes. |
| Filesystems | Regular files/directories plus owner-executable bit only. Reject links, special files, and unsafe names visibly; no xattr, ACL, or sparse fidelity. |
| Retention/GC | UTC buckets select newest accepted revision; 24-hour grace plus recheck; current/conflicts/transfers/needed merge bases remain protected. |
| Network/admin | Loopback by default, acknowledged non-loopback exposure and external TLS; CLI-only administration uses the same server API. |

### Immutable encrypted objects

Store chunks, manifests, and revisions as immutable objects. Publish them by atomically advancing a mutable vault-head record.

### Compare-and-swap publication

Require every revision proposal to name its expected base head. A stale proposal triggers client-side merge rather than server-side last-writer-wins.

### Encrypted manifests

Encrypt names, paths, supported metadata, plaintext digests, and chunk lists. The canonical visible reference set allows the server to observe exact per-revision membership, object types/sizes, timing, graph relationships, reuse, and vault-scoped equality.

### Transactional embedded metadata database

Use a transactional embedded database for account, device, revision, upload, retention, and garbage-collection metadata. Do not store large encrypted file bodies in the database.

### Shared synchronization core

Keep protocol, cryptography, merge logic, and local metadata semantics in a reusable core with Linux and Android adapters.

## Remaining implementation decisions

### Authentication operations

Set concrete password-login and enrollment rate limits, backoff/lockout behavior, administrative account-recovery procedure, session lifetime, and audit retention. These operational values are not cryptographic format parameters and were not frozen by this slice.

### Trusted proxies and transport deployment

Define trusted-proxy address matching, accepted forwarding headers, reverse-proxy body/time limits, external TLS deployment examples, and detection/warnings for unsafe exposure.

### Database lifecycle and backups

Specify transactional migration/resume rules, supported SQLite online snapshot procedure, the object-store consistency point paired with a snapshot, restore sequencing, integrity checks, and corruption recovery/operator escalation. The WAL and transaction durability settings do not by themselves settle backup consistency.

### Save debouncing

Determine:

- Debounce interval.
- File stability interval.
- Maximum batching window.
- Treatment of constantly changing files.
- Revision grouping across several paths.

### Conflict naming

Choose a deterministic, Linux-safe convention that includes enough information to identify the source device and time without causing repeated collisions.

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
