# AGENTS.md

## Rust Crates

- Crates under this directory are reserved for reusable helpers used by generated documentation cells.
- This skeleton intentionally tracks crate manifests and directory structure only. Do not add Rust implementation files unless the migration task explicitly asks for crate code.
- Each crate should use workspace edition, MSRV, license, dependencies, and lints from the root `Cargo.toml`.
- Keep crates independent of Astro, Preact, browser workers, and generated Wasm glue.

## Rust Style

- Once code is migrated, preserve the strict workspace lint policy.
- Public APIs should be documented, debug-friendly, and stable enough for MDX cell examples.
- Use narrow, justified lint exceptions only when the implementation needs them.

## Tests

- Add focused Rust tests only alongside real crate implementation.
- Validate Rust implementation changes with the Rust commands documented in the root project guidance.
