# AGENTS.md

## Doc Runtime Code

- This subtree is reserved for browser-facing runtime code, workers, manifest handling, and remark plugins.
- The skeleton intentionally contains no runtime implementation. Do not add partial runtime code without a migration task for that subsystem.
- Keep this subtree separate from generated output under `src/generated/doc-runtime/**`.

## TypeScript and Preact Style

- Once runtime code is migrated, follow strict TypeScript and model message shapes explicitly.
- Keep Preact components focused on rendering and interaction state.
- Runtime errors should be visible and specific enough for authors to fix cell metadata or code.

## Tests

- Unit tests for runtime behavior belong under `tests/unit`, not beside source.
- Add tests with the implementation they cover.
