{
  description = "transistor — publish NYC transit departures to MQTT for a Home Assistant kiosk";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs";

  outputs = { self, nixpkgs }:
    let
      systems = [ "x86_64-linux" "aarch64-linux" ];

      forAllSystems = f:
        nixpkgs.lib.genAttrs systems (system: f (import nixpkgs { inherit system; }));

      nixosModule = import ./nix/module.nix;

      pythonEnv = pkgs: pkgs.python3.withPackages (ps: [
        ps.gtfs-realtime-bindings
        ps.paho-mqtt
        ps.pytest
      ]);
    in
    {
      # Consumed by a host flake, e.g.:
      #   inputs.transistor.url = "github:bcosynot/transistor";
      #   modules = [ transistor.nixosModules.transistor ];
      nixosModules.transistor = nixosModule;
      nixosModules.default = nixosModule;

      packages = forAllSystems (pkgs: rec {
        transistor = pkgs.callPackage ./nix/package.nix { };
        default = transistor;
      });

      # `nix flake check` / CI entry point. Both suites are network-free: the
      # Python tests build synthetic GTFS-RT feeds, the card tests stub the DOM.
      checks = forAllSystems (pkgs: {
        tests = pkgs.runCommand "transistor-tests"
          {
            nativeBuildInputs = [ (pythonEnv pkgs) pkgs.nodejs ];
          }
          ''
            cp -r ${self}/. work
            chmod -R u+w work
            cd work
            export PYTHONPATH=$PWD/src
            pytest -q tests
            node --test tests/card.test.mjs
            touch $out
          '';
      });

      devShells = forAllSystems (pkgs: {
        default = pkgs.mkShell {
          packages = [ (pythonEnv pkgs) ];
          shellHook = ''
            export PYTHONPATH=$PWD/src
            echo "transistor dev shell — try: transistor --once"
          '';
        };
      });
    };
}
