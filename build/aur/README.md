# AUR packaging (not yet published)

`PKGBUILD` is for a future `nanosync-git` AUR package. It fetches the current
Git history, derives `pkgver` from the commit count and short hash, installs
dependencies using the committed Bun lockfile, and compiles the Linux x86-64
standalone executable. The resulting package installs `/usr/bin/nanosync`;
Bun is needed to build it, not to run it. This is separate from any per-user
installer, which may target `~/.local/bin`.

To test on an Arch Linux x86-64 machine with `base-devel`, `git`, and `bun`
available, copy `PKGBUILD` to an empty directory and run `makepkg -si` there.
`makepkg` downloads the Git source and Bun dependencies, so the build needs
network access. `makepkg` computes the actual VCS version; the checked-in
version reflects commit `4f59890` and must be refreshed against public upstream
before publishing. Run `makepkg --printsrcinfo > .SRCINFO` in that directory
after fetching the source to regenerate the AUR metadata.

To publish **once the upstream commits are available publicly**, register
`nanosync-git` on the AUR and push `PKGBUILD` and the regenerated `.SRCINFO` to
its AUR Git repository. Update `.SRCINFO` with `makepkg --printsrcinfo` whenever
the PKGBUILD metadata changes (and before each AUR push); ordinary upstream
commits alone do not require an AUR push. No AUR package or release is claimed
to exist yet.
