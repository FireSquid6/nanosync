# Engineering documentation

For installation, first sync, server operation, administration, ignore rules, troubleshooting, and security guidance, start with the authoritative [user documentation](../apps/site/content/docs/introduction.md).

This directory retains requirements, design rationale, protocol contracts, and implementation notes. Goals, suggested configuration, mobile plans, and library capabilities below are not a list of shipped CLI features. Linux is the only shipped sync client; no CLI history or restore command exists.

## Project overview

Nanosync is a self-hosted, client-encrypted file synchronization system with portable client libraries and a Bun CLI for server administration and Linux synchronization. One owner can operate multiple independent vaults and local replicas on a server.

## Design goals

- Synchronize ordinary files through a central, authoritative server.
- Support small files and individual files as large as 50 GB.
- Keep file contents and manifests encrypted from the server.
- Preserve file history, moves, renames, conflicts, and deletions.
- Resume interrupted transfers at completed fixed-size chunk boundaries.
- Provide ordinary Linux folders and complete non-ignored offline Android shared folders; iOS remains deferred.
- Remain straightforward to self-host as a single server binary.

## Version 1 scope

- One owner and multiple encrypted vaults per server; server-wide device enrollment, per-vault recovery keys.
- Portable sync core and Linux filesystem/local-state libraries, with foreground one-shot and continuous CLI sync commands. Users choose how to launch continuous sync at startup; no background service or local IPC is shipped.
- Native Android 12+ multi-server dashboard and shared-folder synchronization, with explicit background controls; see [mobile architecture](mobile.md) and [verification tracking](android-implementation.md). iOS remains deferred.
- Local server storage behind an abstract `Filesystem` interface.
- Password authentication, device approval, and recovery-key-based vault access.
- Operator-managed network security through a reverse proxy or VPN.

## Documents

- [Requirements and scope](requirements.md)
- [System architecture](architecture.md)
- [Data model and sync protocol](sync-protocol.md)
- [Security and trust model](security.md)
- [Version 1 formats and protocol contract](formats.md)
- [Version 1 threat model](threat-model.md)
- [Clients and operations](clients-and-operations.md)
- [Native Android client](mobile.md)
- [Android implementation and acceptance](android-implementation.md)
- [Decisions and open questions](decisions.md)

## Terminology

- **Vault:** The complete synchronized namespace and its history.
- **Device:** An approved client installation with its own authentication credential.
- **Chunk:** An immutable, fixed-size segment of encrypted file content.
- **Manifest:** An encrypted description of a vault tree at a revision.
- **Revision:** An immutable version of the vault state.
- **Head:** The current authoritative revision accepted by the server.
- **Tombstone:** A retained record that a file was deleted.
- **Remote-only file:** A file represented in the vault but absent from the Linux synchronization folder after explicit eviction.
