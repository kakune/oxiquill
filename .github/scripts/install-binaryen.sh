#!/usr/bin/env bash
set -euo pipefail

asset=binaryen-version_117-x86_64-linux.tar.gz
archive="$RUNNER_TEMP/$asset"
# The release API keeps serving assets when the github.com download host is degraded.
gh release download version_117 --repo WebAssembly/binaryen --pattern "$asset" --dir "$RUNNER_TEMP"
echo "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212  $archive" | sha256sum --check --strict
mkdir -p "$RUNNER_TEMP/binaryen"
tar -xzf "$archive" --strip-components=1 -C "$RUNNER_TEMP/binaryen"
test "$("$RUNNER_TEMP/binaryen/bin/wasm-opt" --version)" = "wasm-opt version 117 (version_117)"
echo "$RUNNER_TEMP/binaryen/bin" >> "$GITHUB_PATH"
