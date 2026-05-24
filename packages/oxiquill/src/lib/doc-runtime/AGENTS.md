# AGENTS.md

## Doc Runtime Code

- This subtree contains browser-facing runtime code, workers, manifest handling, and remark plugins. Keep it separate from consumer generated output under `.oxiquill/**`.
- Prefer explicit message shapes, small pure helpers, and narrowly scoped worker state.
- Preserve HMR and subscription behavior in `manifest.ts` when changing generated-cell loading.
- Runtime errors should be visible and specific enough for authors to fix the cell or metadata.

## TypeScript and Preact Style

- Follow strict TypeScript. Avoid `any`; model data with the existing manifest and runtime types.
- Prefer functional data transformations over mutation-heavy code when it stays readable.
- Keep Preact components focused on rendering and interaction state. Move reusable decisions into pure helpers that are easy to test.
- Do not add UI explanation text unless the user-facing docs need it; runtime controls should stay compact and predictable.

## Tests

- Unit tests live under `tests/unit`, not beside source.
- Cover loading states, error states, worker reset behavior, generated manifest updates, and plugin transforms when touched.
- Run `pnpm test:unit` and `pnpm check`; add `pnpm test:e2e` for browser-visible behavior.
