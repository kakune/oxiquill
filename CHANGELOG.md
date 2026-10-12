# Changelog

All notable changes to Oxiquill are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Signed stack groups for bar and area charts, horizontal bars, bounded axis annotations, and fixed or centered diverging heatmap color scales.
- Error bars, interval bands, five-number box plots, area-scaled bubbles, and nonuniform grid fields through the existing Rust, Python, and Haskell chart APIs. New charts support accessible summaries, original-data tables, and PNG/SVG downloads.
- Input resets, explicit opt-in input sharing links, and local Python source editing with manual execution.
- CSV downloads for all retrieved table rows, PNG/SVG chart downloads, and authored Canvas/SVG renderer selection.
- Keyboard chart series controls, zoom reset, and bounded, paginated tables of original chart data.

- Python `display_chart` for declarative interactive charts and bounded `display_line` for pandas columns, with explicit missing-value and timezone diagnostics.

- Generic Rust `emit_chart!` with artifact metadata and `emit_area_chart!`, sharing bounded chart output helpers.

- Stable chart series IDs and per-series colors, line patterns, steps, smoothing, and symbols; same-named legend entries remain independently selectable.

- Numeric chart formats for significant digits, fixed decimals, units, and SI prefixes, shared by axes, tooltips, summaries, and heatmap scales.

- Authored chart axis bounds and zero inclusion, with Rust chart options and a fixed-range logistic map example.

- Chart height control through `spec.style.height` (200–800 pixels), with automatic heatmap sizing.
- Real ECharts SVG layout checks and Chromium chart galleries for visual review in CI.

### Changed

- **Display changes:** tables preserve all digits of safe integers, use scientific notation for very large or small other values, normalize negative zero, and choose grouping consistently per column. Numeric cells expose original values in their title; CSV values remain unchanged.

- **Breaking API migration (next minor):** cell results now require `outputs`; top-level `stdout/stderr/value/plots`, legacy result conversion, and the `PlotSpec/LinePlotSpec` public types are removed. Regenerate runtime artifacts after upgrading and update explicit Rust `CellOutput` early returns to contain artifacts. JSON artifact values and input values are unchanged. See the English and Japanese rich-output migration guide.

- **Display migration:** histograms render numeric intervals with their actual widths and gaps; legacy category x axes normalize to value. Density mode makes area represent count. Overlapping bins are rejected.

- **Display changes:** chart titles appear above the plot, legends scroll on one line, and responsive axis labels and heatmap color scales avoid overlap. Axis numbers share consistent formatting and chart palettes now have tested contrast and color-vision distances, with line patterns and scatter symbols on color reuse.
- **Migration:** bar and histogram charts reject time-valued y axes. Use a value axis for amounts or line/scatter for timestamps. Time-axis ticks, tooltips, and summaries now display UTC instead of the reader's local timezone.
- **Display migration:** matplotlib uses the chart palette, browser-rendered SVG text, light grids, and white paper by default. Override rcParams or call `matplotlib.rcdefaults()` inside the cell to restore upstream defaults. Oversized SVG figures fall back to 150 DPI PNG with a diagnostic.
- Oxiquill now requires Astro 7.3.8 and Starlight 0.42.6; the starter, examples, and installation commands use these versions. Starlight 0.42 supports Chromium 116, Safari 17.0, and Firefox 125 or newer, and its mobile sidebar is now a popover.
- Math renders with Oxiquill's pinned KaTeX 0.19.0 instead of rehype-katex. KaTeX 0.18 and later prefix internal class names such as `katex-sizing`, so custom CSS targeting KaTeX internals may need updates.
- The generated starter pins pnpm 12.10.1. Contributor and CI tooling now uses Node.js 24.21.0, pnpm 12.10.1, npm 12.2.0 for publishing, and Rust 1.99.0; the published package and generated starter continue to support Node.js 24.0.0 or newer.
- Generated Rust cells use wasm-bindgen 0.2.129, serde 1.0.229, and serde_json 1.0.151, and the Python runtime uses Pyodide 314.0.7.
- Updated all other runtime and development dependencies, pinned GitHub Actions, and ghc-wasm to their latest releases. Mermaid stays on 11.17.2 because Mermaid 12 bundles a 1.46 MB ELK layout chunk that exceeds the browser chunk budget.

### Deprecated

- New examples use explicit coordinates and `emit_line_chart!`; `emit_line_plot!` remains available for compatibility.

### Removed

- The unused `doc-rust` legacy `PlotSpec`, `LinePlot`, and `line_plot` helpers; convert series coordinates explicitly and use `emit_line_chart!`.

- Dependabot version and security update pull requests; dependency updates are made manually and Dependabot alerts still gate releases.

### Fixed

- SI chart tick labels no longer expose floating-point division artifacts.
- Histogram count and density labels now follow the page language in axes, tooltips, and summaries.

- Theme changes preserve the chart instance, zoom, legend selection, and heatmap color-range selection.

- Zero baselines for value-axis bars, histograms, and areas; isolated line/area points; negative bar rounding; and heatmap cell boundaries.
- Matplotlib image alternatives now describe figure titles and axis labels.
- Long chart captions stay within narrow figures in WebKit. UTC ticks retain calendar context and zoom precision; tooltips retain color markers and display missing values as `-`.
- Chart resizing updates layout without resending series data; isolated-point detection searches cached coordinate indexes. Zero lines survive legend selection.
- Matplotlib styles reset between cells, and browser-rendered SVG text no longer emits missing-glyph warnings during export.
- The saved desktop sidebar state now applies before the first paint.
- The Nix development shell uses the Rust toolchain's LLVM tools so coverage profiles match rustc.

### Security

- The production dependency audit reports no known vulnerabilities, including fixes for undici, devalue, fast-uri, KaTeX, postcss-selector-parser, smol-toml, and sharp advisories.

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
- Reactive and autorun cell execution after out-of-order source and runtime-version updates during development.
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
