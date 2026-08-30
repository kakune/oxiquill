import { generateRustReaders } from '../rust-readers.mjs';
import { rustFunctionName } from '../rust-identifiers.mjs';
import { generatedBanner } from './banners.mjs';
import { generateRustFunction, generateRustTests } from './functions.mjs';
import { generateRustOutputTypes } from './output-types.mjs';
import { outputArtifactLimits } from '../../../lib/doc-runtime/output-limits.mjs';

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

    serialize_cell_output(output).map_err(to_js_error)
}`;

  const functions = rustCells.map(generateRustFunction).join('\n\n');
  const tests = generateRustTests(rustCells);
  const readers = generateRustReaders(rustCells);
  const outputTypes = generateRustOutputTypes(rustCells);
  const serdeImport = rustCells.length === 0 ? '' : 'use serde::Serialize;\n';
  const jsErrorMessage =
    rustCells.length === 0
      ? `{
        let message = error.to_string();
        message
            .chars()
            .scan(0_usize, |bytes, character| {
                *bytes += character.len_utf8();
                Some((*bytes <= ${outputArtifactLimits.bytesPerError}).then_some(character))
            })
            .flatten()
            .collect::<String>()
    }`
      : 'bounded_error_message(&error.to_string())';

  return `${generatedBanner()}${serdeImport}use serde_json::Value;
use wasm_bindgen::prelude::*;
${outputTypes}

#[wasm_bindgen(start)]
pub fn start() {
    console_error_panic_hook::set_once();
}

${runFunction}

fn to_js_error(error: impl std::fmt::Display) -> JsValue {
    let message = ${jsErrorMessage};
    JsValue::from_str(&message)
}

${readers}
${functions}

${tests}`;
}
