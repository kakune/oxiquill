import { generateRustReaders } from '../rust-readers.mjs';
import { rustFunctionName } from '../rust-identifiers.mjs';
import { generatedBanner } from './banners.mjs';
import { generateRustFunction, generateRustTests } from './functions.mjs';
import { generateRustOutputTypes } from './output-types.mjs';

export function generateRustLib(rustCells) {
  const matchArms = rustCells
    .map((cell) => `        ${JSON.stringify(cell.id)} => ${rustFunctionName(cell.id)}(&inputs),`)
    .concat('        _ => Err(format!("unknown Rust cell: {cell_id}")),')
    .join('\n');
  const runFunction =
    rustCells.length === 0
      ? `#[wasm_bindgen]
pub fn run_rust_cell(cell_id: &str, inputs_json: &str) -> Result<String, JsValue> {
    let _: Value = serde_json::from_str(inputs_json).map_err(to_js_error)?;

    Err(JsValue::from_str(&format!("unknown Rust cell: {cell_id}")))
}`
      : `#[wasm_bindgen]
pub fn run_rust_cell(cell_id: &str, inputs_json: &str) -> Result<String, JsValue> {
    let inputs: Value = serde_json::from_str(inputs_json).map_err(to_js_error)?;
    let output = match cell_id {
${matchArms}
    }
    .map_err(|error| JsValue::from_str(&error))?;

    serde_json::to_string(&output).map_err(to_js_error)
}`;

  const functions = rustCells.map(generateRustFunction).join('\n\n');
  const tests = generateRustTests(rustCells);
  const readers = generateRustReaders(rustCells);
  const outputTypes = generateRustOutputTypes(rustCells);
  const serdeImport = rustCells.length === 0 ? '' : 'use serde::Serialize;\n';

  return `${generatedBanner()}${serdeImport}use serde_json::Value;
use wasm_bindgen::prelude::*;
${outputTypes}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

${runFunction}

fn to_js_error(error: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&error.to_string())
}

${readers}
${functions}

${tests}`;
}
