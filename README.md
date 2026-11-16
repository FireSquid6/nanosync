# nanosync

To install dependencies:

```bash
bun install
```

To run the Linux CLI and server from source, see [packages/cli/README.md](packages/cli/README.md).

## Android

The native Android 12+ dashboard connects existing vaults to shared local folders,
with manual and opt-in background synchronization. See
[apps/android/README.md](apps/android/README.md) for the pinned Nix toolchain,
APK builds, enrollment, permissions, and emulator/device verification.

```sh
nix develop .#android-build
bun install --frozen-lockfile
bun run build:android
```

## Owner and client quick start

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
# Provision locally while the runtime is stopped; save/acknowledge the secret.
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
nanosync server run --server-dir "$HOME/nanosync-server" --web-ui
# In another terminal/on the client:
nanosync client connections add --url http://127.0.0.1:7337 --alias home
# Compare the printed code; approve the exact request in /admin or server devices approve.
nanosync client vaults connect --server home --vault documents --path "$HOME/Sync"
nanosync client sync --path "$HOME/Sync"
```

Create the destination directory first. Browser administration is **off by default**;
`--web-ui` embeds `/admin` on the existing listener, with no adjacent assets or
frontend service. Remote browser access requires an HTTPS reverse proxy with explicit
[external origin/proxy configuration](docs/clients-and-operations.md#reverse-proxy-example).
The browser trusts served code; malicious server JavaScript is not resisted.

This is a **breaking command/state redesign**, without aliases or automatic state
migration. Back up old data and recovery material before deliberately initializing
new state. See [operations](docs/clients-and-operations.md#administration) and the
[CLI contract](packages/cli/README.md) for secrets, JSON/exit codes, confirmations,
retry and reset guidance. Disconnect/remove preserves files; revoke removes access;
permanent deletion destroys server data, never silently erases client plaintext.

Before importing a documents folder, put a local `.nanosyncignore` at its root to
exclude virtual environments (for example `.venv/`), caches, and other data that
cannot safely be synced. Excluded paths are never followed, uploaded, downloaded,
or treated as deletions; rules are device-local, not `.gitignore` rules. See the
[ignore file guide](packages/cli/README.md#local-ignore-file) for syntax, limits,
and how to handle already-tracked entries.

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

## Acceptance checks

```sh
bun test
bun run typecheck
bun run test:browser   # real Chromium; set CHROMIUM_PATH if needed
bun test packages/cli/tests/terminal.test.ts  # real Python PTY
bash build/test-install.sh
bun run build:binary
bash build/test-standalone.sh  # copies the binary outside the checkout; no adjacent files
NANOSYNC_TEST_BINARY="$PWD/dist/nanosync" bun run test:browser
```

See [implementation evidence](docs/implementation-progress.md) for requirement
coverage and [Nix packaging](build/nix/README.md) for the offline package build.
