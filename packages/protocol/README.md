# `@nanosync/protocol`

This package defines Nanosync's shared, versioned wire contract. It is the dependency-light source of truth used by clients and server packages so that IDs, validation, and HTTP payload shapes are interpreted consistently.

The public entry point (`src/index.ts`) exports protocol/version constants; parsers and types for revision envelopes, object references, IDs, and authentication/bootstrap messages; object HTTP header and route helpers; and protocol error definitions. It has no runtime dependencies; TypeScript is a peer dependency.

The package validates structure and canonical wire representations, not vault secrets or encrypted plaintext. In particular, server-side protocol parsing cannot verify client-held reference-set MACs or decrypt manifests. Object framing and manifest/AAD details are specified in `docs/formats.md` and `docs/security.md`; operational HTTP behavior is documented in `docs/clients-and-operations.md`. Version changes must preserve explicit format boundaries rather than reinterpret existing bytes.
