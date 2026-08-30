# Changelog

All notable changes to Oxiquill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Nothing yet.

### Changed

- Nothing yet.

### Deprecated

- Nothing yet.

### Removed

- Nothing yet.

### Fixed

- Nothing yet.

### Security

- Nothing yet.

## [0.3.0] - 2026-08-30

### Added

- A compiled ESM package with declarations, an `oxiquill init` starter, strict project configuration, and complete npm and pnpm consumer validation.
- Reproducible Rust, Python, and Haskell runtime generation with pinned inputs, toolchain preflight checks, cache validation, and generated-cell smoke tests.
- English and Japanese references for installation, configuration, CLI usage, interactive metadata, rich outputs, runtime downloads, security, troubleshooting, and releases.
- Release-grade linting, coverage, cross-platform compatibility, browser, package, dependency-audit, and staged npm publication gates.

### Changed

- Interactive cells now share one validated authoring parser, isolate page manifests and worker failures, and apply deterministic button, reactive, and autorun scheduling.
- Browser runtimes and optional renderers load on demand, generated output is published atomically, and production bundle sizes are enforced.
- Rich output, charts, tables, Mermaid diagrams, controls, and runtime status messages provide bounded rendering and localized accessibility behavior.

### Deprecated

- Nothing yet.

### Removed

- The legacy hidden interactive-cell run mode and the previous development-branch release workflow.

### Fixed

- Downstream Preact and SSR dependency resolution, custom consumer paths, runtime cleanup, Haskell execution, and Pyodide package availability.
- Production dependency advisories present in the v0.2.0 dependency graph.

### Security

- Added private vulnerability reporting, documented the browser trust boundary, isolated untrusted HTML, and constrained rich-output resource use.
- Added immutable release identity, checksum, provenance, blocker, dependency-audit, and long-lived npm credential controls.

## [0.2.0] - 2026-05-24

This release predates the maintained changelog. See the [v0.2.0 GitHub Release](https://github.com/kakune/oxiquill/releases/tag/v0.2.0) and tagged source for its complete contents.

[Unreleased]: https://github.com/kakune/oxiquill/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/kakune/oxiquill/releases/tag/v0.3.0
[0.2.0]: https://github.com/kakune/oxiquill/releases/tag/v0.2.0
