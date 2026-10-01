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

  buildPhase = ''
    runHook preBuild
    bash build/binary.sh
    runHook postBuild
  '';

  installPhase = ''
    runHook preInstall
    install -Dm755 dist/nanosync "$out/bin/nanosync"
    runHook postInstall
  '';

  meta = {
    description = "Standalone Linux file synchronization CLI and server";
    mainProgram = "nanosync";
    platforms = [ "x86_64-linux" ];
  };
}
