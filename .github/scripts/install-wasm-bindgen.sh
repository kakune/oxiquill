#!/usr/bin/env bash
set -euo pipefail

# The CLI is a host build tool. Its source-build MSRV can exceed the generated crate's MSRV.
repository_root=$(git rev-parse --show-toplevel)
version=$(node --input-type=module -e 'import { readFileSync } from "node:fs"; console.log(JSON.parse(readFileSync(process.argv[1], "utf8")).rust.dependencies["wasm-bindgen"]);' "$repository_root/packages/oxiquill/src/generator/runtime-data/runtime-inputs.json")
export WASM_BINDGEN_ASSET="wasm-bindgen-$version-x86_64-unknown-linux-musl.tar.gz"
digest=$(gh api "repos/wasm-bindgen/wasm-bindgen/releases/tags/$version" --jq '.assets[] | select(.name == env.WASM_BINDGEN_ASSET) | .digest')
if [[ ! "$digest" =~ ^sha256:[a-f0-9]{64}$ ]]; then
  echo "Missing upstream SHA-256 digest for $WASM_BINDGEN_ASSET" >&2
  exit 1
fi
gh release download "$version" --repo wasm-bindgen/wasm-bindgen --pattern "$WASM_BINDGEN_ASSET" --dir "$RUNNER_TEMP"
echo "${digest#sha256:}  $RUNNER_TEMP/$WASM_BINDGEN_ASSET" | sha256sum --check --strict
mkdir -p "$RUNNER_TEMP/wasm-bindgen"
tar -xzf "$RUNNER_TEMP/$WASM_BINDGEN_ASSET" --strip-components=1 -C "$RUNNER_TEMP/wasm-bindgen"
test "$("$RUNNER_TEMP/wasm-bindgen/wasm-bindgen" --version)" = "wasm-bindgen $version"
echo "$RUNNER_TEMP/wasm-bindgen" >> "$GITHUB_PATH"
