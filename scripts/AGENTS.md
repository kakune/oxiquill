# AGENTS.md

## Runtime Scripts

- Scripts here will own runtime generation and filesystem side effects after implementation is migrated.
- The skeleton tracks this directory only as a future boundary. Do not add script behavior without a migration task for the corresponding runtime flow.
- Generated paths should remain `src/generated/doc-runtime/**`, `public/pyodide/**`, and `dist/**`.

## JavaScript Style

- This project uses ESM.
- Once scripts are migrated, keep parsing, normalization, planning, and writing concerns separated.
- Prefer deterministic output and clear path-specific errors.

## Tests

- Add Vitest coverage under `tests/unit` with migrated script behavior.
