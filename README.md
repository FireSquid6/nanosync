# nanosync

To install dependencies:

```bash
bun install
```

To run the Linux CLI and server from source, see [packages/cli/README.md](packages/cli/README.md).

To produce the distributable Linux x86-64 single-file executable (including the CLI,
server, workspace packages, and Bun runtime):

```bash
bun run build:binary
./dist/nanosync --help
```

Packaging scripts should take the executable from `dist/nanosync`. It is ignored by
Git and can be copied and run without a separate Bun installation or `node_modules`.
Build on a Linux x86-64 host with `bun install` completed first; the compiled
executable targets Linux x86-64 and still requires the host's standard Linux
system libraries. Runtime data (server state and client credentials) remains in
the directories supplied to the CLI, not alongside the executable.
