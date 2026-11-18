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
        packages = [ pkgs.bun pkgs.nodejs ];
      };
      packages.${system} = {
        inherit nanosync;
        default = nanosync;
      };
    };
}
