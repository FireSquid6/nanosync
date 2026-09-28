# Nanosync

Nanosync is a self-hosted, client-encrypted file synchronization system for Linux, Android, and command-line clients. It is designed first for one user, one vault, and one server while preserving boundaries that can support additional storage backends and platforms later.

## Design goals

- Synchronize ordinary files through a central, authoritative server.
- Support small files and individual files as large as 50 GB.
- Keep file contents and manifests encrypted from the server.
- Preserve file history, moves, renames, conflicts, and deletions.
- Resume interrupted transfers at completed fixed-size chunk boundaries.
- Provide a normal Linux synchronization folder and a complete offline Android copy.
- Remain straightforward to self-host as a single server binary.

## Version 1 scope

- One user and one vault per server.
- Linux desktop client.
- Android client.
- Continuous CLI sync daemon with management commands.
- Local server storage behind an abstract `Filesystem` interface.
- Password authentication, device approval, and recovery-key-based vault access.
- Operator-managed network security through a reverse proxy or VPN.

## Documents

- [Requirements and scope](requirements.md)
- [System architecture](architecture.md)
- [Data model and sync protocol](sync-protocol.md)
- [Security and trust model](security.md)
- [Clients and operations](clients-and-operations.md)
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
