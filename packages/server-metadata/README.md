# `@nanosync/server-metadata`

This package owns Nanosync server metadata persistence in SQLite. The exported `ServerMetadataDatabase` and repositories cover object catalog/integrity state, revision publication and heads, bootstrap lifecycle, authentication/devices, and maintenance queries. Migrations and schema definitions are part of the package's persistence contract. It depends on `@nanosync/protocol` for validated shared types and limits.

Repositories provide transactional metadata operations, including the atomic head/idempotency decisions needed for publication. They do not store object bytes: ciphertext is handled by `@nanosync/server-object-storage`, and consistency across the two stores is coordinated by `@nanosync/server-core`. Metadata presence alone does not prove the corresponding file exists or is intact; maintenance checks compare catalog state with storage. The repository layer does not decrypt client content or validate the client-held reference-set MAC.

Use the package's database opening and repository APIs rather than editing schema state directly. Backups must preserve metadata and immutable objects from a consistent point; see `docs/clients-and-operations.md`.
