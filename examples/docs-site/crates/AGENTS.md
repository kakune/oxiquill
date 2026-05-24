# AGENTS.md

## Rust Crates

- Crates under this directory are optional reusable helpers for generated documentation cells. Keep them pure Rust and independent of Astro, Preact, browser workers, and generated Wasm glue.
- Each crate should use workspace edition, MSRV, license, dependencies, and lints from `crates/Cargo.toml`. The `examples/docs-site` directory is the Rust helper workspace root; the repository root is not a Rust workspace.
- Workspace lint policy is intentionally strict: no unsafe, no `unwrap`, `expect`, `panic`, `todo`, `dbg`, direct stdout/stderr printing, indexing/slicing, unchecked casts, or unjustified lint suppression.

## Rust Style

- Prefer iterator combinators and standard iterator constructors over `loop` or `for` when they keep the code clear.
- Prefer `match` for enum, state, and multi-branch decisions instead of chained `if`/`else` logic.
- Return `Result` with small error types for fallible helpers. Do not use partial operations or implicit panics.
- Keep public APIs documented, debug-friendly, and stable enough for MDX cell examples.
- Use `#[expect(..., reason = "...")]` for narrow, reviewed lint exceptions such as numerical examples that require floating-point arithmetic.

## Tests

- Add focused unit tests for normal paths, boundary values, and errors.
- Rust assertions must include useful failure messages.
- Validate Rust changes with `pnpm test:rust`, `pnpm lint:rust`, and `pnpm doc:rust`; run `pnpm test:rust:coverage` when behavior changes.
