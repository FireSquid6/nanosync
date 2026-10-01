# `@nanosync/client-local`

This package is the Bun/Linux local persistence adapter for `@nanosync/sync-core`. `ClientLocal` implements the `ChunkJournal` cache and provides durable client metadata: stable entries and filesystem identities, observed/accepted/applied heads, operation and transfer queues, conflicts, frozen publication proposals, and hydration/restore intents. Its API is exported from `src/index.ts` and it depends on `@nanosync/protocol` and `@nanosync/sync-core`.

This is a library, not a running sync service. Users integrate and supervise their own runner with the portable core and Linux adapter; the CLI provides only server, enrollment, and administration commands.

The adapter uses Bun SQLite with FULL synchronous writes, checked migrations/integrity, and private chunk files. It requires a pre-existing safe private directory when opening existing state, creates its own private files, and fails closed on unsafe paths, mismatched vault/device identity, or inconsistent schema. Cache entries are opportunistic, not authoritative copies of user files. Because this layer has no vault master key, callers must authenticate/decrypt chunks and validate keyed IDs before caching; retrieved bytes must also be reauthenticated.

The local journal is not rollback-proof against replacement by an older private-state backup and provides no hardware monotonic counter. Never place passwords, recovery secrets, or bearer credentials in operation details. `docs/clients-and-operations.md` documents proposal replay and hydration behavior.
