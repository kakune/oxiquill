# Oxiquill

A static documentation workspace for MDX notes that combine Rust, Python, math, Mermaid diagrams, and media files. It is built on Astro Starlight with Preact runtime components for executable cells.

English is the root documentation language. Japanese translations live under `/ja/`; see [README.ja.md](./README.ja.md).

This repository is responsible for producing the static output in `dist/`. Hosting, TLS, domains, and reverse proxies are handled outside this project.

## Features

- Rust cells compiled to WebAssembly at build time and run in the browser
- Python cells executed in a Pyodide worker
- Shared rich output artifacts for text, JSON, tables, charts, images, and sandboxed HTML
- Python rich display support for pandas tables, matplotlib figures, and common MIME bundles
- Rust output macros for tables, multiple chart types, JSON, SVG/PNG images, and sandboxed HTML
- Inline and block math rendered with KaTeX
- Mermaid flowcharts, sequence diagrams, and state diagrams
- PNG, JPEG, PDF, and similar files served from `public/media`
- English root docs with Japanese translations under `src/content/docs/ja`
- Rust, TypeScript, Preact, and generated-runtime tests with strict coverage gates

## Requirements

- Node.js and `pnpm`
- Rust toolchain `1.95.0`
- `wasm-pack`
- `cargo-llvm-cov`

The Rust toolchain and Wasm target are pinned by `rust-toolchain.toml`.

## Setup

```sh
pnpm install
```

Start the development server:

```sh
pnpm dev
```

`pnpm dev` generates the executable-cell runtime on startup, then watches MDX and optional Rust helper sources. Prose, normal code, math, Mermaid, and media changes use Astro HMR. Python cell changes update the manifest. Rust cells and `crates/*` changes rebuild Wasm.

To run the runtime watcher and Astro separately:

```sh
pnpm dev:runtime
pnpm dev:astro
```

Build the static site:

```sh
pnpm build
```

Preview the built site:

```sh
pnpm preview
```

## Authoring

Add English pages under `src/content/docs/**/*.mdx`. Add Japanese translations with the same slug under `src/content/docs/ja/**/*.mdx`. The repository root is not a Rust workspace. Optional reusable Rust helper crates belong in `crates/*` and can be referenced from cells with `crates: [doc-rust]`. Rust cells that do not need helpers should use `crates: []`.

Rust cell example:

````md
```rust
//| id: sample-rust
//| title: Rust calculation
//| run: button
//| crates: [doc-rust]
let next = doc_rust::logistic_step(3.2, 0.2);
println!("next = {next:.6}");
```
````

Python cell example:

````md
```python
#| id: sample-python
#| title: Python calculation
#| run: reactive
#| inputs:
#|   scale: { type: number, label: scale, min: 1, max: 10, step: 1, value: 2 }
print(scale * 10)
```
````

Media example:

```md
![PNG sample](/media/examples/sample.png)

<iframe class="media-frame" src="/media/examples/sample.pdf" title="Sample PDF"></iframe>
```

Put public media files in `public/media`. They are served as-is and can be referenced from MDX with `/media/...` URLs.

## Generated Files

`pnpm build` and `pnpm test` run `scripts/generate-doc-runtime.mjs`. This extracts Rust/Python cells from MDX and writes:

- `src/generated/doc-runtime`
- `public/pyodide`
- `dist`

These paths are generated output. Do not edit them directly.

## Tests and Coverage

Run the full validation suite:

```sh
pnpm test
```

Useful focused commands:

```sh
pnpm test:rust
pnpm test:rust:coverage
pnpm test:unit
pnpm test:unit:coverage
pnpm test:wasm
pnpm test:e2e
pnpm lint:rust
pnpm check
```

`test:rust:coverage` requires 100% line/function/region coverage for the optional helper-crate workspace under `crates/` through `cargo-llvm-cov`. If no helper crates exist, Rust helper commands skip cleanly. `test:unit:coverage` uses Vitest V8 coverage for handwritten TypeScript, Preact, and Node runtime code, excluding generated output.

## Troubleshooting

- If a Rust cell helper crate cannot be found, match the cell `crates` value to the `package.name` in `crates/*/Cargo.toml`.
- If a Python cell does not start, confirm that `public/pyodide` exists and run `pnpm wasm:dev` or `pnpm build`.
- If a Mermaid diagram does not render, run `pnpm build` to catch MDX syntax errors and confirm the code block language is `mermaid`.
- If a media file does not load, confirm that it is under `public/media` and referenced with a `/media/...` URL.
- If coverage fails, add focused tests for the uncovered handwritten source rather than editing generated files.
