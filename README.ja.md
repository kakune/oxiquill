# Oxiquill

Rust、Python、数式、Mermaid 図、画像、PDF を同じ MDX ノートにまとめられる静的ドキュメントワークスペースです。Astro Starlight を土台にし、実行可能セルは Preact のランタイムコンポーネントで表示します。

ドキュメントは英語がrootです。日本語ページは `/ja/` 配下で公開します。

このリポジトリの責務は公開用成果物 `dist/` を作るところまでです。配信、TLS、ドメイン、リバースプロキシは別レイヤーで扱います。

## 主な機能

- Rust セルをビルド時に WebAssembly 化してブラウザで実行
- Python セルを Pyodide worker で実行
- テキスト、JSON、表、グラフ、画像、sandboxed HTML の共通リッチ出力
- pandas の表、matplotlib の図、一般的な MIME bundle に対応した Python リッチ表示
- 表、複数種類のグラフ、JSON、SVG/PNG 画像、sandboxed HTML を出力する Rust macro
- KaTeX によるインライン数式とブロック数式
- Mermaid によるフローチャート、シーケンス図、状態遷移図
- `public/media` から PNG、JPEG、PDF などを配信
- 英語root、日本語 `/ja/` の多言語ドキュメント
- Rust/TypeScript/Preact のテストと、生成物を除いた厳格なカバレッジゲート

## 前提

- Node.js と `pnpm`
- Rust toolchain `1.95.0`
- `wasm-pack`
- `cargo-llvm-cov`

Rust toolchain と Wasm target は `rust-toolchain.toml` で固定しています。

## セットアップ

```sh
pnpm install
```

開発サーバーを起動します。

```sh
pnpm dev
```

`pnpm dev` は初回に実行可能セルのランタイムを生成し、その後は MDX と任意の Rust helper ソースを監視します。本文、通常コード、数式、Mermaid、メディアだけの変更は Astro の HMR だけで反映し、Python セルは manifest 更新だけ、Rust セルや `crates/*` の変更だけ Wasm rebuild を実行します。

ランタイム監視と Astro を分けて起動したい場合は、次のコマンドを別々のターミナルで実行します。

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

## 執筆

英語ページは `src/content/docs/**/*.mdx` に追加します。日本語ページは同じslugで `src/content/docs/ja/**/*.mdx` に追加します。リポジトリ root は Rust workspace ではありません。任意の再利用可能な Rust helper crate は `crates/*` に置き、セルから `crates: [doc-rust]` のように参照します。helper が不要な Rust セルは `crates: []` を使います。

Rust セルの例:

````md
```rust
//| id: sample-rust
//| title: Rust の計算例
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
#| title: Python の計算例
#| run: reactive
#| inputs:
#|   scale: { type: number, label: scale, min: 1, max: 10, step: 1, value: 2 }
print(scale * 10)
```
````

メディアの例:

```md
![PNGサンプル](/media/examples/sample.png)

<iframe class="media-frame" src="/media/examples/sample.pdf" title="サンプルPDF"></iframe>
```

公開メディアは `public/media` に置きます。MDX からは `/media/...` のURLで参照できます。

## 生成物

`pnpm build` と `pnpm test` は `scripts/generate-doc-runtime.mjs` を実行します。この処理で MDX 内の Rust/Python セルを抽出し、次の生成物を作ります。

- `src/generated/doc-runtime`
- `public/pyodide`
- `dist`

これらは生成物なので直接編集しません。

## テストとカバレッジ

全体の検証:

```sh
pnpm test
```

個別の検証:

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

`test:rust:coverage` は `cargo-llvm-cov` で `crates/` 配下の任意の helper-crate workspace に line/function/region 100% を要求します。helper crate がない場合、Rust helper 用コマンドは正常終了で skip します。`test:unit:coverage` は Vitest の V8 coverage で、生成物を除いた手書きの TypeScript/Preact/Node コアに 100% を要求します。

## トラブルシュート

- Rust セルの helper crate が見つからない場合は、`crates/*/Cargo.toml` の `package.name` とセルの `crates` 指定を一致させます。
- Python セルが起動しない場合は、`public/pyodide` が生成されているか確認し、`pnpm wasm:dev` または `pnpm build` を実行します。
- Mermaid 図が表示されない場合は、`pnpm build` で MDX の構文エラーを確認し、図のコードブロック言語が `mermaid` になっているか確認します。
- メディアが表示されない場合は、ファイルが `public/media` 配下にあり、`/media/...` のURLで参照しているか確認します。
- カバレッジが失敗した場合は、生成物ではなく対象ソースの未実行行を確認し、必要な正常系・失敗系テストを追加します。
