# Installation

No release binary has been published yet. Build from the repository rather than using the release installer: it cannot succeed until a release exists.

## Build the standalone executable

Use a Linux x86-64 machine with Git and Bun installed. Bun 1.4.2 is verified; avoid Bun 1.3.3, which fails some SQLite close operations. If you use Nix, enter the repository's `nix develop` shell after cloning to get the pinned Bun and Node tools. Run these commands in a directory where you want to keep the checkout:

```sh
git clone https://github.com/FireSquid6/nanosync.git
cd nanosync
bun install
bun run build:binary
./dist/nanosync --help
```

The build bundles the browser administration assets, workspace packages, CLI, server, and Bun runtime into `dist/nanosync`. The executable can be copied outside the checkout; it does not need adjacent assets, `node_modules`, or a separate Bun installation. It still needs the host's standard Linux system libraries.

Install it for your user, without overwriting an existing installation unintentionally:

```sh
mkdir -p "$HOME/.local/bin"
# Check any existing nanosync executable before replacing it.
install -m 0755 dist/nanosync "$HOME/.local/bin/nanosync"
export PATH="$HOME/.local/bin:$PATH"
nanosync --help
```

Add `~/.local/bin` to your shell's persistent `PATH` configuration if it is not already there. Subsequent guides assume `nanosync` resolves to this executable.

For development, after dependency installation, commands can instead be run from the repository root as `bun packages/cli/src/main.ts --help`. Replace the `nanosync` prefix in examples with `bun packages/cli/src/main.ts` when using this form.

## Nix alternative

On Linux x86-64 with Nix flakes enabled, build from the checkout without installing Bun globally:

```sh
nix build .#nanosync
./result/bin/nanosync --help
nix profile install .#nanosync
```

The Nix package includes a launcher for the compiled executable and its system-library environment. Use that launcher rather than extracting its internal ELF binary.

## State is separate from the executable

Every server command needs `--server-dir DIRECTORY`, or an interactive answer; there is no default server directory. Client credentials, cached vault keys, journals, and replica state default to `~/.nanosync`. Use `--client-dir DIRECTORY` consistently on every client command to select a different private state directory.

Private state directories must be real, owned by the executing user, and mode 0700. Secret files must be owned regular files with mode 0600, without symlinks or hard links. Keep state and recovery material outside all sync folders. Run the server and its local administration commands as the same dedicated operating-system user; root is not required.

## Existing installations

This command/state redesign has no supported migration from older setup state or legacy commands. Preserve old server metadata, objects, client state, plaintext, and recovery material before changing anything. Use fresh server and client directories and import a separate plaintext copy deliberately. Do not reuse an old folder's `.nanosync` marker with new state or delete your only copy to make an error disappear.

Continue with [First sync](first-sync.md).
