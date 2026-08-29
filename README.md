# Oxiquill

## English

Oxiquill is a static documentation workspace for technical notes written in MDX. It publishes an Astro Starlight site where one page can combine prose, Rust/Wasm cells, Python/Pyodide cells, Haskell/WASI cells, math, Mermaid diagrams, images, PDFs, and rich output artifacts.

The repository is responsible for producing the static output in `dist/`. A sample build is published with GitHub Pages at <https://kakune.github.io/oxiquill/>. Production hosting, TLS, domains, and reverse proxies are handled outside this project.

English is the root documentation language. Japanese pages are published under `/ja/`, and the Japanese README is included later in this file.

### What Oxiquill Provides

- Static Astro/Starlight documentation built from `examples/docs-site/content/docs`.
- Rust code cells compiled to WebAssembly at build time and run in the browser.
- Python code cells run in a browser Pyodide worker.
- Haskell code cells compiled to WASI WebAssembly at build time and run in the browser.
- Input controls generated from cell metadata, including sliders, numbers, text fields, textareas, checkboxes, selects, and radio groups.
- Rich output rendering for text, JSON, tables, charts, images, and sandboxed HTML.
- Python display helpers for pandas tables, matplotlib figures, MIME bundles, JSON, HTML, images, and generic values.
- Rust `emit_*` macros for text, JSON, tables, line/scatter/bar/histogram/heatmap charts, SVG/PNG images, and sandboxed HTML.
- Inline and block math rendered with KaTeX.
- Mermaid diagrams rendered from fenced code blocks.
- Static media served from `examples/docs-site/public/media`.
- English and Japanese documentation with matching page structure.
- Rust, TypeScript, Preact, generated-runtime, Wasm, and browser tests.

### Requirements

- Nix with flakes enabled, or equivalent manual tools
- Node.js 24 and `pnpm` 11.2.2
- Rust toolchain `1.95.0` with `wasm32-unknown-unknown`
- `wasm-pack`
- `cargo-llvm-cov`
- `wasm32-wasi-ghc` 9.14 when authoring Haskell cells
- Chromium, Firefox, and WebKit for the full Playwright e2e suite

On NixOS or any Linux system with Nix, use the checked-in flake to enter a shell with Node, pnpm, Rust, `wasm-pack`, `cargo-llvm-cov`, `wasm32-wasi-ghc`, and the Chromium/Firefox/WebKit Playwright bundle already wired up:

```sh
nix develop
```

The Nix shell sets `OXIQUILL_NODE`, `OXIQUILL_HASKELL_GHC`, `LLVM_COV`, `LLVM_PROFDATA`, `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`, and `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH`. Writable tool caches are kept under the ignored `.cache/` directory.

Without Nix, install equivalent tools manually. Haskell cells use GHC's `wasm32-wasi` backend. When using `ghc-wasm-meta`, keep a normal Node.js runtime first in `PATH` and point Oxiquill at the Haskell compiler directly:

```sh
nvm alias default 24.2.0
export OXIQUILL_HASKELL_GHC="$HOME/.ghc-wasm/wasm32-wasi-ghc/bin/wasm32-wasi-ghc"
```

Avoid putting ghc-wasm's static Node ahead of the normal Node used by Vite, Vitest, and Astro. If your shell sources `~/.ghc-wasm/env`, run `nvm use 24.2.0` afterward or set `OXIQUILL_NODE` to a normal Node.js binary for Oxiquill's Astro/Vite subprocesses.

### Setup

Enter the development shell and install dependencies:

```sh
nix develop
pnpm install --frozen-lockfile
```

Start the development server:

```sh
pnpm dev
```

`pnpm dev` delegates to `examples/docs-site` and generates the executable-cell runtime on startup, then watches MDX files and optional Rust helper sources. Prose, normal code blocks, math, Mermaid, and media changes use Astro HMR. Python cell changes update the generated manifest. Rust cell and `examples/docs-site/crates/*` changes rebuild the Rust Wasm runtime. Haskell cell changes rebuild the Haskell/WASI runtime when Haskell cells are present. In development, a missing or failing Haskell compiler leaves Astro running and shows a browser-visible Haskell cell error until the compiler is installed and the runtime is regenerated.

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

### Use From Another Repository

A consuming docs repository only needs `oxiquill` as its documentation framework dependency:

```json
{
  "dependencies": {
    "oxiquill": "0.2.0"
  },
  "scripts": {
    "dev": "oxiquill dev",
    "build": "oxiquill build",
    "check": "oxiquill check"
  }
}
```

For local development against this checkout, use the same API with a local package link:

```json
{
  "dependencies": {
    "oxiquill": "link:../oxiquill/packages/oxiquill"
  }
}
```

The consumer config stays small:

```js
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  title: 'My Docs',
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
```

```ts
export { collections } from 'oxiquill/content';
```

Use `content/docs`, `crates`, `public`, and `.oxiquill` at the consumer repository root. Oxiquill writes generated internals and browser runtime assets into the consumer workspace, not into the installed package.

### Repository Layout

- `packages/oxiquill`: the reusable package, Astro integration, CLI, runtime components, styles, and generators.
- `examples/docs-site`: the dogfood documentation site that consumes `oxiquill` through the workspace.
- `templates/basic`: a starter project for a new Oxiquill documentation site.
- `tests`: unit tests and consumer fixtures for linked-package usage.

### Documentation Structure

Documentation lives under `examples/docs-site/content/docs`. English pages use the root docs directory, and Japanese translations use the same slug under `examples/docs-site/content/docs/ja`.

The public documentation is organized around these areas:

- Overview: what Oxiquill is and where to start.
- Guides: setup, authoring workflow, templates, and validation.
- Features: interactive cells, rich output, math, diagrams, and media.
- Sample notes: complete examples that show how prose and features fit together.

### Authoring Notes

Add English pages under `examples/docs-site/content/docs/**/*.mdx`. Add Japanese translations with the same route under `examples/docs-site/content/docs/ja/**/*.mdx`. Add new sidebar entries in `examples/docs-site/astro.config.mjs`.

The repository root is not a Rust workspace. Optional reusable Rust helper crates for the dogfood site live under `examples/docs-site/crates/*`; cells reference helper crates by Cargo package name. Rust cells that do not need helpers should use `crates: []`.

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

Haskell cell example:

````md
```haskell
--| id: sample-haskell
--| title: Haskell calculation
--| run: button
--| inputs:
--|   scale: { type: integer, label: scale, min: 1, max: 10, step: 1, value: 2 }
putStrLn ("scaled = " <> show (scale * sum [1..5]))
```
````

Media example:

```md
![PNG sample](/media/examples/sample.png)

<iframe class="media-frame" src="/media/examples/sample.pdf" title="Sample PDF"></iframe>
```

Put public media files in `examples/docs-site/public/media`. They are served as-is and can be referenced from MDX with `/media/...` URLs.

### Generated Files

`pnpm build`, `pnpm check`, and test commands run the `oxiquill` CLI. This extracts Rust/Python/Haskell cells from MDX and writes generated runtime files. These strict commands, along with `pnpm wasm:dev`, `pnpm wasm:build`, and `pnpm test:wasm`, require `wasm32-wasi-ghc` when Haskell cells exist.

Generated output includes:

- `examples/docs-site/.oxiquill/generated`
- `examples/docs-site/.oxiquill/rust-cells`
- `examples/docs-site/.oxiquill/haskell-cells`
- `examples/docs-site/public/oxiquill/pyodide`
- `examples/docs-site/public/oxiquill/rust-wasm`
- `examples/docs-site/public/oxiquill/haskell-wasm`
- `examples/docs-site/public/oxiquill/licenses`
- `examples/docs-site/dist`
- `examples/docs-site/dist/oxiquill/bundle-report.json`

Do not edit generated output directly. Regenerate it with existing commands such as `pnpm docgen`, `pnpm wasm:dev`, `pnpm wasm:build`, `pnpm check`, or `pnpm build`.

### Validation

Run the full validation suite when broad changes are complete:

```sh
pnpm test
```

Useful focused commands:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test:unit
pnpm test:unit:coverage
pnpm test:rust
pnpm test:rust:coverage
pnpm test:wasm
pnpm test:haskell
pnpm test:bundle
pnpm test:e2e
pnpm test:consumer:npm
pnpm test:consumer:pnpm
pnpm lint:rust
pnpm doc:rust
```

For docs-only prose changes, `pnpm check` is usually enough. For interactive cell metadata, generated Rust/Wasm or Haskell/WASI behavior, or browser-visible examples, also run `pnpm wasm:dev`, `pnpm test:wasm`, and `pnpm test:e2e` as appropriate.

`pnpm lint` runs ESLint with zero warnings, checks Prettier formatting, and runs strict Rust linting. `test:unit:coverage` requires 85% statement, branch, function, and line coverage across handwritten CLI, Astro integration, generator, manifest, worker, TypeScript, Preact, and Node runtime code; only generated output and type-only declarations are excluded. `test:rust:coverage` requires 85% line/function/region coverage for optional helper crates under `examples/docs-site/crates/` through `cargo-llvm-cov`. If no helper crates exist, Rust helper commands skip cleanly.

Production builds write `dist/oxiquill/bundle-report.json` and fail when any emitted client or worker JavaScript chunk exceeds 650 KiB uncompressed. Run `pnpm test:bundle` after `pnpm build` to verify the budget and the ECharts and Mermaid dynamic import boundaries.

`test:e2e` runs the full suite in Chromium, Firefox, and WebKit. `test:consumer:npm` and `test:consumer:pnpm` install the packed package tarball into a temporary standalone project, generate a Rust/Wasm cell, run static checks, and build the site without workspace links.

### License

Oxiquill is available under your choice of the [MIT License](./LICENSE-MIT) or the [Apache License, Version 2.0](./LICENSE-APACHE). Generated sites automatically include both Oxiquill license files and third-party notices under `oxiquill/licenses/`. No visible attribution or “Powered by Oxiquill” notice is required.

See the [licensing guide](./examples/docs-site/content/docs/guides/licensing.mdx) for the generated-file scope and downstream responsibilities. Historical releases remain under the license recorded in their tags.

### Contributing

Contributions are welcome. Please open issues for bug reports, questions, and proposals, and send focused pull requests to `main` from topic branches for fixes or documentation improvements. Pull requests are squash-merged after the required checks pass. Contributions are accepted under the inbound dual-license terms in [CONTRIBUTING.md](./CONTRIBUTING.md).

### Contributing

Contributions are welcome. Please open issues for bug reports, questions, and proposals, and send focused pull requests for fixes or documentation improvements.

### Troubleshooting

- If a Rust cell helper crate cannot be found, match the cell `crates` value to the `package.name` in `examples/docs-site/crates/*/Cargo.toml`.
- If a Python cell specifies an unsupported package, use one of the vendored Pyodide packages or add support before documenting it.
- If a Python cell does not start, confirm that `examples/docs-site/public/oxiquill/pyodide` exists and run `pnpm wasm:dev` or `pnpm build`.
- If a Haskell cell does not build in a strict command, confirm `wasm32-wasi-ghc` is on `PATH`, source `~/.ghc-wasm/env`, or set `OXIQUILL_HASKELL_GHC` to the compiler path.
- If a Haskell cell reports that the runtime is unavailable in dev, install or fix `wasm32-wasi-ghc` and rerun `pnpm wasm:dev`; `pnpm dev` will keep serving while the Haskell runtime is unavailable.
- If a Mermaid diagram does not render, run `pnpm build` to catch MDX syntax errors and confirm the code block language is `mermaid`.
- If a media file does not load, confirm that it is under `examples/docs-site/public/media` and referenced with a `/media/...` URL.
- If coverage fails, add focused tests for the uncovered handwritten source rather than editing generated files.

## 日本語

Oxiquill は、MDX で書いた技術ノートを静的サイトとして公開するためのドキュメントワークスペースです。Astro Starlight を土台にし、1つのページに本文、Rust/Wasm セル、Python/Pyodide セル、Haskell/WASI セル、数式、Mermaid 図、画像、PDF、リッチ出力をまとめられます。

このリポジトリの責務は、公開用の静的成果物 `dist/` を作るところまでです。サンプルビルドは GitHub Pages で <https://kakune.github.io/oxiquill/> に公開します。本番配信、TLS、ドメイン、リバースプロキシはこのプロジェクトの外側で扱います。

ドキュメントのroot言語は英語です。日本語ページは `/ja/` 配下で公開します。

### Oxiquill でできること

- `examples/docs-site/content/docs` から Astro/Starlight の静的ドキュメントを生成する。
- Rust コードセルをビルド時に WebAssembly 化し、ブラウザで実行する。
- Python コードセルをブラウザの Pyodide worker で実行する。
- Haskell コードセルをビルド時に WASI WebAssembly 化し、ブラウザで実行する。
- セル metadata から slider、number、text、textarea、checkbox、select、radio の入力 UI を生成する。
- text、JSON、table、chart、image、sandboxed HTML のリッチ出力を表示する。
- pandas table、matplotlib figure、MIME bundle、JSON、HTML、image、通常の値を Python display helper で表示する。
- Rust の `emit_*` macro で text、JSON、table、line/scatter/bar/histogram/heatmap chart、SVG/PNG image、sandboxed HTML を出力する。
- KaTeX でインライン数式とブロック数式を表示する。
- fenced code block から Mermaid 図を表示する。
- `examples/docs-site/public/media` から静的メディアを配信する。
- 英語と日本語で同じページ構成のドキュメントを公開する。
- Rust、TypeScript、Preact、生成runtime、Wasm、ブラウザ動作をテストする。

### 前提

- Nix flakes、または同等の手動 tool
- Node.js 24 と `pnpm` 11.2.2
- `wasm32-unknown-unknown` を含む Rust toolchain `1.95.0`
- `wasm-pack`
- `cargo-llvm-cov`
- Haskell セルを書く場合は `wasm32-wasi-ghc` 9.14
- Playwright e2e full suite 用の Chromium、Firefox、WebKit

NixOS または Nix を使える Linux では、このリポジトリの flake で shell に入ると、Node、pnpm、Rust、`wasm-pack`、`cargo-llvm-cov`、`wasm32-wasi-ghc`、Playwright 用 Chromium/Firefox/WebKit bundle が設定済みになります。

```sh
nix develop
```

Nix shell は `OXIQUILL_NODE`、`OXIQUILL_HASKELL_GHC`、`LLVM_COV`、`LLVM_PROFDATA`、`PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1`、`PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH` を設定します。tool cache は ignore 済みの `.cache/` 配下に置かれます。

Nix を使わない場合は、同等の tool を手動で導入してください。Haskell セルは GHC の `wasm32-wasi` backend を使います。`ghc-wasm-meta` を使う場合は、通常の Node.js runtime を `PATH` の先頭に置いたまま、Oxiquill には Haskell compiler の path を直接指定します。

```sh
nvm alias default 24.2.0
export OXIQUILL_HASKELL_GHC="$HOME/.ghc-wasm/wasm32-wasi-ghc/bin/wasm32-wasi-ghc"
```

Vite、Vitest、Astro が使う通常の Node より前に ghc-wasm の static Node を置かないでください。shell で `~/.ghc-wasm/env` を source する場合は、その後に `nvm use 24.2.0` を実行するか、Oxiquill の Astro/Vite subprocess 用に `OXIQUILL_NODE` で通常の Node.js binary を指定してください。

### セットアップ

開発 shell に入り、依存関係をインストールします。

```sh
nix develop
pnpm install --frozen-lockfile
```

開発サーバーを起動します。

```sh
pnpm dev
```

`pnpm dev` は `examples/docs-site` に委譲し、起動時に実行可能セルのruntimeを生成します。その後は MDX と任意の Rust helper ソースを監視します。本文、通常コードブロック、数式、Mermaid、メディアの変更は Astro HMR で反映されます。Python セルの変更は生成manifestを更新します。Rust セルや `examples/docs-site/crates/*` の変更は Rust Wasm runtime を再ビルドします。Haskell セルの変更は、Haskell セルがある場合に Haskell/WASI runtime を再ビルドします。開発中は Haskell compiler がない、または build に失敗しても Astro は起動したままになり、compiler を導入して runtime を再生成するまで Haskell セルに browser 上の error を表示します。

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

### 別リポジトリから使う

利用側の documentation repository では、framework dependency として `oxiquill` だけを追加します。

```json
{
  "dependencies": {
    "oxiquill": "0.2.0"
  },
  "scripts": {
    "dev": "oxiquill dev",
    "build": "oxiquill build",
    "check": "oxiquill check"
  }
}
```

この checkout に対して local development する場合も、同じ API のまま local package link を使います。

```json
{
  "dependencies": {
    "oxiquill": "link:../oxiquill/packages/oxiquill"
  }
}
```

consumer config は小さく保ちます。

```js
import { defineOxiquillConfig } from 'oxiquill/astro';

export default defineOxiquillConfig({
  title: 'My Docs',
  sidebar: [{ label: 'Overview', items: [{ label: 'Home', slug: 'index' }] }]
});
```

```ts
export { collections } from 'oxiquill/content';
```

利用側 repository root に `content/docs`、`crates`、`public`、`.oxiquill` を置きます。Oxiquill は生成内部ファイルと browser runtime asset を利用側 workspace に書き、installed package には書きません。

### リポジトリ構成

- `packages/oxiquill`: 再利用可能な package、Astro integration、CLI、runtime component、style、generator。
- `examples/docs-site`: workspace 経由で `oxiquill` を使う dogfood documentation site。
- `templates/basic`: 新しい Oxiquill documentation site 用の starter。
- `tests`: unit test と linked package 利用を確認する consumer fixture。

### ドキュメント構成

ドキュメントは `examples/docs-site/content/docs` に置きます。英語ページは docs root に置き、日本語翻訳は同じ slug で `examples/docs-site/content/docs/ja` に置きます。

公開ドキュメントは次の領域に分けます。

- Overview: Oxiquill の概要と最初に読む場所。
- Guides: セットアップ、執筆ワークフロー、テンプレート、検証。
- Features: 実行可能セル、リッチ出力、数式、図、メディア。
- Sample notes: 本文と機能の組み合わせ方を示す完成例。

### ノートの執筆

英語ページは `examples/docs-site/content/docs/**/*.mdx` に追加します。日本語翻訳は同じ route で `examples/docs-site/content/docs/ja/**/*.mdx` に追加します。sidebar に出すページは `examples/docs-site/astro.config.mjs` に slug を追加します。

リポジトリ root は Rust workspace ではありません。dogfood site 用の再利用可能な任意の Rust helper crate は `examples/docs-site/crates/*` に置き、セルから Cargo package name で参照します。helper が不要な Rust セルは `crates: []` を使います。

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

Haskell セルの例:

````md
```haskell
--| id: sample-haskell
--| title: Haskell calculation
--| run: button
--| inputs:
--|   scale: { type: integer, label: scale, min: 1, max: 10, step: 1, value: 2 }
putStrLn ("scaled = " <> show (scale * sum [1..5]))
```
````

メディアの例:

```md
![PNG sample](/media/examples/sample.png)

<iframe class="media-frame" src="/media/examples/sample.pdf" title="Sample PDF"></iframe>
```

公開メディアは `examples/docs-site/public/media` に置きます。MDX からは `/media/...` の URL で参照できます。

### 生成物

`pnpm build`、`pnpm check`、各種 test command は `oxiquill` CLI を実行します。この処理は MDX 内の Rust/Python/Haskell セルを抽出し、生成runtimeファイルを書き出します。これらの strict command と `pnpm wasm:dev`、`pnpm wasm:build`、`pnpm test:wasm` は、Haskell セルがある場合に `wasm32-wasi-ghc` を必要とします。

生成物には次の path が含まれます。

- `examples/docs-site/.oxiquill/generated`
- `examples/docs-site/.oxiquill/rust-cells`
- `examples/docs-site/.oxiquill/haskell-cells`
- `examples/docs-site/public/oxiquill/pyodide`
- `examples/docs-site/public/oxiquill/rust-wasm`
- `examples/docs-site/public/oxiquill/haskell-wasm`
- `examples/docs-site/public/oxiquill/licenses`
- `examples/docs-site/dist`
- `examples/docs-site/dist/oxiquill/bundle-report.json`

生成物を直接編集しないでください。`pnpm docgen`、`pnpm wasm:dev`、`pnpm wasm:build`、`pnpm check`、`pnpm build` などの既存 command で再生成します。

### 検証

広い変更が完了したら全体の検証を実行します。

```sh
pnpm test
```

よく使う個別 command:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test:unit
pnpm test:unit:coverage
pnpm test:rust
pnpm test:rust:coverage
pnpm test:wasm
pnpm test:haskell
pnpm test:bundle
pnpm test:e2e
pnpm test:consumer:npm
pnpm test:consumer:pnpm
pnpm lint:rust
pnpm doc:rust
```

docs-only の本文変更では、通常 `pnpm check` で十分です。実行可能セルの metadata、生成 Rust/Wasm や Haskell/WASI の動作、ブラウザ上の表示例を変更した場合は、必要に応じて `pnpm wasm:dev`、`pnpm test:wasm`、`pnpm test:e2e` も実行します。

`pnpm lint` は ESLint を warning なしで実行し、Prettier format と strict Rust lint も確認します。`test:unit:coverage` は Vitest の V8 coverage を使い、手書きの CLI、Astro integration、generator、manifest、worker、TypeScript、Preact、Node runtime code に statement/branch/function/line 85% coverage を要求します。除外するのは生成物と type-only declaration だけです。`test:rust:coverage` は `cargo-llvm-cov` で `examples/docs-site/crates/` 配下の任意の helper crate に line/function/region 85% を要求します。helper crate がない場合、Rust helper 用 command は正常終了で skip します。

production build は `dist/oxiquill/bundle-report.json` を生成し、出力された client または worker の JavaScript chunk が uncompressed で 650 KiB を超えると失敗します。`pnpm build` の後に `pnpm test:bundle` を実行すると、budget と ECharts/Mermaid の dynamic import boundary を検証できます。

`test:e2e` は Chromium、Firefox、WebKit で full suite を実行します。`test:consumer:npm` と `test:consumer:pnpm` は packed tarball を一時的な standalone project に installし、workspace link を使わずに Rust/Wasm cell の生成、static check、site build を確認します。

### ライセンス

Oxiquill は [MIT License](./LICENSE-MIT) または [Apache License, Version 2.0](./LICENSE-APACHE) のいずれかを選んで利用できます。生成サイトには、Oxiquill の2つのライセンスファイルと third-party notice が `oxiquill/licenses/` 配下へ自動的に含まれます。画面上の attribution や「Powered by Oxiquill」の表示は必要ありません。

生成ファイルの対象範囲と利用側の責任は[ライセンスガイド](./examples/docs-site/content/docs/ja/guides/licensing.mdx)を参照してください。過去の release には、それぞれの tag に記録されたライセンスが引き続き適用されます。

### コントリビューション

バグ報告、質問、提案は issue で歓迎します。修正やドキュメント改善は topic branch から `main` への小さな pull request として送ってください。必須 check が成功した pull request は squash merge します。Contribution は [CONTRIBUTING.md](./CONTRIBUTING.md) の inbound dual-license 条項に基づいて受け入れます。

### コントリビューション

バグ報告、質問、提案は issue で歓迎します。小さな修正やドキュメント改善の pull request も歓迎します。

### トラブルシュート

- Rust セルの helper crate が見つからない場合は、`examples/docs-site/crates/*/Cargo.toml` の `package.name` とセルの `crates` 指定を一致させます。
- Python セルが未対応 package を指定している場合は、vendored Pyodide package を使うか、docs に書く前に対応を追加します。
- Python セルが起動しない場合は、`examples/docs-site/public/oxiquill/pyodide` が生成されているか確認し、`pnpm wasm:dev` または `pnpm build` を実行します。
- strict command で Haskell セルが build できない場合は、`wasm32-wasi-ghc` が `PATH` にあるか、`~/.ghc-wasm/env` を source したか、または `OXIQUILL_HASKELL_GHC` に compiler path を指定したか確認します。
- dev で Haskell セルが runtime unavailable を表示する場合は、`wasm32-wasi-ghc` を導入または修正して `pnpm wasm:dev` を再実行します。`pnpm dev` は Haskell runtime が unavailable でも serving を続けます。
- Mermaid 図が表示されない場合は、`pnpm build` で MDX の構文エラーを確認し、図の code block language が `mermaid` になっているか確認します。
- メディアが表示されない場合は、ファイルが `examples/docs-site/public/media` 配下にあり、`/media/...` の URL で参照しているか確認します。
- coverage が失敗した場合は、生成物ではなく対象ソースの未実行行を確認し、必要な正常系・失敗系 test を追加します。
