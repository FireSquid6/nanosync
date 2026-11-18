# Introduction

nanosync synchronizes ordinary Linux folders through a server you operate. File contents and manifests are encrypted before upload. One owner can manage multiple independent **vaults**, each with its own recovery secret, and approve multiple devices.

A **connection** stores this client's identity for a server. A **binding** connects a local folder to a vault. Connecting a folder transfers nothing; `client sync` performs a synchronization pass, and `client sync --watch` keeps syncing in the foreground.

## What ships today

The CLI provides the server, local owner administration, device enrollment, and Linux synchronization. An optional browser interface administers the server; it is not a browser file-sync client. Linux is the only shipped sync client. Android and iOS synchronization are not available.

The standalone build targets Linux x86-64. There is no bundled background client service: run watch mode yourself or supervise it with your own service manager. The CLI has no history, restore, status, conflict-resolution, eviction, or download commands. Library capabilities and engineering plans are not promises of user-facing commands.

Regular files, directories, and the owner-executable bit are synchronized. Included symlinks, hard-linked files, sockets, devices, and FIFOs fail visibly. Other mode bits, ACLs, extended attributes, and sparse-file layout are not preserved. Start with disposable folders before importing real data.

## Sync is not backup

Changes and deletions propagate between replicas. A second synchronized folder is not an independent backup, and a recovery secret cannot recreate missing server objects. Although the server retains revision data, this release has no CLI history browser or restore command. Keep separate, tested backups of important plaintext and consistent server backups.

Server vault deletion is permanent: it destroys the vault's server-side history, encrypted objects, and recovery wraps. It does not wipe client files. Revoking a device stops future server access but cannot erase downloaded files or keys.

## Before you begin

You need a Linux host, disk space for server storage and complete local replicas, a way to keep recovery secrets offline, and a plan for backups. Remote access needs transport protection; the server speaks HTTP, not HTTPS. Use an HTTPS reverse proxy before sending passwords or syncing over an untrusted network.

Build from source with [Installation](installation.md), then follow [First sync](first-sync.md) using demo folders. Read [Security](security.md) before exposing a server or entrusting it with sensitive data. The cryptographic design still requires independent review before production use.
