# nanosync

Self-hosted, client-encrypted file synchronization for Linux. One executable provides the server, Linux client, and optional browser administration. Sync is not backup; keep independent copies of important data and offline recovery material.

## User documentation

The authoritative user guides live in [`apps/site/content/docs`](apps/site/content/docs/introduction.md):

1. [Introduction](apps/site/content/docs/introduction.md)
2. [Installation: source, Nix, and release availability](apps/site/content/docs/installation.md)
3. [First sync with demo folders](apps/site/content/docs/first-sync.md)
4. [Server and HTTPS proxy setup](apps/site/content/docs/server.md)
5. [Administration and backups](apps/site/content/docs/administration.md)
6. [Ignore rules](apps/site/content/docs/ignore-rules.md)
7. [Troubleshooting](apps/site/content/docs/troubleshooting.md)
8. [Security](apps/site/content/docs/security.md)

**No release exists yet.** Use the source build or local Nix flake; Nix is preferred for Nix users. The installation guide includes explicitly gated future installer/manual-download instructions, not currently available release downloads. No AUR package is published. Linux is the only shipped sync client; there are no CLI history or restore commands. This command/state redesign has no supported migration from old setup state. Preserve old data, plaintext, and secrets before deliberately starting fresh.

The [CLI reference](packages/cli/README.md) documents flags, JSON/exit codes, and automation contracts. [Engineering documentation](docs/README.md) covers implementation, protocol formats, and future platform work; it is not a list of shipped user features.

## Contributor setup and builds

Use `nix develop` for the pinned Bun and Node development tools, then install workspace dependencies from the repository root. Bun 1.4.2 is verified; the older Bun 1.3.3 fails SQLite close operations in the CLI journey.

```sh
bun install
bun packages/cli/src/main.ts --help
```

To run the Linux CLI and server from source, see [packages/cli/README.md](packages/cli/README.md).

## Desktop UI preview

The [Electrobun desktop app](apps/electrobun/README.md) implements the issue #18
Field Guide interface with a mock backend. Run `bun run dev:electrobun` or check
its browser flows with `bun run test:electrobun`. It does not sync files or share
CLI state yet; real Linux native integration and packaging remain unvalidated.

## Android

The native Android 12+ dashboard connects existing vaults to shared local folders,
with manual and opt-in background synchronization. See
[apps/android/README.md](apps/android/README.md) for the pinned Nix toolchain,
APK builds, enrollment, permissions, and emulator/device verification. There is no iOS app or build.

```sh
nix develop .#android-build
bun install --frozen-lockfile
gradle -p apps/android :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

The planned release artifacts are `nanosync-android-debug.apk` and its `.sha256`: a **debug-signed validation build, not a production release**. Production signing keys are absent; production signing must remain fail-closed. The release build/lint gate does not run emulator or physical-device runtime checks. No release assets are published yet; build locally for now. The CLI installer installs only the CLI, never the APK.

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

Merge the release workflow and installer into `main` first. Run the tests and typecheck, then create and push a version tag (for example, `git tag v1.0.0 && git push origin v1.0.0`). Stable tags use `vMAJOR.MINOR.PATCH`; prerelease suffixes such as `v1.2.0-beta.1` publish prereleases, excluded from default latest-stable installation. Malformed tags must not publish. Stable latest selection follows version precedence, not publication order. Publication is serialized with GitHub's `queue: max` (up to 100 pending jobs); if that queue fills, rerun canceled tag workflows. Existing public assets are verified rather than overwritten; incomplete drafts can be retried.

The release contract is four executables: `nanosync-linux-x64`, `nanosync-linux-arm64`, `nanosync-darwin-x64`, and `nanosync-darwin-arm64`, each with its own `.sha256` file. The release also includes `nanosync-android-debug.apk` and `nanosync-android-debug.apk.sha256` (10 assets total). Publication is gated on all four CLI builds, tests/typechecking, required Linux runtime/standalone checks, and the reusable Android build/lint workflow; cross-compilation alone is not runtime validation. The workflow requires native Linux x86-64 and ARM64 runtime/standalone checks on their respective runners; these gates are not evidence of a release already published. **macOS assets are Bun build outputs with untested runtime behavior.** The Android APK is debug-signed for validation, not production, and the release does not run device runtime checks. No iOS/desktop packaging or source-build fallback is included. Installer availability requires all eight CLI assets; it does not install Android.

After these assets are actually published, the convenience install/update command will be:

```bash
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | bash
```

**Do not use this as a working installation path yet.** See [Installation](apps/site/content/docs/installation.md) for prerequisites (Bash 3.2+, curl, SHA-256 tooling and system utilities), version pinning, manual verification, PATH, and ownership/update restrictions. The default destination is `~/.local/bin/nanosync`; `NANOSYNC_VERSION` and `NANOSYNC_INSTALL_DIR` select a release and destination directory. The installer updates only unchanged installer-owned copies, not package-managed files, and does not edit shell profiles, application state, services, or processes. Restart running clients/servers manually after updating. Published checksums detect corruption, not publisher compromise; there is no independent signing. `--no-verify` skips only the published checksum comparison and retains HTTPS, local hashing, and ownership protection.

## Acceptance checks

Pull requests run the host tests, installer fixtures, typechecking, standalone CLI build/checks, both browser suites, all four CLI target builds, and Android build/unit-test/lint tasks. Ordinary branch pushes do not trigger these workflows; version-tag pushes still run release validation and publication. Android emulator/device acceptance tests remain the separate commands in [Android testing](apps/android/README.md). The browser checks use the project-local `nix develop .#checks` shell for Bun, Node, Python, and Chromium.

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
