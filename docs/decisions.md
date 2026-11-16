# Decisions and Open Questions

## Confirmed product decisions

| Area | Decision |
|---|---|
| Initial audience | One household or small trusted team, initially one user |
| Server tenancy | One owner/password and multiple independent vaults per server (including zero vaults) |
| Topology | Central authoritative server |
| Initial clients | Portable sync core with Linux foreground CLI adapters and native Android shared-folder dashboard/adapters |
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
| Deduplication | Within each vault, not across vaults |
| Server storage | Local filesystem through an abstract `Filesystem` interface |
| Linux local model | Ordinary folder; evicted entries available through local-state adapters to integrator-provided interfaces |
| Linux local encryption | Plaintext files; rely on device disk encryption |
| Android local model | Complete verified non-ignored offline vault in one supported user-selected shared folder; Android-managed app access |
| Android capacity failure | Fail visibly if the vault does not fit |
| Android filesystem integration | Native shared-folder adapter with explicit Android All files access; no app-private authoritative mirror or app allowlist; replaces the DocumentsProvider-only prototype |
| Android product | Native Android 12+ sync dashboard; multiple servers/vaults, existing-vault connections only |
| Android execution | Explicit per-vault background enable/pause, one-shot manual reconciliation, best-effort foreground execution and reboot/unlock recovery with honest restricted status |
| Android network policy | Global mobile-data default plus per-vault inherit/allow/Wi-Fi-only; global HTTP developer opt-in without disabling HTTPS certificate validation |
| iOS local model | Complete offline vault in app-owned durable storage |
| History trigger | Debounced completed filesystem changes |
| Retention | All for 3 days, daily through 30 days, monthly through one year, then current state |
| Server durability | Validate checksums; operator manages backups |
| Device revocation | Prevent future server access only |
| Transport security | External reverse proxy, VPN, or trusted network; no built-in TLS |
| CLI role | Server runtime, bootstrap/enrollment, device administration, maintenance reports, and foreground one-shot/continuous sync; no client service package or local IPC |

## Frozen version 1 implementation decisions

These choices are part of persistent format `1` and protocol `1`. Details and limits are normative in [formats.md](formats.md), [security.md](security.md), and [threat-model.md](threat-model.md).

| Area | Version 1 decision |
|---|---|
| Runtime | Bun/TypeScript for server, Linux adapters, and server/account CLI; shared core uses portable Web Crypto and WHATWG interfaces. Android uses native Java UI/platform adapters and a restricted bundled WebView computation worker. |
| Chunking | Fixed 4 MiB, recorded per file/format; only the final chunk may be smaller; all 50 GB paths stream. |
| Crypto | SHA-256 ciphertext checksums, HMAC-SHA-256 vault chunk IDs, HKDF-SHA-256 domain derivation, and AES-256-GCM as specified in `security.md`; independent review is required. |
| Authentication | Argon2id password verifier and independent random 256-bit per-device bearer credentials; no v1 credential expiry, rotation on re-enrollment. |
| Metadata DB | SQLite through `bun:sqlite`, WAL, foreign keys, 5-second busy timeout, `synchronous=FULL`, and explicit `BEGIN IMMEDIATE` writes. |
| Filesystems | Regular files/directories plus owner-executable bit only. Reject links, special files, and unsafe names visibly; no xattr, ACL, or sparse fidelity. |
| Retention/GC | UTC buckets select newest accepted revision; 24-hour grace plus recheck; current/conflicts/transfers/needed merge bases remain protected. |
| Network/admin | Loopback by default, acknowledged non-loopback exposure and external TLS; CLI-only administration uses the same server API. |
| Bootstrap | Explicit injected authorization; staged singleton initialization, normal streaming object validation, then atomic zero-parent genesis publication and permanent sealing. No credential is issued in this stage. The external authorization boundary remains available only as an independent handoff for one-time initial-device activation; bootstrap mutations stay sealed. |
| Authentication operations | Password sessions last 10 minutes before enrollment and 24 hours after binding. At most 64 live sessions, 32 pending enrollments, and 64 devices are retained. Five failures in 15 minutes lock login for 15 minutes. Argon2 work is limited to two concurrent jobs. Audit events are retained 365 days. Self-revocation and last-active-administrator revocation are forbidden. |

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

### Conflict naming and client-side merge

`sync-core` merges authenticated base/local/remote v1 manifests by stable ID. The remote head wins divergent content and destination ties; the losing file content gets a distinct deterministic UUID and conflict lineage. A directory destination tie is reported in the merge result (without cloning the subtree). A deletion wins over an unchanged entry; delete/edit keeps the tombstone and copies changed file content. Delete versus directory move or descendant change keeps the original tombstone and materializes a new conflict directory at the surviving destination with its complete surviving subtree and unchanged descendant IDs. Other deleted directories with surviving descendants get a conflict directory under the nearest live ancestor; pre-existing descendant tombstones are not discarded. Path collisions preserve both IDs by renaming the lower-priority live entry; tombstones take priority. Generated names include source device, UTC client display time, revision, and entry ID, truncate on Unicode code-point boundaries to the v1 255-byte limit, and try at most 32 suffixes. Client timestamps are untrusted labels, not an ordering authority. Unrepresentable trees and exhausted collisions fail visibly.

## Deferred design areas

These should not constrain version 1 unless a chosen data format would make them impossible later:

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
