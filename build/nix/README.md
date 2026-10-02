# Nix package

On Linux x86-64 with Nix flakes enabled, from the repository root:

```sh
nix build .#nanosync
./result/bin/nanosync --help
nix profile install .#nanosync
```

If building from a fresh Git checkout before committing these packaging files,
stage `flake.nix`, `flake.lock`, and `build/nix/` first: Nix flakes only include
Git-tracked files in the source snapshot.

The package compiles the same standalone executable as `build/binary.sh` and
installs it to `bin/nanosync`. Bun is required at build time, not at runtime.
Only `x86_64-linux` is exposed because the build script targets Bun's Linux
x64 executable. The Nix package invokes the unmodified ELF through Nix's glibc
loader with its library path; non-Nix builds remain unchanged. Bun's compiled
ELF cannot safely be rewritten with `patchelf`, so `bin/nanosync` is a small
launcher and the standalone executable is installed under `libexec/nanosync`.

`bun2nix` generates the checked-in `bun.nix` from `bun.lock`. Its
`fetchBunDeps` fetches dependencies with the lockfile's integrity hashes and
supplies an offline Bun cache in the Nix build. No fake hashes or networked
`bun install` in the sandbox are needed. When updating `bun.lock`, regenerate
the dependency expression from the repository root:

```sh
bunx bun2nix -l bun.lock -c ../../ -o build/nix/bun.nix
```

Review and commit the updated `bun.nix` with the lockfile. When updating Nix
inputs, run `nix flake update` and commit the resulting `flake.lock` as well.
