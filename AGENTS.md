# AGENTS.md

## Scope

- This file applies to the whole repository. More specific `AGENTS.md` files in subdirectories add guidance for their subtree.

## Project Shape

- Oxiquill is being migrated from the `../note-test` documentation stack.
- This repository currently contains a structure-first skeleton only. Do not add implementation code unless the migration task explicitly asks for it.
- The intended stack is an Astro/Starlight documentation site with Preact runtime components, strict TypeScript, and Rust helper crates for generated interactive cells.
- Use `pnpm` for Node commands. The Rust toolchain is pinned in `rust-toolchain.toml`; do not change it casually.

## Generated Files

- Do not edit generated output directly: `src/generated/doc-runtime/**`, `public/pyodide/**`, `dist/**`, `coverage/**`, `test-results/**`, or `target/**`.
- Add generation scripts and generated artifacts only when the real runtime implementation is migrated.

## Coding Standards

- Keep skeleton changes structural. Placeholder files should remain empty unless a future task migrates real behavior.
- Preserve strict linting once implementation code is introduced.
- Avoid broad rewrites while making focused migration changes. Match the established project shape before introducing new layers.

## Validation

- During the skeleton phase, prefer structural checks such as `git status --short` and file layout inspection.
- Run build, test, and lint commands only after the corresponding source, scripts, and test implementations have been migrated.
