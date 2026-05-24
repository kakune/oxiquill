# AGENTS.md

## Scope

- This file applies to the whole repository. More specific `AGENTS.md` files in subdirectories add guidance for their subtree.

## Branch Strategy

- Do development work on topic branches such as `feat/...`, `fix/...`, `chore/...`, or `docs/...`.
- Submit topic branch changes to `develop` by pull request. Do not push directly to `develop` or `main`.
- Keep commits small and separated by logical meaning.
- Pull requests to `main` must come only from release branches, for example `release/v0.1.1`.
- After a release branch is merged into `main`, merge that same release branch into `develop` so `develop` stays in sync.
- Use squash merge when merging into `develop`.
- Use merge commits when merging into `main`.
- Branch rules prohibit all other merge methods.

## Project Shape

- Oxiquill is a pnpm workspace with a reusable Astro/Starlight package in `packages/oxiquill` and a dogfood documentation site in `examples/docs-site`.
- The reusable package owns the CLI, Astro integration, Preact runtime components, styles, and runtime generators. The dogfood site owns MDX pages, public media, and optional Rust helper crates under `examples/docs-site/crates/`.
- The repository root is not a Rust workspace.
- Use `pnpm` for Node commands. The Rust toolchain is pinned in `rust-toolchain.toml`; do not change it casually.
- Prefer the existing simple structure over new framework layers. Add abstractions only when they remove real duplication or clarify a shared boundary.

## Generated Files

- Do not edit generated output directly: `.oxiquill/**`, `public/oxiquill/**`, `examples/docs-site/.oxiquill/**`, `examples/docs-site/public/oxiquill/**`, `dist/**`, `examples/docs-site/dist/**`, `coverage/**`, `test-results/**`, or `target/**`.
- Regenerate runtime artifacts with the existing CLI-backed scripts: `pnpm docgen`, `pnpm wasm:dev`, `pnpm wasm:build`, or `pnpm build`, depending on the change.

## Coding Standards

- Keep code small, explicit, and easy to test. Prefer pure functions and data transformations where they fit the problem.
- Preserve strict linting. Treat warnings as work to fix, not noise to suppress.
- Do not silence lints without a narrow reason. Rust lint exceptions should use `#[expect(..., reason = "...")]`.
- Avoid broad rewrites while making focused changes. Match local style before introducing a new pattern.

## Validation

- For frontend/runtime changes, run `pnpm test:unit` and `pnpm check`; use `pnpm test:unit:coverage` for covered logic changes.
- For Rust changes, run `pnpm test:rust`, `pnpm lint:rust`, and `pnpm doc:rust`; use `pnpm test:rust:coverage` when behavior or coverage changes.
- For interactive cell generation or Wasm runtime changes, run `pnpm wasm:dev` and `pnpm test:wasm`; add `pnpm test:e2e` for browser-facing behavior.
- Run `pnpm test` before considering broad changes complete when practical.
