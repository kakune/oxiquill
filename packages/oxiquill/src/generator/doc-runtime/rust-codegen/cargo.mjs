import { generatedTomlBanner } from './banners.mjs';

export function generateRustCargoToml(rustCells, helperCrates, runtimeInputs) {
  const packageMetadata = runtimeInputs.package;
  const rust = runtimeInputs.rust;
  const dependencyLines = rustCells
    .flatMap((cell) => cell.crates)
    .filter((crateName, index, crates) => crates.indexOf(crateName) === index)
    .sort()
    .map((crateName) => generateRustDependency(crateName, helperCrates));
  const localDependencies = dependencyLines.length > 0 ? `${dependencyLines.join('\n')}\n` : '';

  return `${generatedTomlBanner()}[package]
name = "doc-rust-cells"
version = ${JSON.stringify(packageMetadata.version)}
description = "Generated Rust cells for the documentation runtime."
repository = ${JSON.stringify(packageMetadata.repository)}
edition = ${JSON.stringify(rust.edition)}
rust-version = ${JSON.stringify(rust.rustVersion)}
license = "MIT OR Apache-2.0"
publish = false

[workspace]

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
console_error_panic_hook = "=${rust.dependencies.console_error_panic_hook}"
${localDependencies}serde = { version = "=${rust.dependencies.serde}", features = ["derive"] }
serde_json = "=${rust.dependencies.serde_json}"
wasm-bindgen = "=${rust.dependencies['wasm-bindgen']}"

[dev-dependencies]
wasm-bindgen-test = "=${rust.dependencies['wasm-bindgen-test']}"
`;
}

export function generateRustDependency(crateName, helperCrates) {
  const crateInfo = helperCrates.get(crateName);
  if (!crateInfo) {
    throw new Error(`Cannot generate dependency for unknown Rust crate "${crateName}".`);
  }

  return `${crateName} = { path = ${JSON.stringify(crateInfo.relativePath)} }`;
}
