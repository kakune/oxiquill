# Oxiquill

This repository is currently a project skeleton. It preserves the intended documentation-site layout and tooling boundaries, but it does not include the source runtime, scripts, tests, sample notes, or helper implementation code yet.

## Intended Shape

- Static Astro/Starlight documentation site
- Preact runtime component area for interactive documentation cells
- TypeScript runtime library area for generated-cell loading and browser workers
- Rust workspace for helper crates used by documentation examples
- Unit and end-to-end test directories prepared for later migration

## Skeleton Policy

The current repository tracks structure and configuration only. Generated output and local build artifacts are ignored:

- `src/generated`
- `public/pyodide`
- `dist`
- `coverage`
- `test-results`
- `target`

Build, test, lint, and runtime commands should be treated as pending until the real implementation is migrated.
