# Decisions and Open Questions

## Confirmed product decisions

| Area | Decision |
|---|---|
| Initial audience | One household or small trusted team, initially one user |
| Server tenancy | One owner/password and multiple independent vaults per server (including zero vaults) |
| Topology | Central authoritative server |
| Initial clients | Portable sync core and Linux adapters with foreground CLI sync; Android integration remains platform work |
| Encryption | Client/browser-side encryption; offline server-local provisioning may handle keys transiently, never persist them |
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
| Android local model | Complete offline vault |
| Android capacity failure | Fail visibly if the vault does not fit |
| Mobile filesystem integration | Android DocumentsProvider and iOS File Provider expose writable vault locations in system file browsers; external saves queue local changes for sync |
| iOS local model | Complete offline vault in app-owned durable storage |
| History trigger | Debounced completed filesystem changes |
| Retention | All for 3 days, daily through 30 days, monthly through one year, then current state |
| Server durability | Validate checksums; operator manages backups |
| Device revocation | Prevent future server access only |
| Transport security | External reverse proxy, VPN, or trusted network; no built-in TLS |
| CLI role | Explicit server/client groups; owner-local/browser provisioning, client enrollment/bind/sync; no service installation or local IPC |

## Frozen version 1 implementation decisions

These choices are part of persistent format `1` and protocol `1`. Details and limits are normative in [formats.md](formats.md), [security.md](security.md), and [threat-model.md](threat-model.md).

| Area | Version 1 decision |
|---|---|
| Runtime | Bun/TypeScript for server, Linux adapters, and server/account CLI; shared core uses portable Web Crypto and WHATWG interfaces. Android integration is later platform work. |
| Chunking | Fixed 4 MiB, recorded per file/format; only the final chunk may be smaller; all 50 GB paths stream. |
| Crypto | SHA-256 ciphertext checksums, HMAC-SHA-256 vault chunk IDs, HKDF-SHA-256 domain derivation, and AES-256-GCM as specified in `security.md`; independent review is required. |
| Authentication | Argon2id password verifier and independent random 256-bit per-device bearer credentials; no v1 credential expiry, rotation on re-enrollment. |
| Metadata DB | SQLite through `bun:sqlite`, WAL, foreign keys, 5-second busy timeout, `synchronous=FULL`, and explicit `BEGIN IMMEDIATE` writes. |
| Filesystems | Regular files/directories plus owner-executable bit only. Reject links, special files, and unsafe names visibly; no xattr, ACL, or sparse fidelity. |
| Retention/GC | UTC buckets select newest accepted revision; 24-hour grace plus recheck; current/conflicts/transfers/needed merge bases remain protected. |
| Network/admin | Loopback default; explicit nonloopback sync acknowledgement and external TLS. Opt-in embedded owner browser UI with separate sessions; local owner operations use shared services, not device authority. |
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

Exact socket-peer IP allowlist plus configured HTTPS external origin; no forwarding headers establish trust. See operations for deployment. Nonloopback browser HTTP is always forbidden.

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


## Owner administration redesign (issue #5)

This decision supersedes CLI-only administration and approved-client provisioning.
Vault mutations belong to server-local or password-authenticated browser owner
operations, never sync-device authority. Browser sessions are memory-only, scoped
to administration, with 30-minute idle/12-hour absolute expiry, CSRF and rate limits.
The password suffices to approve devices but does not derive any vault key.

The maintained Inquirer CLI and copied Paper UI/Radix controls provide interactive
workflows with flag alternatives. Old command aliases, bootstrap user workflow and
stored-state migration are intentionally unsupported. Protocol/object crypto remain
v1; reset old setup deliberately with backups, not automatic migration.

Server-local provisioning is an accepted transient plaintext-key exception; explicit
protected recovery delivery is permitted but ordinary server persistence remains
encrypted-only. Browser crypto protects against ordinary persistence inspection,
not malicious code served by a compromised origin. Deletion is owner-confirmed,
tombstones immediately, overrides only that vault's retention, and retries durable
cleanup. Removal, revocation and deletion never silently erase client plaintext.
