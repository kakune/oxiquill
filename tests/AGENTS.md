# AGENTS.md

## Tests

- Unit tests belong under `tests/unit`; browser-facing scenarios belong under `tests/e2e`.
- Keep tests focused on behavior, not implementation details. Prefer generated runtime fixtures through the existing generation scripts over hand-editing generated output.
- Use Vitest for script, runtime, and Preact component behavior. Use Playwright for built-site behavior such as interactive cells, rendered diagrams, media, and localization.

## Validation

- Run focused tests for the code you touch. Use `pnpm test:unit` for runtime/script/component changes and `pnpm test:e2e` for browser-facing workflows.
- Run `pnpm test` before considering broad migration or release work complete when practical.
