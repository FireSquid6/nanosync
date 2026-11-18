# Installation

**No release binaries have been published yet.** Use the source build or local Nix flake below today. The release installer and manual-download examples are for use **only after** a [GitHub release](https://github.com/FireSquid6/nanosync/releases) contains the required binary and checksum. There is no source-build fallback. An AUR package is not published.

## Nix (preferred for Nix users)

The repository's local flake supports Linux x86-64 with flakes enabled. Clone the repository, then build or install from that checkout:

```sh
# Linux x86-64, with Nix flakes enabled
git clone https://github.com/FireSquid6/nanosync.git
cd nanosync
nix build .#nanosync
./result/bin/nanosync --help
nix profile install .#nanosync
```

The Nix package includes a launcher for the compiled executable and its system-library environment. Use that launcher rather than extracting its internal ELF binary. Manage updates with Nix, not the release installer. A `nix develop` shell is also available for source development.

## Build the standalone executable

Use a Linux x86-64 machine with Git and Bun installed. Bun 1.4.2 is verified; avoid Bun 1.3.3, which fails some SQLite close operations. Run these commands in a directory where you want to keep the checkout:

```sh
git clone https://github.com/FireSquid6/nanosync.git
cd nanosync
bun install
bun run build:binary
./dist/nanosync --help
```

The default build bundles the browser administration assets, workspace packages, CLI, server, and Bun runtime into `dist/nanosync`. It can run outside the checkout without adjacent assets, `node_modules`, or a separate Bun installation. It still needs the host's standard Linux system libraries. This source-build procedure is validated on Linux x86-64, not macOS. Explicit cross-build syntax is `bash build/binary.sh TARGET OUTPUT`, for example `bash build/binary.sh linux-arm64 dist/nanosync-linux-arm64`; targets match the four platform/architecture suffixes below. Omitting arguments preserves `dist/nanosync` for Linux x86-64.

You can run `./dist/nanosync` directly. Before installing a copy into `~/.local/bin`, inspect `command -v nanosync` and any existing destination; do not replace a symlink, unknown file, or package-managed installation. Use its package manager instead. A source-built copy has no release-installer ownership receipt and must not be silently taken over by that installer.

For development, after dependency installation, run `bun packages/cli/src/main.ts --help` from the repository root. Replace the `nanosync` prefix in examples with that command when using this form.

## Release installer (after assets are published)

**Not available yet:** these commands require published release assets. Check the release page first. The asset contract is:

| Platform | Architecture | Executable |
| --- | --- | --- |
| Linux | x86-64 | `nanosync-linux-x64` |
| Linux | ARM64 | `nanosync-linux-arm64` |
| macOS | Intel x86-64 | `nanosync-darwin-x64` |
| macOS | Apple Silicon ARM64 | `nanosync-darwin-arm64` |

Each executable has a corresponding `.sha256` file, for example `nanosync-linux-x64.sha256`. These contain the standalone CLI, including server and client commands, not desktop or mobile apps. **macOS executables are Bun build outputs with untested runtime behavior.** The release workflow requires native Linux x86-64 and ARM64 runtime/standalone checks on their respective runners; these are publication gates, not evidence of a release already published. Cross-compilation alone is not runtime validation. Do not infer macOS source-build support from these assets.

Prerequisites: Bash 3.2+, `curl`, either `sha256sum` or `shasum` (with `-a 256` support), and standard system utilities such as `uname`, `mkdir`, `mktemp`, `chmod`, `mv`, `rm`, `cat`, and `cmp`. The installer does not install missing dependencies, use root or `sudo`, or edit shell startup files.

After publication, install or update with:

```bash
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | bash
```

The default destination is `~/.local/bin/nanosync` (`NANOSYNC_INSTALL_DIR` overrides the directory). To pin a published version, set the environment on **Bash**, not on curl:

```bash
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | NANOSYNC_VERSION=v1.2.3 bash
```

`v1.2.3` is an example, not an available release. By default the installer selects the latest stable release, excluding prereleases, and resolves one immutable tag for both binary and checksum downloads. An explicit pin can select a published prerelease.

### PATH and updates

If `~/.local/bin` is not on your PATH, use this in your current shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
command -v nanosync
nanosync --help
```

Add that PATH setting to your own shell configuration if desired; the installer never does so. Check which executable resolves before using the commands in subsequent guides.

The installer records destination-associated ownership, version, and binary hash outside application sync state, under `${XDG_STATE_HOME:-$HOME/.local/state}/nanosync-installer`. Rerunning updates only an unchanged installer-owned destination. Unknown or modified files, symlinks, and package-managed installations are protected; follow the diagnostic rather than deleting files or receipts to bypass it. If a package-managed executable is active on PATH, update through that package manager instead of creating a shadow copy.

Receipt-less copies from the old installer require explicit adoption (`--adopt-existing`); inspect their origin first. Adoption cannot detect a downgrade because the previous version is unknown, and prints a warning. After adoption, downgrades require explicit permission (`--allow-downgrade`). Pass flags after `bash -s --`, as in the example below. Neither option is permission to overwrite package-managed files or symlinks.

Installation stages downloads on the destination filesystem and verifies them before atomic replacement. Download or checksum failures before replacement preserve the existing executable; it never automatically retries without verification. It only installs the executable and maintains its ownership receipt: it does not enroll devices, initialize servers, alter application state or credentials, start/stop processes, or create services/autostart entries. **Restart running client/server processes yourself** after updating; they continue using their old executable until restarted. There is no background self-updater.

### Verification and trust

By default, the installer requires a strict SHA-256 checksum for the exact selected asset and verifies it before replacement. HTTPS plus a checksum published by the same GitHub publisher detects corruption, **not compromise of that publisher**. Releases are not independently signed. Piping a script into Bash also trusts the script served from `main`; download and inspect it first if you prefer.

Only if you deliberately accept skipping the published checksum check:

```bash
curl -fsSL https://raw.githubusercontent.com/FireSquid6/nanosync/main/build/install.sh | bash -s -- --no-verify
```

`--no-verify` prints a prominent warning and skips **only** comparison with the published release checksum. HTTPS, local hashing, and ownership/overwrite safeguards remain required; you still need `sha256sum` or `shasum`. It is not a workaround for ownership errors.

## Manual download (after assets are published)

**Not available yet.** Once the chosen tag has both assets, use Bash to download into a new temporary directory, validate the exact checksum line, and verify before execution. Choose the asset from the table; this example is Linux x86-64. Replace the example version with a published tag:

```bash
version=v1.2.3
asset=nanosync-linux-x64
download_dir=$(mktemp -d) || exit 1
(
  set -e
  cd "$download_dir"
  base="https://github.com/FireSquid6/nanosync/releases/download/$version"
  curl -fLSs --proto '=https' --proto-redir '=https' -o "$asset" "$base/$asset"
  curl -fLSs --proto '=https' --proto-redir '=https' -o "$asset.sha256" "$base/$asset.sha256"
  checksum=$(cat "$asset.sha256")
  [[ $checksum =~ ^[0-9a-f]{64}\ \ $asset$ ]] || { echo 'Invalid checksum file' >&2; exit 1; }
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$asset.sha256"
  else
    shasum -a 256 -c "$asset.sha256"
  fi
  chmod 755 "$asset"
  "./$asset" --help
)
```

Do not continue if any step fails. This example does not overwrite an installed executable; the verified file remains in `$download_dir`. Run it there, or deliberately arrange installation only after inspecting your destination and package-manager ownership. Manual downloads do not create an installer receipt. Remove the temporary directory yourself when finished. The same publisher-trust limitation applies to manual checksums.

## Android validation build

The Android 12+ app connects existing vaults to shared local folders. Build with the repository's pinned Nix Android toolchain:

```sh
nix develop .#android-build
bun install --frozen-lockfile
gradle -p apps/android :app:assembleDebug :app:assembleDebugAndroidTest :app:lintDebug
```

The release contract includes `nanosync-android-debug.apk` and `nanosync-android-debug.apk.sha256`, in addition to the eight CLI assets (10 assets total). **No release assets are published yet.** The APK is a **debug-signed validation build, not a production release**. Debug signing keys can differ between builds, so these APKs do not promise an in-place update path; do not delete existing app data to force installation. Production signing keys are absent; production signing must fail closed. The release is gated on the reusable Android build/lint workflow, but it does not run emulator or physical-device runtime checks. Build success is not device validation. See the repository's `apps/android/README.md` for enrollment, permissions, and emulator/device verification.

The curl installer installs only the CLI, not Android; its rollout requires all eight CLI assets. There is no iOS app or build.

## State is separate from the executable

Every server command needs `--server-dir DIRECTORY`, or an interactive answer; there is no default server directory. Client credentials, cached vault keys, journals, and replica state default to `~/.nanosync`. Use `--client-dir DIRECTORY` consistently on every client command to select a different private state directory.

Private state directories must be real, owned by the executing user, and mode 0700. Secret files must be owned regular files with mode 0600, without symlinks or hard links. Keep state and recovery material outside all sync folders. Run the server and its local administration commands as the same dedicated operating-system user; root is not required.

## Existing installations

This command/state redesign has no supported migration from older setup state or legacy commands. Preserve old server metadata, objects, client state, plaintext, and recovery material before changing anything. Use fresh server and client directories and import a separate plaintext copy deliberately. Do not reuse an old folder's `.nanosync` marker with new state or delete your only copy to make an error disappear. Replacing an executable is not a state migration.

Continue with [First sync](first-sync.md).
