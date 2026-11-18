# nanosync

Self-hosted, client-encrypted file synchronization for Linux. One executable provides the server, Linux client, and optional browser administration. Sync is not backup; keep independent copies of important data and offline recovery material.

## User documentation

The authoritative user guides live in [`apps/site/content/docs`](apps/site/content/docs/introduction.md):

1. [Introduction](apps/site/content/docs/introduction.md)
2. [Installation from source](apps/site/content/docs/installation.md)
3. [First sync with demo folders](apps/site/content/docs/first-sync.md)
4. [Server and HTTPS proxy setup](apps/site/content/docs/server.md)
5. [Administration and backups](apps/site/content/docs/administration.md)
6. [Ignore rules](apps/site/content/docs/ignore-rules.md)
7. [Troubleshooting](apps/site/content/docs/troubleshooting.md)
8. [Security](apps/site/content/docs/security.md)

**No release exists yet.** Use the source-build installation guide, not the release installer. Linux is the only shipped sync client; there are no CLI history or restore commands. This command/state redesign has no supported migration from old setup state. Preserve old data, plaintext, and secrets before deliberately starting fresh.

The [CLI reference](packages/cli/README.md) documents flags, JSON/exit codes, and automation contracts. [Engineering documentation](docs/README.md) covers implementation, protocol formats, and future platform work; it is not a list of shipped user features.

## Contributor setup and builds

Use `nix develop` for the pinned Bun and Node development tools, then install workspace dependencies from the repository root. Bun 1.4.2 is verified; the older Bun 1.3.3 fails SQLite close operations in the CLI journey.

```sh
bun install
bun packages/cli/src/main.ts --help
```

## Owner and client quick start

```sh
nanosync server init --server-dir "$HOME/nanosync-server"
# Provision locally while the runtime is stopped; save/acknowledge the vault recovery key.
nanosync server vaults create --server-dir "$HOME/nanosync-server" --name documents
nanosync server run --server-dir "$HOME/nanosync-server" --web-ui
# In another terminal/on the client:
nanosync client connections add --url http://127.0.0.1:7337 --alias home
# Compare the printed code; approve the exact request in /admin or server devices approve.
nanosync client vaults connect --server home --vault documents --path "$HOME/Sync"
nanosync client sync --path "$HOME/Sync"
```

The **vault recovery key** (previously called the recovery secret) unlocks the
vault’s encryption key on new devices. It is not the owner password or a backup
of your files. Save it in a password manager or offline: anyone with this key and
the encrypted vault data can decrypt your files. If you lose both this key and all
clients’ saved vault keys, the owner password cannot recover your data.

Create the destination directory first. Browser administration is **off by default**;
`--web-ui` embeds `/admin` on the existing listener, with no adjacent assets or
frontend service. Remote browser access requires an HTTPS reverse proxy with explicit
[external origin/proxy configuration](docs/clients-and-operations.md#reverse-proxy-example).
The browser trusts served code; malicious server JavaScript is not resisted.

To produce the Linux x86-64 single-file executable, including browser administration assets, CLI, server, workspace packages, and Bun runtime:

```sh
bun run build:binary
./dist/nanosync --help
```

Build on Linux x86-64 after installing dependencies. Packaging scripts should take `dist/nanosync`, which is ignored by Git. It runs outside the checkout without adjacent assets, a separate Bun installation, or `node_modules`, but still requires standard Linux system libraries. State lives in the CLI-selected directories, not beside the executable.

The public Next.js site runs separately: `bun run dev:site`, or `bun run build:site` followed by `bun run --cwd apps/site start`. See [site development](apps/site/README.md) for documentation authoring and design ownership.

See [Nix packaging](build/nix/README.md) for the offline package build and dependency-expression maintenance.

## Publish a release

Merge the release workflow and installer into `main` first. Run the tests and typecheck, then create and push a `v`-prefixed version tag (for example, `git tag v1.0.0 && git push origin v1.0.0`). The tag-triggered workflow runs tests and typecheck again, builds and checks the Linux x86-64 binary, and publishes `nanosync-linux-x64` and `nanosync-linux-x64.sha256` to the GitHub release.

`build/install.sh` downloads published assets and checks their SHA-256 file. It requires `curl` and `sha256sum`, defaults to `~/.local/bin/nanosync`, and accepts `NANOSYNC_VERSION` and `NANOSYNC_INSTALL_DIR` overrides. It does not fall back to building source. Do not recommend it as a working installation method before a release is published.

## Acceptance checks

```sh
bun test
bun run typecheck
bun run build:site
bun run test:site      # production website, real Chromium; set CHROMIUM_PATH
bun run test:browser   # real Chromium; set CHROMIUM_PATH if needed
bun test packages/cli/tests/terminal.test.ts  # real Python PTY
bash build/test-install.sh
bun run build:binary
bash build/test-standalone.sh  # copies the binary outside the checkout; no adjacent files
NANOSYNC_TEST_BINARY="$PWD/dist/nanosync" bun run test:browser
```

See [implementation evidence](docs/implementation-progress.md) for core requirement coverage and [website verification](docs/website-implementation.md) for the site/admin redesign checks.
