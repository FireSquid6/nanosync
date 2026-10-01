# Version 1 Threat Model

This is a design threat model, not a formal proof, production audit, or claim of independent cryptographic review.

## Assets, actors, and boundaries

Assets are plaintext files and names, vault and derived keys, recovery secret, account password, device credentials, revision integrity/history, local metadata, and service availability. Actors are the owner, approved and revoked devices, server operator, network attacker, malicious/compromised server, compromised client, and an attacker with stolen backups.

Plaintext and vault keys cross only the user/client boundary. The server is trusted for availability and serialization, but not content confidentiality. It receives credentials, public revision envelopes, ciphertext, and visible reference sets. External TLS/VPN termination is a separate trusted boundary. Local filesystem, key store, reverse proxy, metadata database, object directory, logs, and backups each need least-privilege access. Any IPC added by an external runner is its integrator's security responsibility; none is shipped.

## Attacks and guarantees

AEAD and client checks detect ciphertext or authenticated-metadata substitution. Ciphertext SHA-256 detects storage corruption but is not authenticity. Vault-scoped keyed chunk IDs prevent public cross-vault plaintext-hash comparison. Per-device credentials permit future server-access revocation.

A malicious server can deny service, omit revisions/objects, reorder responses, replay a valid old view, or roll back account/device state from backup. The local-state adapter records monotonic accepted heads; integrating clients must preserve this state and surface regressions. A new device has no independent freshness anchor. Complete replay/rollback prevention, malicious authorized-client containment, traffic-analysis resistance, and availability are v1 non-goals. Revocation cannot erase downloaded ciphertext, plaintext, keys, or recovery material and does not rotate vault keys.

Compromising an unlocked client reveals its plaintext and vault keys. Password authentication is not vault encryption. A weak password risks account/device enrollment despite Argon2id; the 256-bit recovery secret is independently high entropy.

## Metadata leakage

The server and anyone with its metadata learn account/device records, IP/access timing, revision timestamps and graph, object types and sizes, per-revision membership, reuse/equality within the vault, transfer progress, aggregate storage, conflicts implied by two-parent revisions, and retention/access patterns. Names, paths, plaintext digests, and contents are encrypted, but reference-set changes can correlate activity. Padding and cover traffic are not provided.

## Cryptographic boundaries

All HKDF and AEAD uses carry the exact versioned ASCII labels in [security.md](security.md); object type, vault, version, identity, and relevant length are authenticated to prevent cross-context substitution. Nonces come from a cryptographically secure RNG where randomized. The fixed chunk nonce is safe only if the per-chunk key derivation is sound and keyed IDs never collide/reuse across different plaintext. That construction, recovery encoding/wrapping, manifest/reference binding, key lifecycle, and library use require independent cryptographic review before production.

## Resource and local attacks

Servers enforce body, object, reference, query, page, rate, concurrency, authentication, and decompression limits before allocation or expensive work. Uploads stream to bounded temporary files; checksum and length are verified before publication. Parsers reject duplicate/unknown fields and pathological numbers. GC waits 24 hours and rechecks reachability, preferring leaks to loss.

Clients must treat remote names and manifests as hostile: reject absolute paths, `..`, separators in components, NUL/control characters, invalid UTF-8, and platform-invalid or oversized names. Operations use directory-relative/no-follow primitives and recheck races. V1 rejects symlinks, hard-linked files, devices, sockets, and FIFOs rather than following them. Plaintext temporary files, crash dumps, swap, clipboard recovery secrets, backups, and logs are local disclosure risks; secure deletion is not guaranteed. External runners must secure any IPC they introduce.

## Transport and operations

Plain HTTP supplies no confidentiality, server authentication, or credential replay protection. The server binds loopback by default; non-loopback requires explicit acknowledgement. Deployment must use correctly configured external TLS, a VPN, or an equivalently trusted network. Forwarded headers are trusted only from configured proxies. The server-side credential pepper needs restrictive permissions and backup separate from database data; losing it invalidates credentials, while disclosure enables offline digest testing of stolen bearer credentials (still 256-bit random).

Before production, commission external crypto/security review and penetration testing covering protocol parsing, authentication/enrollment/revocation, proxy configuration, filesystem races/path traversal, SQLite backup/restore, rollback behavior, and resource exhaustion. Resolve findings and document the exact reviewed implementation and versions.
