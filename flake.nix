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
      desktopBun = pkgs.bun.overrideAttrs (_: {
        version = "1.4.4";
        src = pkgs.fetchurl {
          url = "https://github.com/oven-sh/bun/releases/download/bun-v1.4.4/bun-linux-x64.zip";
          sha256 = "bf8ccbfb2b0b80159e0f9a6d15c55317add8077534dbc6130a3edb52fccb395c";
        };
      });
      notifyPython = pkgs.python3.withPackages (python: [ python.pygobject3 ]);
      nanosync = pkgs.callPackage ./build/nix/package.nix {
        bun2nix = bun2nix.packages.${system}.default;
      };
    in {
      devShells.${system}.default = pkgs.mkShell {
        packages = with pkgs; [
          desktopBun nodejs prettier curl gnutar gzip xz git util-linux binutils patchelf pkg-config
          xorg-server
          gtk3 webkitgtk_4_1 libayatana-appindicator librsvg libsecret
          glib dbus xdg-utils systemd libnotify
          (python3.withPackages (python: [ python.dbus-next ]))
        ];
        shellHook = ''
          export HUTCH_HOME="$PWD/.cache/hutch"
          export NANOSYNC_XVFB="${pkgs.xorg-server}/bin/Xvfb"
          export NANOSYNC_DBUS="${pkgs.dbus}/bin/dbus-daemon"
          export NANOSYNC_XDG_OPEN="${pkgs.xdg-utils}/bin/xdg-open"
          export NANOSYNC_NOTIFY_PYTHON="${notifyPython}/bin/python3"
          export NANOSYNC_NOTIFY_TYPELIB="${pkgs.lib.makeSearchPath "lib/girepository-1.0" [ pkgs.libnotify pkgs.gdk-pixbuf pkgs.glib.out ]}"
          export NANOSYNC_LIBSYSTEMD="${pkgs.systemd}/lib/libsystemd.so.0"
          export LD_LIBRARY_PATH="${pkgs.lib.makeLibraryPath (with pkgs; [
            gtk3 webkitgtk_4_1 libayatana-appindicator librsvg libsecret
          ])}''${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
        '';
      };
      packages.${system} = {
        inherit nanosync;
        desktop-bun = desktopBun;
        default = nanosync;
      };
    };
}
