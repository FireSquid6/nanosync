# Nix package

On Linux x86-64 with Nix flakes enabled, from the repository root:

```sh
nix build .#nanosync
./result/bin/nanosync --help
nix profile install .#nanosync
```

If building from a fresh Git checkout before committing these packaging files,
stage `flake.nix` and `build/nix/` first: Nix flakes only include Git-tracked
files in the source snapshot.

The package compiles the same standalone executable as `build/binary.sh` and
installs it to `bin/nanosync`. Bun is required at build time, not at runtime.
Only `x86_64-linux` is exposed because the build script targets Bun's Linux
x64 executable. The result still uses standard system libraries.

`bun2nix` generates the checked-in `bun.nix` from `bun.lock`. Its
`fetchBunDeps` fetches dependencies with the lockfile's integrity hashes and
supplies an offline Bun cache in the Nix build. No fake hashes or networked
`bun install` in the sandbox are needed. When updating `bun.lock`, regenerate
the dependency expression from the repository root:

```sh
bunx bun2nix -l bun.lock -c ../../ -o build/nix/bun.nix
```

Review and commit the updated `bun.nix` with the lockfile. On a machine with
Nix, run `nix flake lock` and commit the resulting `flake.lock` to pin the
Nixpkgs and bun2nix inputs as well. This repository currently has no
`flake.lock` because Nix was not available to generate or test one here;
until it is committed, flake input revisions may change between builds.
