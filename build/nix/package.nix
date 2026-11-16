{ stdenv, bun2nix }:

stdenv.mkDerivation {
  pname = "nanosync";
  version = "0.1.0-unstable";
  src = ../..;

  nativeBuildInputs = [ bun2nix.hook ];
  bunDeps = bun2nix.fetchBunDeps {
    bunNix = ./bun.nix;
  };
  bunInstallFlags = "--frozen-lockfile --offline --linker=hoisted";
  dontRunLifecycleScripts = true;
  dontUseBunCheck = true;
  # Bun's compiled executable carries an appended payload. Nix's normal ELF
  # fixups/strip would rewrite it into a plain Bun runtime without the CLI.
  dontPatchELF = true;
  dontStrip = true;

  buildPhase = ''
    runHook preBuild
    bash build/binary.sh
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/nanosync "$out/libexec/nanosync"
    install -Dm644 packages/admin-ui/PAPER-UI-NOTICE.md "$out/share/doc/nanosync/PAPER-UI-NOTICE.md"
    mkdir -p "$out/bin"
    # Bun's compiled ELF has no glibc RUNPATH and may request /lib64's loader.
    # Rewriting it with patchelf corrupts its appended payload, so use the
    # store loader directly without modifying the executable.
    cat > "$out/bin/nanosync" <<EOF
#!${stdenv.shell}
exec ${stdenv.cc.libc}/lib/ld-linux-x86-64.so.2 --library-path ${stdenv.cc.libc}/lib "$out/libexec/nanosync" "\$@"
EOF
    chmod 755 "$out/bin/nanosync"
    runHook postInstall
  '';

  meta = {
    description = "Standalone Linux file synchronization CLI and server";
    mainProgram = "nanosync";
    platforms = [ "x86_64-linux" ];
  };
}
