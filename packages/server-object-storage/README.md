# `@nanosync/server-object-storage`

This package provides the server's immutable ciphertext object-store abstraction. Its exported `Filesystem` interface supports conditional publication (`putIfAbsent`), streamed and ranged reads, stat/existence checks, deletion, and cursor-based listing. `LocalFilesystem` implements that interface over a private local directory and enforces object keys, checksums, size bounds, and safe regular-file handling.

Objects are opaque ciphertext here: storage does not decrypt them or establish that their contents are valid Nanosync frames. The API streams data and defaults to a 64 GiB maximum object size; protocol-aware frame validation belongs to server-core. Publication is durable at the filesystem layer but is not transactionally coupled to the metadata database. The server therefore coordinates catalog/idempotency updates and repairs interrupted publication by retry; operators must not externally mutate the object store. No server-wide live garbage collector is provided.

The package uses Node filesystem and crypto APIs and has no workspace runtime dependency. See `docs/formats.md` for object frame limits and `docs/clients-and-operations.md` for storage, backup, and offline-GC boundaries.
