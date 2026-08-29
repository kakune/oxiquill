import { generatedTomlBanner } from './banners.mjs';

export function generateRustCargoToml(rustCells, helperCrates) {
  const dependencyLines = rustCells
    .flatMap((cell) => cell.crates)
    .filter((crateName, index, crates) => crates.indexOf(crateName) === index)
    .sort()
    .map((crateName) => generateRustDependency(crateName, helperCrates));
  const localDependencies =
    dependencyLines.length > 0 ? `${dependencyLines.join('\n')}\n` : '';

  return `${generatedTomlBanner()}[package]
name = "doc-rust-cells"
version = "0.2.0"
description = "Generated Rust cells for the documentation runtime."
edition = "2024"
rust-version = "1.95"
license = "MIT OR Apache-2.0"
publish = false

[workspace]

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
console_error_panic_hook = "0.1"
${localDependencies}serde = { version = "1", features = ["derive"] }
serde_json = "1"
wasm-bindgen = "0.2"

[dev-dependencies]
wasm-bindgen-test = "0.3"
`;
}

export function generateRustDependency(crateName, helperCrates) {
  const crateInfo = helperCrates.get(crateName);
  if (!crateInfo) {
    throw new Error(`Cannot generate dependency for unknown Rust crate "${crateName}".`);
  }

  return `${crateName} = { path = ${JSON.stringify(crateInfo.relativePath)} }`;
}
