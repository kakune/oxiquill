# Contributing to Oxiquill

Contributions are welcome through focused pull requests against `main`. Create a topic branch, follow the validation guidance in `AGENTS.md`, and keep generated output out of commits. Pull requests are squash-merged after the required checks pass and review conversations are resolved.

Run `pnpm lint` and the focused tests for your change before pushing. Broad changes should pass `pnpm test`, which includes coverage, generated runtime, package consumer, static build, and Chromium/Firefox/WebKit checks. Package changes must pass packed installation with both npm and pnpm.

## Dependency policy

The published package declares Astro (`^7.3.8`) and Starlight (`~0.42.6`) as consumer-owned peers. Starlight's 0.x minor releases can break its component API. Oxiquill loads Vite from Astro's dependency context; consumers do not need a separate Vite dependency.

Internal dependencies use caret ranges from tested lower bounds. Mermaid stays on a tilde range because its next major exceeds the browser chunk budget; the 0.x WASI shim also uses a tilde range. Pyodide stays exact because its runtime assets, package lock, and notices must agree. KaTeX stays exact so rendered markup and CSS use the same release. The starter deliberately pins its framework and package-manager versions within the supported ranges.

The committed lockfile and exact development framework versions keep repository installs reproducible. Repository overrides fix the dogfood dependency graph; they do not propagate to consumers. Test the packed package in isolated npm and pnpm projects, without workspace overrides. Lowest-version compatibility is required in CI, including Node 24.0.0; newest allowed versions run in a separate compatibility canary. License fallbacks require a reviewed version range and an identical SPDX declaration; failures must be investigated rather than ignored.

## License

Unless you explicitly state otherwise, any contribution intentionally submitted for inclusion in Oxiquill by you, as defined in the Apache License, Version 2.0, is licensed under both the MIT License and the Apache License, Version 2.0, without any additional terms or conditions.
