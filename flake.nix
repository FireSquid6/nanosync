{
  description = "Standalone nanosync Linux binary";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    bun2nix = {
      url = "github:nix-community/bun2nix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
  };

  outputs = { nixpkgs, bun2nix, ... }:
    let
      system = "x86_64-linux";
      pkgs = nixpkgs.legacyPackages.${system};
      nanosync = pkgs.callPackage ./build/nix/package.nix {
        bun2nix = bun2nix.packages.${system}.default;
      };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          bun nodejs curl gnutar gzip patchelf pkg-config
          gtk3 webkitgtk_4_1 libayatana-appindicator librsvg libsecret
          glib dbus xdg-utils
        ];
        shellHook = ''
          export HUTCH_HOME="$PWD/.cache/hutch"
          export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [
            gtk3 webkitgtk_4_1 libayatana-appindicator librsvg libsecret
          ])}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        '';
      };
      packages.${system} = {
        inherit nanosync;
        default = nanosync;
      };
    };
}
