#!/usr/bin/env bash
set -euo pipefail

archive="$RUNNER_TEMP/binaryen-version_117-x86_64-linux.tar.gz"
curl --fail --location --retry 3 https://github.com/WebAssembly/binaryen/releases/download/version_117/binaryen-version_117-x86_64-linux.tar.gz --output "$archive"
echo "3dc677006555b355ea2da5e82602065a161d5e83eaefd3f759afa00b96e83212  $archive" | sha256sum --check --strict
mkdir -p "$RUNNER_TEMP/binaryen"
tar -xzf "$archive" --strip-components=1 -C "$RUNNER_TEMP/binaryen"
test "$("$RUNNER_TEMP/binaryen/bin/wasm-opt" --version)" = "wasm-opt version 117 (version_117)"
echo "$RUNNER_TEMP/binaryen/bin" >> "$GITHUB_PATH"
