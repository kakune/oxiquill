import path from 'node:path';
import YAML from 'yaml';
import { scopedCellId } from '../src/lib/doc-runtime/authoring-ids.mjs';

export const sourceThemes = {
  light: 'github-light',
  dark: 'github-dark'
};

const fencePattern = /(^|\n)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)\n\2(?=\n|$)/g;
const optionPattern = /^\s*(?:(?:\/\/\/|\/\/|#)\|)\s?(.*)$/;
const supportedLanguages = new Map([
  ['rust', 'rust'],
  ['rs', 'rust'],
  ['python', 'python'],
  ['py', 'python']
]);
const runModes = ['button', 'reactive', 'autorun', 'hidden'];
const inputTypes = ['range', 'number', 'integer', 'text', 'textarea', 'checkbox', 'select', 'radio'];
const rustReservedIdentifiers = new Set([
  'Self',
  'abstract',
  'as',
  'async',
  'await',
  'become',
  'box',
  'break',
  'const',
  'continue',
  'crate',
  'do',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'final',
  'fn',
  'for',
  'gen',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'macro',
  'match',
  'mod',
  'move',
  'mut',
  'override',
  'priv',
  'pub',
  'ref',
  'return',
  'self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'try',
  'type',
  'typeof',
  'union',
  'unsafe',
  'unsized',
  'use',
  'virtual',
  'where',
  'while',
  'yield'
]);

export async function extractCellsFromMarkdown(source, pagePath, context) {
  const cells = [];

  for (const match of source.matchAll(fencePattern)) {
    const language = parseLanguage(match[3]);
    if (!language) continue;

    const parsed = await parseCell(match[4], language, pagePath, context);
    if (parsed) cells.push(parsed);
  }

  return cells;
}

export function parseLanguage(info) {
  const raw = info.trim().split(/\s+/u)[0].replace(/[{}]/gu, '').replace(/^\./u, '');
  return supportedLanguages.get(raw);
}

export async function parseCell(rawSource, language, pagePath, context) {
  const { metadataLines, sourceLines } = splitCellSource(rawSource);

  if (metadataLines.length === 0) return undefined;

  const metadata = YAML.parse(metadataLines.join('\n')) ?? {};
  const localId = metadata.id;
  if (!localId || typeof localId !== 'string') {
    throw new Error(`Interactive ${language} cell in ${pagePath} is missing an id option.`);
  }

  const source = sourceLines.join('\n').trim();
  if (!source) {
    throw new Error(`Interactive cell "${localId}" in ${pagePath} does not contain code.`);
  }

  return {
    id: scopedCellId(pagePath, localId),
    language,
    title: String(metadata.title ?? localId),
    run: normalizeRunMode(metadata.run, localId, pagePath),
    source,
    sourceHtml: await context.highlighter.codeToHtml(source, {
      lang: language,
      themes: sourceThemes
    }),
    inputs: normalizeInputs(metadata.inputs, localId, pagePath),
    packages: normalizePackages(metadata.packages, language, metadata.id, pagePath),
    crates: normalizeCrates(metadata.crates, language, metadata.id, pagePath, context.helperCrates),
    timeoutMs: normalizeTimeout(metadata.timeoutMs, localId, pagePath),
    showSource: metadata.showSource !== false,
    pagePath
  };
}

export function splitCellSource(rawSource) {
  const metadataLines = [];
  const sourceLines = [];

  for (const line of rawSource.split('\n')) {
    const optionMatch = line.match(optionPattern);
    if (optionMatch) {
      metadataLines.push(optionMatch[1]);
    } else {
      sourceLines.push(line);
    }
  }

  return { metadataLines, sourceLines };
}

export function normalizeRunMode(value, cellId = 'cell', pagePath = 'page') {
  if (value == null) return 'button';
  if (runModes.includes(value)) return value;

  throw new Error(
    `Interactive cell "${cellId}" in ${pagePath} has invalid run value ${JSON.stringify(value)}. ` +
      `Allowed values: ${runModes.join(', ')}.`
  );
}

export function normalizeTimeout(value, cellId = 'cell', pagePath = 'page') {
  if (value == null) return 30_000;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new Error(
      `Interactive cell "${cellId}" in ${pagePath} has invalid timeoutMs value ${JSON.stringify(value)}. ` +
        'Expected a positive number.'
    );
  }

  return Math.trunc(value);
}

export function normalizePackages(value, language, cellId, pagePath) {
  if (value == null) return [];
  if (language !== 'python') {
    throw new Error(`Rust cell "${cellId}" in ${pagePath} must use crates instead of packages.`);
  }

  const packages = normalizeStringArray(value, 'packages', cellId, pagePath);
  if (packages.length > 0) {
    throw new Error(
      `Python cell "${cellId}" in ${pagePath} specifies packages: ${packages.join(', ')}. ` +
        'Static Pyodide package assets are not currently distributed; remove packages or add package asset copying first.'
    );
  }

  return packages;
}

export function normalizeCrates(value, language, cellId, pagePath, helperCrates) {
  if (value == null) return [];
  if (language !== 'rust') {
    throw new Error(`Non-Rust cell "${cellId}" in ${pagePath} cannot specify crates.`);
  }

  const crates = normalizeStringArray(value, 'crates', cellId, pagePath);
  for (const crateName of crates) {
    if (!helperCrates.has(crateName)) {
      const validCrates = Array.from(helperCrates.keys()).join(', ') || '(none)';
      throw new Error(
        `Rust cell "${cellId}" in ${pagePath} references unknown crate "${crateName}". ` +
          `Expected a helper crate under crates/. Available crates: ${validCrates}.`
      );
    }
  }

  return crates;
}

export function normalizeStringArray(value, field, cellId, pagePath) {
  if (!Array.isArray(value)) {
    throw new Error(`Interactive cell "${cellId}" in ${pagePath} has invalid ${field}; expected an array.`);
  }

  const values = new Set();
  for (const raw of value) {
    if (typeof raw !== 'string' || raw.trim() === '') {
      throw new Error(
        `Interactive cell "${cellId}" in ${pagePath} has invalid ${field}; values must be non-empty strings.`
      );
    }
    values.add(raw.trim());
  }

  return Array.from(values).sort();
}

export function normalizeInputs(inputs, cellId = 'cell', pagePath = 'page') {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return [];

  return Object.entries(inputs).map(([name, raw]) => {
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : { value: raw };
    const type = normalizeInputType(value.type, name, cellId, pagePath);

    return {
      name,
      type,
      label: String(value.label ?? name),
      value: normalizeInputValue(type, value.value),
      min: normalizeOptionalNumber(value.min),
      max: normalizeOptionalNumber(value.max),
      step: normalizeOptionalNumber(value.step),
      integer: value.integer === true || type === 'integer',
      options: normalizeOptions(value.options)
    };
  });
}

export function normalizeInputType(type, inputName = 'input', cellId = 'cell', pagePath = 'page') {
  if (type == null) return 'text';
  if (inputTypes.includes(type)) return type;

  throw new Error(
    `Interactive cell "${cellId}" in ${pagePath} has invalid type ${JSON.stringify(type)} ` +
      `for input "${inputName}". Allowed values: ${inputTypes.join(', ')}.`
  );
}

export function normalizeInputValue(type, value) {
  if (type === 'checkbox') return Boolean(value);
  if (type === 'range' || type === 'number') return typeof value === 'number' ? value : 0;
  if (type === 'integer') return typeof value === 'number' ? Math.trunc(value) : 0;
  return value == null ? '' : String(value);
}

export function normalizeOptionalNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function normalizeOptions(options) {
  if (!Array.isArray(options)) return [];
  return options.map((option) => {
    if (option && typeof option === 'object') {
      return {
        label: String(option.label ?? option.value),
        value: String(option.value ?? option.label)
      };
    }

    return { label: String(option), value: String(option) };
  });
}

export function assertUniqueCellIds(cells) {
  const seen = new Map();
  for (const cell of cells) {
    const previous = seen.get(cell.id);
    if (previous) {
      throw new Error(`Duplicate interactive cell id "${cell.id}" in ${previous} and ${cell.pagePath}.`);
    }
    seen.set(cell.id, cell.pagePath);
  }
}

export function assertUniqueRustInputBindings(rustCells) {
  for (const cell of rustCells) {
    const seen = new Map();
    for (const input of cell.inputs) {
      const binding = rustIdentifier(input.name);
      const previous = seen.get(binding);
      if (previous) {
        throw new Error(
          `Rust cell "${cell.id}" in ${cell.pagePath} has inputs "${previous}" and "${input.name}" ` +
            `that both map to Rust binding "${binding}".`
        );
      }
      seen.set(binding, input.name);
    }
  }
}

export function helperCratesFromManifests(manifests, { rustCrateDir }) {
  const helperCrates = manifests
    .map((manifest) => ({
      manifestDir: path.dirname(manifest.manifestPath),
      name: packageNameFromCargoToml(manifest.content, manifest.manifestPath)
    }))
    .map(({ manifestDir, name }) => [
      name,
      {
        name,
        relativePath: normalizePath(path.relative(rustCrateDir, manifestDir))
      }
    ])
    .sort(([left], [right]) => left.localeCompare(right));

  const duplicateName = findDuplicate(helperCrates.map(([name]) => name));
  if (duplicateName) {
    throw new Error(`Duplicate helper crate package name "${duplicateName}" under crates/.`);
  }

  return new Map(helperCrates);
}

export function packageNameFromCargoToml(content, manifestPath) {
  const packageTable = content.match(/(?:^|\n)\[package\]\s*(?:\n|$)([\s\S]*?)(?=\n\[|$)/u);
  const nameLine = packageTable?.[1].match(/(?:^|\n)\s*name\s*=\s*"([^"]+)"\s*(?:\n|$)/u);
  const name = nameLine?.[1]?.trim();
  if (!name) {
    throw new Error(`Helper crate manifest ${manifestPath} is missing [package] name.`);
  }

  return name;
}

export function generateCellsModule(cells) {
  return `${generatedBanner()}export const cells = ${JSON.stringify(cells, null, 2)} as const;\n`;
}

export function generateCellsJson(cells) {
  return `${JSON.stringify(cells, null, 2)}\n`;
}

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
version = "0.1.0"
description = "Generated Rust cells for the documentation runtime."
edition = "2024"
rust-version = "1.95"
license = "AGPL-3.0-only"
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

function findDuplicate(values) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }

  return undefined;
}

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
  const firstCellTest = rustCells[0] ? generateRustTest(rustCells[0]) : '';
  const readers = generateRustReaders(rustCells);
  const outputTypes =
    rustCells.length === 0
      ? ''
      : `
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum PlotSpec {
    #[serde(rename = "line")]
    Line(LinePlotSpec),
}

#[derive(Debug, Serialize)]
struct LinePlotSpec {
    x_label: String,
    y_label: String,
    points: Vec<[f64; 2]>,
}

#[derive(Debug, Serialize)]
struct CellOutput {
    stdout: String,
    plots: Vec<PlotSpec>,
    value: Value,
}
`;
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

${firstCellTest}`;
}

export function generateRustReaders(rustCells) {
  const readers = new Set(
    rustCells.flatMap((cell) => cell.inputs.map((input) => rustReaderName(input)))
  );

  return [
    readers.has('read_f64') ? rustReadF64() : '',
    readers.has('read_u32') ? rustReadU32() : '',
    readers.has('read_bool') ? rustReadBool() : '',
    readers.has('read_string') ? rustReadString() : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function generateRustFunction(cell) {
  const inputBindings = cell.inputs.map((input) => `    ${generateRustInputBinding(input)}`).join('\n');
  const escapedSource = indentRustSource(cell.source);
  const capturesStdout = cell.source.includes('println!');
  const emitsPlots = cell.source.includes('emit_line_plot!');
  const stdoutBinding = `let ${capturesStdout ? 'mut ' : ''}__stdout = String::new();`;
  const plotsBinding = `let ${emitsPlots ? 'mut ' : ''}__plots = Vec::new();`;
  const macros = [
    capturesStdout ? generatePrintlnMacro() : '',
    emitsPlots ? generateLinePlotMacro() : ''
  ]
    .filter(Boolean)
    .join('\n\n');

  return `fn ${rustFunctionName(cell.id)}(inputs: &Value) -> Result<CellOutput, String> {
${inputBindings ? `${inputBindings}\n` : ''}    ${stdoutBinding}
    ${plotsBinding}
${macros ? `\n${macros}\n` : ''}

${escapedSource}

    Ok(CellOutput {
        stdout: __stdout,
        plots: __plots,
        value: Value::Null,
    })
}`;
}

export function generateRustInputBinding(input) {
  const key = JSON.stringify(input.name);
  const variable = rustIdentifier(input.name);
  return `let ${variable} = ${rustReaderName(input)}(inputs, ${key})?;`;
}

export function rustReaderName(input) {
  if (input.type === 'checkbox') return 'read_bool';
  if (input.type === 'integer' || input.integer) return 'read_u32';
  if (input.type === 'range' || input.type === 'number') return 'read_f64';
  return 'read_string';
}

export function rustFunctionName(id) {
  return `run_${rustIdentifier(id)}`;
}

export function rustIdentifier(value) {
  const identifier = value.replace(/[^a-zA-Z0-9_]/gu, '_').replace(/_+/gu, '_');
  if (!/^[a-zA-Z_]/u.test(identifier)) return `cell_${identifier}`;
  return rustReservedIdentifiers.has(identifier) ? `cell_${identifier}` : identifier;
}

function rustReadF64() {
  return `fn read_f64(inputs: &Value, key: &str) -> Result<f64, String> {
    inputs
        .get(key)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("input {key} must be a number"))
}`;
}

function rustReadU32() {
  return `fn read_u32(inputs: &Value, key: &str) -> Result<u32, String> {
    let value = inputs
        .get(key)
        .and_then(Value::as_u64)
        .ok_or_else(|| format!("input {key} must be an integer"))?;
    u32::try_from(value).map_err(|_| format!("input {key} is too large"))
}`;
}

function rustReadBool() {
  return `fn read_bool(inputs: &Value, key: &str) -> Result<bool, String> {
    inputs
        .get(key)
        .and_then(Value::as_bool)
        .ok_or_else(|| format!("input {key} must be a boolean"))
}`;
}

function rustReadString() {
  return `fn read_string(inputs: &Value, key: &str) -> Result<String, String> {
    inputs
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| format!("input {key} must be a string"))
}`;
}

function generatePrintlnMacro() {
  return `    macro_rules! println {
        () => {
            __stdout.push('\\n');
        };
        ($($arg:tt)*) => {{
            use std::fmt::Write as _;
            writeln!(&mut __stdout, $($arg)*).map_err(|error| error.to_string())?;
        }};
    }`;
}

function generateLinePlotMacro() {
  return `    macro_rules! emit_line_plot {
        ($points:expr, $x_label:expr, $y_label:expr) => {{
            __plots.push(PlotSpec::Line(LinePlotSpec {
                x_label: ($x_label).to_owned(),
                y_label: ($y_label).to_owned(),
                points: ($points)
                    .iter()
                    .map(|point| [f64::from(point.n), point.x])
                    .collect(),
            }));
        }};
    }`;
}

function indentRustSource(source) {
  return source
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function generateRustTest(cell) {
  const defaultInputs = Object.fromEntries(cell.inputs.map((input) => [input.name, input.value]));
  return `#[cfg(test)]
mod tests {
    use wasm_bindgen_test::wasm_bindgen_test;

    #[wasm_bindgen_test]
    fn first_generated_cell_runs() {
        let output = super::run_rust_cell(${JSON.stringify(cell.id)}, ${JSON.stringify(
          JSON.stringify(defaultInputs)
        )})
        .expect("generated Rust cell should run");

        assert!(
            output.contains("stdout"),
            "generated cell output should include stdout"
        );
    }
}`;
}

function generatedBanner() {
  return '// @generated by scripts/generate-doc-runtime.mjs. Do not edit by hand.\n';
}

function generatedTomlBanner() {
  return '# @generated by scripts/generate-doc-runtime.mjs. Do not edit by hand.\n';
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}
