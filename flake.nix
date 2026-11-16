{
  description = "Standalone nanosync Linux binary";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    # The application pin lacks Android CLI Tools 23.0. Keep its package
    # outputs unchanged and pin Android tools to a validated project-local SDK set.
    nixpkgs-android.url = "github:NixOS/nixpkgs/d4f25a3e562008648d45bcf2d70bcc7422cad84e";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, nixpkgs-android, bun2nix, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      androidPkgs = import nixpkgs-android {
        inherit system;
        # Entering this shell explicitly accepts the Android SDK license and
        # permits Google's unfree SDK/emulator binaries (no sdkmanager installs).
        config.allowUnfree = true;
      };
      mkAndroidSdk = options:
        (androidPkgs.androidenv.override { licenseAccepted = true; }).composeAndroidPackages ({
          platformVersions = [ "31" "36" "37.0" ];
          buildToolsVersions = [ "36.0.0" ];
          platformToolsVersion = "37.0.1";
          cmdLineToolsVersion = "23.0";
          toolsVersion = null;
          includeCmake = false;
          includeEmulator = true;
          emulatorVersion = "37.2.13";
          # Explicit images for minimum-version and current-version acceptance.
          includeSystemImages = true;
          systemImageTypes = [ "google_apis" ];
          abiVersions = [ "x86_64" ];
        } // options);
      mkAndroidShell = options:
        let android = mkAndroidSdk options;
        in androidPkgs.mkShell {
          packages = [
            androidPkgs.jdk21
            androidPkgs.gradle_9
            androidPkgs.bun
            android.androidsdk
          ];
          shellHook = ''
            export JAVA_HOME=${androidPkgs.jdk21}
            export ANDROID_HOME=${android.androidsdk}/libexec/android-sdk
            export ANDROID_SDK_ROOT="$ANDROID_HOME"
            export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/23.0/bin:$PATH"
            export GRADLE_OPTS="''${GRADLE_OPTS:+$GRADLE_OPTS }-Dorg.gradle.project.android.aapt2FromMavenOverride=$ANDROID_HOME/build-tools/36.0.0/aapt2"
          '';
        };
      nanosync = pkgs.callPackage ./build/nix/package.nix {
        bun2nix = bun2nix.packages.${system}.default;
      };
    in {
      devShells.${system} = {
        # nix develop .#android --command bash -c 'cd apps/android && gradle assembleDebug'
        # Use avdmanager to create writable AVDs; the SDK itself is immutable.
        android = mkAndroidShell { };
        # Build-only CI shell: no emulator or multi-gigabyte system images.
        android-build = mkAndroidShell {
          platformVersions = [ "37.0" ];
          includeSystemImages = false;
          includeEmulator = false;
        };
      };
      packages.${system} = {
        inherit nanosync;
        default = nanosync;
      };
    };
}
