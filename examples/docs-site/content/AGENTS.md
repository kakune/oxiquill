# AGENTS.md

## MDX Authoring

- This directory contains Starlight docs and examples. Keep pages clear, direct, and useful to readers; avoid layout or runtime code in MDX unless the existing docs already use that pattern.
- Interactive Rust and Python cells are fenced code blocks with YAML metadata in leading directive comments.
- Every interactive cell needs a page-local unique `id`. Rust cells use `//|` or `///|`; Python cells use `#|`.
- Rust cells use `crates: [...]`; Python cells use `packages: [...]`. Do not mix them.
- English pages live in `content/docs`; Japanese translations live in `content/docs/ja` with the same slug.
- Public images, PDFs, and similar unprocessed media belong in `public/media` and should be referenced from MDX with `/media/...` URLs.

## Rust Examples

- Example Rust should model the same standards as crate code: prefer iterators over `loop` or `for` when clear, prefer `match` for multi-branch decisions, and avoid `unwrap`, `expect`, and panic-driven examples.
- Keep cell inputs and output stable enough for tests and screenshots.
- Crate names in `crates: [...]` must match helper crate Cargo package names under `crates/`. Use `crates: []` when a Rust cell does not need helper crates.

## Validation

- For docs-only prose changes, `pnpm check` is usually enough.
- For interactive cell metadata or code changes, run `pnpm wasm:dev`; add `pnpm test:wasm` for Rust cell behavior and `pnpm test:e2e` for browser-visible examples.
