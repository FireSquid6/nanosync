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

## Install from a GitHub release (no checkout or Bun required)

On Linux x86-64, after a version-tagged GitHub release has been published:

```sh
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | bash
```

This installs the latest release to `~/.local/bin/nanosync` and verifies the
download against the release's SHA-256 file. Ensure `~/.local/bin` is on your
`PATH`. To pin a release or change the destination:

```sh
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | NANOSYNC_VERSION=v1.0.0 NANOSYNC_INSTALL_DIR=/your/bin bash
```

The installer requires `curl` and `sha256sum`; it does not fetch source or
build anything. **No release exists yet**, so the command will fail until one
is published. Inspect the script before piping it into a shell if desired.

## Publish a release

Merge the release workflow and installer into `main` first. Run the tests and
typecheck, then create and push a `v`-prefixed version tag (for example,
`git tag v1.0.0 && git push origin v1.0.0`). The tag-triggered workflow runs
the tests and typecheck again, builds the Linux x86-64 binary, checks it,
and publishes `nanosync-linux-x64` and `nanosync-linux-x64.sha256` to the
GitHub release. The installer uses those assets for either `latest` or an
explicit `NANOSYNC_VERSION`; it will not fall back to building from `main`.
