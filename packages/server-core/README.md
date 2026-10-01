# `@nanosync/server-core`

This package implements the Nanosync HTTP server boundary and application services. `createServerHandler` builds a Fetch-style request handler; `startServer` serves it with Bun. Routes cover capabilities/health, object transfer, revision/head publication, bootstrap, authentication/device administration, and authenticated maintenance. Services enforce protocol validation, authorization context, object/catalog coordination, revision checks, and safe public error responses.

Dependencies are `@nanosync/protocol`, `@nanosync/server-metadata`, `@nanosync/server-object-storage`, and Argon2 support. Storage and repositories are injected through `ServerDependencies`; authentication, bootstrap authorization, configuration, and clocks can also be supplied explicitly. This makes the core's trust boundaries visible rather than assuming a network identity or storage implementation.

The server stores encrypted objects and opaque recovery wraps; it cannot decrypt manifests, verify client MACs, or guarantee client plaintext correctness. Metadata transactions cannot include filesystem publication, so retry and integrity checks are essential. The server does not provide transport encryption: exposed deployments require a trusted TLS/VPN boundary. See `docs/clients-and-operations.md` for deployment and backup requirements.
