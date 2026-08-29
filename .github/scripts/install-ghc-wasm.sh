#!/usr/bin/env bash

set -euo pipefail

: "${GHC_WASM_ARCHIVE_SHA256:?GHC_WASM_ARCHIVE_SHA256 must be set}"
: "${GHC_WASM_FLAVOUR:?GHC_WASM_FLAVOUR must be set}"
: "${GHC_WASM_REVISION:?GHC_WASM_REVISION must be set}"

if [[ ! "$GHC_WASM_REVISION" =~ ^[0-9a-f]{40}$ ]]; then
  echo "GHC_WASM_REVISION must be a full lowercase commit SHA" >&2
  exit 1
fi

if [[ ! "$GHC_WASM_ARCHIVE_SHA256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "GHC_WASM_ARCHIVE_SHA256 must be a lowercase SHA-256 digest" >&2
  exit 1
fi

prefix="$HOME/.ghc-wasm"
compiler="$prefix/wasm32-wasi-ghc/bin/wasm32-wasi-ghc"

if [[ ! -x "$compiler" ]]; then
  if [[ "${RUNNER_OS:-}" == "Linux" ]]; then
    sudo apt-get update
    sudo apt-get install -y jq unzip zstd
  elif [[ "${RUNNER_OS:-}" == "macOS" ]]; then
    brew list jq >/dev/null 2>&1 || brew install jq
    brew list zstd >/dev/null 2>&1 || brew install zstd
  else
    echo "Unsupported runner OS for ghc-wasm: ${RUNNER_OS:-unknown}" >&2
    exit 1
  fi

  temporary_directory="$(mktemp -d)"
  trap 'rm -rf "$temporary_directory"' EXIT
  archive="$temporary_directory/ghc-wasm-meta.tar.gz"
  source_directory="$temporary_directory/source"
  mkdir "$source_directory"

  curl --fail --location --proto '=https' --retry 5 --show-error --silent --tlsv1.2 \
    "https://gitlab.haskell.org/haskell-wasm/ghc-wasm-meta/-/archive/$GHC_WASM_REVISION/ghc-wasm-meta-$GHC_WASM_REVISION.tar.gz" \
    --output "$archive"

  if command -v sha256sum >/dev/null 2>&1; then
    actual_sha256="$(sha256sum "$archive" | awk '{print $1}')"
  else
    actual_sha256="$(shasum -a 256 "$archive" | awk '{print $1}')"
  fi

  if [[ "$actual_sha256" != "$GHC_WASM_ARCHIVE_SHA256" ]]; then
    echo "ghc-wasm archive SHA-256 mismatch" >&2
    echo "Expected: $GHC_WASM_ARCHIVE_SHA256" >&2
    echo "Actual:   $actual_sha256" >&2
    exit 1
  fi

  tar xzf "$archive" -C "$source_directory" --strip-components=1
  (
    cd "$source_directory"
    FLAVOUR="$GHC_WASM_FLAVOUR" PREFIX="$prefix" ./setup.sh
  )
fi

if [[ -n "${GITHUB_ENV:-}" ]]; then
  echo "OXIQUILL_HASKELL_GHC=$compiler" >> "$GITHUB_ENV"
fi
"$compiler" --version
