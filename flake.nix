{
  description = "Agent Mom: a lean Pi-backed local web shell";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-25.11";
  };

  outputs = { self, nixpkgs, ... }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system:
          f { pkgs = nixpkgs.legacyPackages.${system}; inherit system; });
    in {
      devShells = forAllSystems ({ pkgs, ... }: {
        default = pkgs.mkShell {
          packages = with pkgs; [
            git
            just
            nodejs_24
            podman
          ];

          shellHook = ''
            export IN_NIX_SHELL=1
          '';
        };
      });

      packages = forAllSystems ({ pkgs, system, ... }:
        let
          smolvmReleaseSystems = [ "aarch64-linux" "x86_64-linux" ];
          agentmom = pkgs.callPackage ./nix/package.nix { };
        in
        {
          inherit agentmom;
          default = agentmom;
        } // nixpkgs.lib.optionalAttrs (builtins.elem system smolvmReleaseSystems) {
          smolvm = pkgs.callPackage ./nix/smolvm-release.nix { };
        });

      apps = forAllSystems ({ pkgs, system, ... }: {
        default = {
          type = "app";
          program = "${self.packages.${system}.agentmom}/bin/agentmom";
        };
      });

      nixosModules.default = self.nixosModules.agentmom;
      nixosModules.agentmom = import ./nix/module.nix { inherit self; };
    };
}
