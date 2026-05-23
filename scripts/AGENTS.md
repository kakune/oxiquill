# AGENTS.md

## Runtime Scripts

- Scripts here own runtime generation and filesystem side effects. Keep parsing, normalization, planning, and writing concerns separated.
- Prefer deterministic output: sort generated lists, keep stable fingerprints stable, and avoid environment-sensitive behavior unless it is already part of the script contract.
- Do not write directly to generated paths from new ad hoc scripts. Extend the existing runtime generation flow instead.

## JavaScript Style

- This project is ESM. Use existing Node APIs and local helpers before adding dependencies.
- Keep functions small and data-oriented. Prefer `map`, `filter`, `flatMap`, `Object.entries`, and `Array.from` over mutable loops when clarity is preserved.
- Throw errors with page, cell id, field, or path context so authoring failures are actionable.
- Avoid hidden global state. Pass filesystem and process interfaces through existing dependency-injection patterns used by the tests.

## Tests

- Add or update Vitest coverage in `tests/unit` for new branches and error cases.
- For runtime generation changes, run `pnpm test:unit` and `pnpm check`; run `pnpm test:unit:coverage` when covered branches change.
- For Wasm or generated Rust output changes, also run `pnpm wasm:dev` and `pnpm test:wasm`.
