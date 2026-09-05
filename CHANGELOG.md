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

## [0.3.1] - 2026-09-05

### Added

- Optional `python.preload` preparation with localized progress states and shared runtime initialization.
- Development HMR, generated Rust execution, documentation, and browser bundle contract checks in CI.

### Changed

- Contributor and CI tooling now requires Node.js 24.15.0 or newer; the published package and generated starter continue to support Node.js 24.0.0 or newer.
- Successful cell output and compatible chart instances persist through reactive reruns, failures, cancellation, and invalid inputs, with theme-aware chart styles and reduced-motion support.
- Python startup overlaps declared package downloads with Pyodide initialization and loads optional display helpers on demand.
- Updated development test tools and GitHub Actions dependencies.

### Fixed

- Runtime watcher startup ordering, pending rebuilds after synchronization failures, manifest refresh coordination, initialization recovery, and helper-crate input tracking.
- Error normalization, numeric input validation, authoring metadata boundaries, public asset paths, collision-free MDX bindings, and multiline Haskell preambles.
- Rust output macro discovery, generated collector isolation, and empty `println!` output handling.
- MDX math discovery, production Pagefind search, KaTeX script sizing, and categorical heatmap validation and rendering.
- Toolchain version checks for fast-exiting processes.

## [0.3.0] - 2026-08-30

### Added

- A compiled ESM package with declarations, an `oxiquill init` starter, strict project configuration, and npm and pnpm consumer validation.
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
- Early desktop table-of-contents state restoration without browser reference errors.
- Mermaid Flowchart and Gantt hydration in pnpm consumer development servers by routing Mermaid through Vite dependency optimization ([#100](https://github.com/kakune/oxiquill/issues/100)).
- Production dependency advisories present in the v0.2.0 dependency graph.

### Security

- Added private vulnerability reporting, documented the browser trust boundary, isolated untrusted HTML, and constrained rich-output resource use.
- Added immutable release identity, checksum, provenance, blocker, dependency-audit, and long-lived npm credential controls.

## [0.2.0] - 2026-05-24

This release predates the maintained changelog. See the [v0.2.0 GitHub Release](https://github.com/kakune/oxiquill/releases/tag/v0.2.0) and tagged source for its complete contents.

[Unreleased]: https://github.com/kakune/oxiquill/compare/v0.3.1...HEAD
[0.3.1]: https://github.com/kakune/oxiquill/releases/tag/v0.3.1
[0.3.0]: https://github.com/kakune/oxiquill/releases/tag/v0.3.0
[0.2.0]: https://github.com/kakune/oxiquill/releases/tag/v0.2.0
