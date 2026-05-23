# Oxiquill

## English

Oxiquill is a static documentation workspace for technical notes written in MDX. It publishes an Astro Starlight site where one page can combine prose, Rust/Wasm cells, Python/Pyodide cells, math, Mermaid diagrams, images, PDFs, and rich output artifacts.

The repository is responsible for producing the static output in `dist/`. Hosting, TLS, domains, and reverse proxies are handled outside this project.

English is the root documentation language. Japanese pages are published under `/ja/`, and the Japanese README is included later in this file.

### What Oxiquill Provides

- Static Astro/Starlight documentation built from `src/content/docs`.
- Rust code cells compiled to WebAssembly at build time and run in the browser.
- Python code cells run in a browser Pyodide worker.
- Input controls generated from cell metadata, including sliders, numbers, text fields, textareas, checkboxes, selects, and radio groups.
- Rich output rendering for text, JSON, tables, charts, images, and sandboxed HTML.
- Python display helpers for pandas tables, matplotlib figures, MIME bundles, JSON, HTML, images, and generic values.
- Rust `emit_*` macros for text, JSON, tables, line/scatter/bar/histogram/heatmap charts, SVG/PNG images, and sandboxed HTML.
- Inline and block math rendered with KaTeX.
- Mermaid diagrams rendered from fenced code blocks.
- Static media served from `public/media`.
- English and Japanese documentation with matching page structure.
- Rust, TypeScript, Preact, generated-runtime, Wasm, and browser tests.

### Requirements

- Node.js and `pnpm`
- Rust toolchain `1.95.0`
- `wasm-pack`
- `cargo-llvm-cov`

The Rust toolchain and Wasm target are pinned by `rust-toolchain.toml`.

### Setup

Install dependencies:

```sh
pnpm install
```

Start the development server:

```sh
pnpm dev
```

`pnpm dev` generates the executable-cell runtime on startup, then watches MDX files and optional Rust helper sources. Prose, normal code blocks, math, Mermaid, and media changes use Astro HMR. Python cell changes update the generated manifest. Rust cell and `crates/*` changes rebuild the Wasm runtime.

To run the runtime watcher and Astro separately, start these commands in separate terminals:

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

### Documentation Structure

Documentation lives under `src/content/docs`. English pages use the root docs directory, and Japanese translations use the same slug under `src/content/docs/ja`.

The public documentation is organized around these areas:

- Overview: what Oxiquill is and where to start.
- Guides: setup, authoring workflow, templates, and validation.
- Features: interactive cells, rich output, math, diagrams, and media.
- Sample notes: complete examples that show how prose and features fit together.

### Authoring Notes

Add English pages under `src/content/docs/**/*.mdx`. Add Japanese translations with the same route under `src/content/docs/ja/**/*.mdx`. Add new sidebar entries in `astro.config.mjs`.

The repository root is not a Rust workspace. Optional reusable Rust helper crates live under `crates/*`; cells reference helper crates by Cargo package name. Rust cells that do not need helpers should use `crates: []`.

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

### Generated Files

`pnpm build`, `pnpm check`, and test commands run `scripts/generate-doc-runtime.mjs`. This extracts Rust/Python cells from MDX and writes generated runtime files.

Generated output includes:

- `src/generated/doc-runtime`
- `public/pyodide`
- `dist`

Do not edit generated output directly. Regenerate it with existing commands such as `pnpm docgen`, `pnpm wasm:dev`, `pnpm wasm:build`, `pnpm check`, or `pnpm build`.

### Validation

Run the full validation suite when broad changes are complete:

```sh
pnpm test
```

Useful focused commands:

```sh
pnpm check
pnpm test:unit
pnpm test:unit:coverage
pnpm test:rust
pnpm test:rust:coverage
pnpm test:wasm
pnpm test:e2e
pnpm lint:rust
pnpm doc:rust
```

For docs-only prose changes, `pnpm check` is usually enough. For interactive cell metadata, generated Rust/Wasm behavior, or browser-visible examples, also run `pnpm wasm:dev`, `pnpm test:wasm`, and `pnpm test:e2e` as appropriate.

`test:rust:coverage` requires 85% line/function/region coverage for optional helper crates under `crates/` through `cargo-llvm-cov`. If no helper crates exist, Rust helper commands skip cleanly. `test:unit:coverage` uses Vitest V8 coverage for handwritten TypeScript, Preact, and Node runtime code, excluding generated output.

### Troubleshooting

- If a Rust cell helper crate cannot be found, match the cell `crates` value to the `package.name` in `crates/*/Cargo.toml`.
- If a Python cell specifies an unsupported package, use one of the vendored Pyodide packages or add support before documenting it.
- If a Python cell does not start, confirm that `public/pyodide` exists and run `pnpm wasm:dev` or `pnpm build`.
- If a Mermaid diagram does not render, run `pnpm build` to catch MDX syntax errors and confirm the code block language is `mermaid`.
- If a media file does not load, confirm that it is under `public/media` and referenced with a `/media/...` URL.
- If coverage fails, add focused tests for the uncovered handwritten source rather than editing generated files.

## 日本語

Oxiquill は、MDX で書いた技術ノートを静的サイトとして公開するためのドキュメントワークスペースです。Astro Starlight を土台にし、1つのページに本文、Rust/Wasm セル、Python/Pyodide セル、数式、Mermaid 図、画像、PDF、リッチ出力をまとめられます。

このリポジトリの責務は、公開用の静的成果物 `dist/` を作るところまでです。配信、TLS、ドメイン、リバースプロキシはこのプロジェクトの外側で扱います。

ドキュメントのroot言語は英語です。日本語ページは `/ja/` 配下で公開します。

### Oxiquill でできること

- `src/content/docs` から Astro/Starlight の静的ドキュメントを生成する。
- Rust コードセルをビルド時に WebAssembly 化し、ブラウザで実行する。
- Python コードセルをブラウザの Pyodide worker で実行する。
- セル metadata から slider、number、text、textarea、checkbox、select、radio の入力 UI を生成する。
- text、JSON、table、chart、image、sandboxed HTML のリッチ出力を表示する。
- pandas table、matplotlib figure、MIME bundle、JSON、HTML、image、通常の値を Python display helper で表示する。
- Rust の `emit_*` macro で text、JSON、table、line/scatter/bar/histogram/heatmap chart、SVG/PNG image、sandboxed HTML を出力する。
- KaTeX でインライン数式とブロック数式を表示する。
- fenced code block から Mermaid 図を表示する。
- `public/media` から静的メディアを配信する。
- 英語と日本語で同じページ構成のドキュメントを公開する。
- Rust、TypeScript、Preact、生成runtime、Wasm、ブラウザ動作をテストする。

### 前提

- Node.js と `pnpm`
- Rust toolchain `1.95.0`
- `wasm-pack`
- `cargo-llvm-cov`

Rust toolchain と Wasm target は `rust-toolchain.toml` で固定しています。

### セットアップ

依存関係をインストールします。

```sh
pnpm install
```

開発サーバーを起動します。

```sh
pnpm dev
```

`pnpm dev` は起動時に実行可能セルのruntimeを生成し、その後は MDX と任意の Rust helper ソースを監視します。本文、通常コードブロック、数式、Mermaid、メディアの変更は Astro HMR で反映されます。Python セルの変更は生成manifestを更新します。Rust セルや `crates/*` の変更は Wasm runtime を再ビルドします。

runtime watcher と Astro を分けて起動したい場合は、次のコマンドを別々のターミナルで実行します。

```sh
pnpm dev:runtime
pnpm dev:astro
```

静的サイトをビルドします。

```sh
pnpm build
```

ビルド済みサイトを確認します。

```sh
pnpm preview
```

### ドキュメント構成

ドキュメントは `src/content/docs` に置きます。英語ページは docs root に置き、日本語翻訳は同じ slug で `src/content/docs/ja` に置きます。

公開ドキュメントは次の領域に分けます。

- Overview: Oxiquill の概要と最初に読む場所。
- Guides: セットアップ、執筆ワークフロー、テンプレート、検証。
- Features: 実行可能セル、リッチ出力、数式、図、メディア。
- Sample notes: 本文と機能の組み合わせ方を示す完成例。

### ノートの執筆

英語ページは `src/content/docs/**/*.mdx` に追加します。日本語翻訳は同じ route で `src/content/docs/ja/**/*.mdx` に追加します。sidebar に出すページは `astro.config.mjs` に slug を追加します。

リポジトリ root は Rust workspace ではありません。再利用可能な任意の Rust helper crate は `crates/*` に置き、セルから Cargo package name で参照します。helper が不要な Rust セルは `crates: []` を使います。

Rust セルの例:

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

Python セルの例:

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

メディアの例:

```md
![PNG sample](/media/examples/sample.png)

<iframe class="media-frame" src="/media/examples/sample.pdf" title="Sample PDF"></iframe>
```

公開メディアは `public/media` に置きます。MDX からは `/media/...` の URL で参照できます。

### 生成物

`pnpm build`、`pnpm check`、各種 test command は `scripts/generate-doc-runtime.mjs` を実行します。この処理は MDX 内の Rust/Python セルを抽出し、生成runtimeファイルを書き出します。

生成物には次の path が含まれます。

- `src/generated/doc-runtime`
- `public/pyodide`
- `dist`

生成物を直接編集しないでください。`pnpm docgen`、`pnpm wasm:dev`、`pnpm wasm:build`、`pnpm check`、`pnpm build` などの既存 command で再生成します。

### 検証

広い変更が完了したら全体の検証を実行します。

```sh
pnpm test
```

よく使う個別 command:

```sh
pnpm check
pnpm test:unit
pnpm test:unit:coverage
pnpm test:rust
pnpm test:rust:coverage
pnpm test:wasm
pnpm test:e2e
pnpm lint:rust
pnpm doc:rust
```

docs-only の本文変更では、通常 `pnpm check` で十分です。実行可能セルの metadata、生成 Rust/Wasm の動作、ブラウザ上の表示例を変更した場合は、必要に応じて `pnpm wasm:dev`、`pnpm test:wasm`、`pnpm test:e2e` も実行します。

`test:rust:coverage` は `cargo-llvm-cov` で `crates/` 配下の任意の helper crate に line/function/region 85% を要求します。helper crate がない場合、Rust helper 用 command は正常終了で skip します。`test:unit:coverage` は Vitest の V8 coverage を使い、生成物を除いた手書きの TypeScript、Preact、Node runtime code を対象にします。

### トラブルシュート

- Rust セルの helper crate が見つからない場合は、`crates/*/Cargo.toml` の `package.name` とセルの `crates` 指定を一致させます。
- Python セルが未対応 package を指定している場合は、vendored Pyodide package を使うか、docs に書く前に対応を追加します。
- Python セルが起動しない場合は、`public/pyodide` が生成されているか確認し、`pnpm wasm:dev` または `pnpm build` を実行します。
- Mermaid 図が表示されない場合は、`pnpm build` で MDX の構文エラーを確認し、図の code block language が `mermaid` になっているか確認します。
- メディアが表示されない場合は、ファイルが `public/media` 配下にあり、`/media/...` の URL で参照しているか確認します。
- coverage が失敗した場合は、生成物ではなく対象ソースの未実行行を確認し、必要な正常系・失敗系 test を追加します。
