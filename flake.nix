{
  description = "Oxiquill development environment";

  nixConfig.http2 = false;

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    fenix = {
      url = "github:nix-community/fenix";
      inputs.nixpkgs.follows = "nixpkgs";
    };
    ghc-wasm-meta.url = "github:haskell-wasm/ghc-wasm-meta";
  };

  outputs =
    {
      self,
      nixpkgs,
      fenix,
      ghc-wasm-meta,
    }:
    let
      systems = [ "x86_64-linux" ];
      forAllSystems = nixpkgs.lib.genAttrs systems;
      mkToolchain =
        system:
        let
          pkgs = import nixpkgs { inherit system; };
          rustToolchain = fenix.packages.${system}.fromToolchainFile {
            file = ./rust-toolchain.toml;
            sha256 = "sha256-gh/xTkxKHL4eiRXzWv8KP7vfjSk61Iq48x47BEDFgfk=";
          };
          nodejs = pkgs.nodejs_24;
          pnpm = pkgs.pnpm_11.overrideAttrs (_oldAttrs: {
            version = "11.2.2";
            src = pkgs.fetchurl {
              url = "https://registry.npmjs.org/pnpm/-/pnpm-11.2.2.tgz";
              hash = "sha256-mcS+gx7SMYKYlRQtlnk9vnWvxTeVkzrtg2bmjczh4bg=";
            };
          });
          haskellGhc = ghc-wasm-meta.packages.${system}."wasm32-wasi-ghc-9_14";
          llvmTools = pkgs.llvmPackages.llvm;
          playwrightBrowsers = pkgs.playwright-driver.browsers;
          nodeExecutablePath = nixpkgs.lib.getExe nodejs;
          haskellCompilerPath = "${haskellGhc}/bin/wasm32-wasi-ghc";
          llvmCovPath = "${llvmTools}/bin/llvm-cov";
          llvmProfdataPath = "${llvmTools}/bin/llvm-profdata";
          packages = [
            nodejs
            pnpm
            rustToolchain
            pkgs.wasm-pack
            pkgs.cargo-llvm-cov
            llvmTools
            haskellGhc
          ];
          cacheHook = ''
            export XDG_CACHE_HOME="$PWD/.cache/xdg"
            export npm_config_cache="$PWD/.cache/npm"
            export pnpm_config_store_dir="$PWD/.cache/pnpm-store"
            export PNPM_HOME="$PWD/.cache/pnpm-home"
            export CARGO_HOME="$PWD/.cache/cargo"
            export WASM_PACK_CACHE="$PWD/.cache/wasm-pack"
            mkdir -p "$XDG_CACHE_HOME" "$npm_config_cache" "$pnpm_config_store_dir" "$PNPM_HOME" "$CARGO_HOME" "$WASM_PACK_CACHE"
            export PATH="$PNPM_HOME:$PATH"
          '';
        in
        {
          inherit
            cacheHook
            haskellCompilerPath
            llvmCovPath
            llvmProfdataPath
            nodeExecutablePath
            packages
            playwrightBrowsers
            ;
        };
    in
    {
      devShells = forAllSystems (
        system:
        let
          toolchain = mkToolchain system;
          pkgs = import nixpkgs { inherit system; };
        in
        {
          default = pkgs.mkShell {
            packages = toolchain.packages;
            OXIQUILL_NODE = toolchain.nodeExecutablePath;
            OXIQUILL_HASKELL_GHC = toolchain.haskellCompilerPath;
            LLVM_COV = toolchain.llvmCovPath;
            LLVM_PROFDATA = toolchain.llvmProfdataPath;
            PLAYWRIGHT_BROWSERS_PATH = toolchain.playwrightBrowsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
            shellHook = toolchain.cacheHook;
          };
        }
      );

      checks = forAllSystems (
        system:
        let
          toolchain = mkToolchain system;
          pkgs = import nixpkgs { inherit system; };
        in
        {
          toolchain = pkgs.runCommand "oxiquill-toolchain-check" {
            nativeBuildInputs = toolchain.packages;
            OXIQUILL_NODE = toolchain.nodeExecutablePath;
            OXIQUILL_HASKELL_GHC = toolchain.haskellCompilerPath;
            LLVM_COV = toolchain.llvmCovPath;
            LLVM_PROFDATA = toolchain.llvmProfdataPath;
            PLAYWRIGHT_BROWSERS_PATH = toolchain.playwrightBrowsers;
            PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = "1";
          } ''
            node_version="$(node --version)"
            node --eval '
              const [major, minor] = process.versions.node.split(".").map(Number);
              if (major !== 24 || minor < 15) {
                console.error("expected Node.js 24.15.0 or newer in the 24.x series, got " + process.version);
                process.exit(1);
              }
            '

            pnpm_version="$(pnpm --version)"
            if [ "$pnpm_version" != "11.2.2" ]; then
              echo "expected pnpm 11.2.2, got $pnpm_version" >&2
              exit 1
            fi

            rustc_version="$(rustc --version)"
            case "$rustc_version" in
              "rustc 1.95.0 "*) ;;
              *) echo "expected rustc 1.95.0, got $rustc_version" >&2; exit 1 ;;
            esac

            cargo llvm-cov --version
            "$LLVM_COV" --version
            "$LLVM_PROFDATA" --version
            wasm-pack --version
            "$OXIQUILL_HASKELL_GHC" --version
            test -d "$PLAYWRIGHT_BROWSERS_PATH"

            mkdir -p "$out"
            {
              echo "$node_version"
              echo "pnpm $pnpm_version"
              echo "$rustc_version"
            } > "$out/toolchain.txt"
          '';
        }
      );
    };
}
