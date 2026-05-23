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
export const vendoredPyodidePackageRoots = ['matplotlib', 'pandas'];
export const supportedPyodidePackages = [
  'contourpy',
  'cycler',
  'fonttools',
  'kiwisolver',
  'matplotlib',
  'numpy',
  'packaging',
  'pandas',
  'pillow',
  'pyparsing',
  'python-dateutil',
  'pytz',
  'six'
];
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
  const unsupportedPackages = packages.filter((packageName) => !supportedPyodidePackages.includes(packageName));
  if (unsupportedPackages.length > 0) {
    throw new Error(
      `Python cell "${cellId}" in ${pagePath} specifies unsupported packages: ${unsupportedPackages.join(', ')}. ` +
        `Vendored packages: ${supportedPyodidePackages.join(', ')}.`
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

${firstCellTest}`;
}

function generateRustOutputTypes(rustCells) {
  if (rustCells.length === 0) return '';

  const capabilities = rustOutputCapabilities(rustCells);
  const outputVariants = [
    `    #[serde(rename = "text")]
    Text(TextArtifact),`,
    capabilities.json
      ? `    #[serde(rename = "json")]
    Json(JsonArtifact),`
      : '',
    capabilities.html
      ? `    #[serde(rename = "html")]
    Html(HtmlArtifact),`
      : '',
    capabilities.image
      ? `    #[serde(rename = "image")]
    Image(ImageArtifact),`
      : '',
    capabilities.table
      ? `    #[serde(rename = "table")]
    Table(TableArtifact),`
      : '',
    capabilities.chart
      ? `    #[serde(rename = "chart")]
    Chart(ChartArtifact),`
      : ''
  ]
    .filter(Boolean)
    .join('\n');

  return `
${capabilities.legacyPlot ? `#[derive(Debug, Serialize)]
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
` : `type PlotSpec = Value;
`}
#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum OutputArtifact {
${outputVariants}
}

#[derive(Debug, Serialize)]
struct TextArtifact {
    stream: &'static str,
    content: String,
}

${capabilities.json ? `#[derive(Debug, Serialize)]
struct JsonArtifact {
    value: Value,
}

fn json_artifact(value: Value) -> Result<JsonArtifact, String> {
    let byte_count = serde_json::to_string(&value)
        .map_err(|error| error.to_string())?
        .len();
    ensure_output_size("JSON output", byte_count, 500_000)?;
    Ok(JsonArtifact { value })
}
` : ''}
${capabilities.html ? `#[derive(Debug, Serialize)]
struct HtmlArtifact {
    html: String,
    sandboxed: bool,
}

fn html_artifact(html: String) -> Result<HtmlArtifact, String> {
    ensure_output_size("HTML output", html.len(), 500_000)?;
    Ok(HtmlArtifact {
        html,
        sandboxed: true,
    })
}
` : ''}
${capabilities.image ? `#[derive(Debug, Serialize)]
struct ImageArtifact {
    mime: &'static str,
    data: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    alt: Option<String>,
}

fn image_artifact(
    mime: &'static str,
    data: String,
    alt: Option<String>,
) -> Result<ImageArtifact, String> {
    ensure_output_size("image output", data.len(), 2_000_000)?;
    Ok(ImageArtifact { mime, data, alt })
}
` : ''}
${capabilities.json || capabilities.html || capabilities.image ? `fn ensure_output_size(
    label: &str,
    byte_count: usize,
    limit: usize,
) -> Result<(), String> {
    if byte_count > limit {
        Err(format!("{label} is {byte_count} bytes, exceeding the {limit} byte limit"))
    } else {
        Ok(())
    }
}
` : ''}
${capabilities.table ? `#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct TableArtifact {
    columns: Vec<TableColumn>,
    rows: Vec<Vec<Value>>,
    row_count: usize,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct TableColumn {
    key: String,
    label: String,
    #[serde(rename = "type")]
    column_type: &'static str,
}

fn table_artifact_from_value(value: Value) -> Result<TableArtifact, String> {
    let rows = match value {
        Value::Array(rows) => rows,
        _ => return Err("emit_table! expects a serializable array".to_owned()),
    };
    let row_count = rows.len();
    let truncated = row_count > 1_000;
    let preview: Vec<Value> = rows.into_iter().take(1_000).collect();
    let columns = infer_table_columns(&preview);
    let table_rows = table_rows_for_columns(preview, &columns);
    Ok(TableArtifact {
        columns,
        rows: table_rows,
        row_count,
        truncated,
    })
}

fn table_artifact_with_columns(columns: Value, rows: Value) -> Result<TableArtifact, String> {
    let columns = parse_table_columns(columns)?;
    let rows = match rows {
        Value::Array(rows) => rows,
        _ => return Err("emit_table_with_columns! expects rows to serialize as an array".to_owned()),
    };
    let row_count = rows.len();
    let truncated = row_count > 1_000;
    let preview: Vec<Value> = rows.into_iter().take(1_000).collect();
    let table_rows = table_rows_for_columns(preview, &columns);
    Ok(TableArtifact {
        columns,
        rows: table_rows,
        row_count,
        truncated,
    })
}

fn infer_table_columns(rows: &[Value]) -> Vec<TableColumn> {
    let Some(first) = rows.first() else {
        return Vec::new();
    };
    match first {
        Value::Object(object) => object
            .iter()
            .map(|(key, value)| TableColumn {
                key: key.clone(),
                label: key.clone(),
                column_type: table_value_type(value),
            })
            .collect(),
        Value::Array(values) => values
            .iter()
            .enumerate()
            .map(|(index, value)| TableColumn {
                key: index.to_string(),
                label: (index + 1).to_string(),
                column_type: table_value_type(value),
            })
            .collect(),
        value => vec![TableColumn {
            key: "value".to_owned(),
            label: "Value".to_owned(),
            column_type: table_value_type(value),
        }],
    }
}

fn parse_table_columns(value: Value) -> Result<Vec<TableColumn>, String> {
    let Value::Array(columns) = value else {
        return Err("table columns must serialize as an array".to_owned());
    };
    columns
        .into_iter()
        .enumerate()
        .map(|(index, column)| parse_table_column(index, column))
        .collect()
}

fn parse_table_column(index: usize, value: Value) -> Result<TableColumn, String> {
    match value {
        Value::String(label) => Ok(TableColumn {
            key: index.to_string(),
            label,
            column_type: "unknown",
        }),
        Value::Array(values) if values.len() >= 2 => {
            let key = values[0]
                .as_str()
                .ok_or_else(|| "table column tuple key must be a string".to_owned())?
                .to_owned();
            let label = values[1]
                .as_str()
                .ok_or_else(|| "table column tuple label must be a string".to_owned())?
                .to_owned();
            Ok(TableColumn {
                key,
                label,
                column_type: "unknown",
            })
        }
        Value::Object(object) => {
            let key = object
                .get("key")
                .and_then(Value::as_str)
                .ok_or_else(|| "table column object requires a string key".to_owned())?
                .to_owned();
            let label = object
                .get("label")
                .and_then(Value::as_str)
                .unwrap_or(&key)
                .to_owned();
            let column_type = object
                .get("type")
                .and_then(Value::as_str)
                .and_then(normalize_table_column_type)
                .unwrap_or("unknown");
            Ok(TableColumn {
                key,
                label,
                column_type,
            })
        }
        _ => Err("table column must be a string, tuple, or object".to_owned()),
    }
}

fn table_rows_for_columns(rows: Vec<Value>, columns: &[TableColumn]) -> Vec<Vec<Value>> {
    rows.into_iter()
        .map(|row| match row {
            Value::Object(object) => columns
                .iter()
                .map(|column| object.get(&column.key).cloned().unwrap_or(Value::Null))
                .collect(),
            Value::Array(values) => columns
                .iter()
                .enumerate()
                .map(|(index, column)| {
                    let value_index = column.key.parse::<usize>().unwrap_or(index);
                    values.get(value_index).cloned().unwrap_or(Value::Null)
                })
                .collect(),
            value => columns
                .iter()
                .enumerate()
                .map(|(index, _)| if index == 0 { value.clone() } else { Value::Null })
                .collect(),
        })
        .collect()
}

fn table_value_type(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(number) if number.is_i64() || number.is_u64() => "integer",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) | Value::Object(_) => "unknown",
    }
}

fn normalize_table_column_type(value: &str) -> Option<&'static str> {
    match value {
        "string" => Some("string"),
        "number" => Some("number"),
        "integer" => Some("integer"),
        "boolean" => Some("boolean"),
        "date" => Some("date"),
        "datetime" => Some("datetime"),
        "null" => Some("null"),
        "unknown" => Some("unknown"),
        _ => None,
    }
}
` : ''}
${capabilities.chart ? `#[derive(Debug, Serialize)]
struct ChartArtifact {
    spec: Value,
}

${generateRustChartHelpers(capabilities)}
` : ''}
#[derive(Debug, Serialize)]
struct CellOutput {
    stdout: String,
    plots: Vec<PlotSpec>,
    value: Value,
    outputs: Vec<OutputArtifact>,
}

fn finish_cell_output(
    stdout: String,
    plots: Vec<PlotSpec>,
    mut outputs: Vec<OutputArtifact>,
) -> CellOutput {
    if !stdout.is_empty() {
        outputs.insert(
            0,
            OutputArtifact::Text(TextArtifact {
                stream: "stdout",
                content: stdout.clone(),
            }),
        );
    }
    CellOutput {
        stdout,
        plots,
        value: Value::Null,
        outputs,
    }
}
`;
}

function rustOutputCapabilities(rustCells) {
  const source = rustCells.map((cell) => cell.source).join('\n');
  return {
    chart: source.includes('emit_line_plot!')
      || source.includes('emit_line_chart!')
      || source.includes('emit_scatter_chart!')
      || source.includes('emit_bar_chart!')
      || source.includes('emit_histogram!')
      || source.includes('emit_heatmap!'),
    legacyPlot: source.includes('emit_line_plot!'),
    lineChart: source.includes('emit_line_chart!'),
    scatterChart: source.includes('emit_scatter_chart!'),
    barChart: source.includes('emit_bar_chart!'),
    histogramChart: source.includes('emit_histogram!'),
    heatmapChart: source.includes('emit_heatmap!'),
    html: source.includes('emit_html!'),
    image: source.includes('emit_image_svg!')
      || source.includes('emit_image_png!')
      || source.includes('emit_svg!')
      || source.includes('emit_png_base64!'),
    json: source.includes('emit_json!'),
    table: source.includes('emit_table!')
      || source.includes('emit_table_with_columns!')
      || source.includes('emit_records_table!')
  };
}

function generateRustChartHelpers(capabilities) {
  return [
    capabilities.lineChart || capabilities.scatterChart
      ? `fn xy_chart_spec(
    kind: &'static str,
    series: Value,
    x_label: Option<String>,
    y_label: Option<String>,
) -> Result<Value, String> {
    let series = normalize_xy_series(series)?;
    let mut spec = serde_json::Map::new();
    spec.insert("kind".to_owned(), Value::String(kind.to_owned()));
    spec.insert("series".to_owned(), series);
    spec.insert("tooltip".to_owned(), Value::Bool(true));
    spec.insert("dataZoom".to_owned(), Value::Bool(true));
    spec.insert("xType".to_owned(), Value::String("value".to_owned()));
    spec.insert("yType".to_owned(), Value::String("value".to_owned()));
    if let Some(x_label) = x_label {
        spec.insert("xLabel".to_owned(), Value::String(x_label));
    }
    if let Some(y_label) = y_label {
        spec.insert("yLabel".to_owned(), Value::String(y_label));
    }
    Ok(Value::Object(spec))
}

fn normalize_xy_series(value: Value) -> Result<Value, String> {
    let Value::Array(items) = value else {
        return Err("xy chart series must serialize as an array".to_owned());
    };
    let Some(first) = items.first() else {
        return Ok(Value::Array(Vec::new()));
    };
    if first.is_array() {
        return Ok(serde_json::json!([{ "points": items }]));
    }
    if first
        .as_object()
        .and_then(|object| object.get("points"))
        .is_some()
    {
        return Ok(Value::Array(items));
    }
    Err("xy chart series must be points or objects with points".to_owned())
}
`
      : '',
    capabilities.barChart
      ? `fn bar_chart_spec(categories: Value, series: Value) -> Result<Value, String> {
    let categories = normalize_string_array(categories, "bar chart categories")?;
    let series = normalize_bar_series(series)?;
    Ok(serde_json::json!({
        "kind": "bar",
        "categories": categories,
        "series": series,
        "tooltip": true
    }))
}

fn normalize_bar_series(value: Value) -> Result<Value, String> {
    let Value::Array(items) = value else {
        return Err("bar chart values must serialize as an array".to_owned());
    };
    let Some(first) = items.first() else {
        return Ok(serde_json::json!([{ "values": [] }]));
    };
    if first.is_number() || first.is_null() {
        return Ok(serde_json::json!([{ "values": items }]));
    }
    if first
        .as_object()
        .and_then(|object| object.get("values"))
        .is_some()
    {
        return Ok(Value::Array(items));
    }
    Err("bar chart values must be numbers or objects with values".to_owned())
}

fn normalize_string_array(value: Value, label: &str) -> Result<Vec<String>, String> {
    let Value::Array(values) = value else {
        return Err(format!("{label} must serialize as an array"));
    };
    values
        .into_iter()
        .map(|value| match value {
            Value::String(value) => Ok(value),
            value => Ok(value.to_string()),
        })
        .collect()
}
`
      : '',
    capabilities.histogramChart
      ? `fn histogram_chart_spec(bins: Value) -> Result<Value, String> {
    match bins {
        value @ Value::Array(_) => Ok(serde_json::json!({
            "kind": "histogram",
            "bins": value,
            "tooltip": true
        })),
        _ => Err("histogram bins must serialize as an array".to_owned()),
    }
}
`
      : '',
    capabilities.heatmapChart
      ? `fn heatmap_chart_spec(data: Value) -> Result<Value, String> {
    match data {
        value @ Value::Array(_) => Ok(serde_json::json!({
            "kind": "heatmap",
            "data": value,
            "tooltip": true
        })),
        _ => Err("heatmap data must serialize as an array".to_owned()),
    }
}
`
      : ''
  ]
    .filter(Boolean)
    .join('\n');
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
  const macros = generateRustPreludeMacros(cell.source);
  const inputsParameter = cell.inputs.length > 0 ? 'inputs' : '_inputs';

  return `fn ${rustFunctionName(cell.id)}(${inputsParameter}: &Value) -> Result<CellOutput, String> {
${inputBindings ? `${inputBindings}\n` : ''}    let __stdout = std::cell::RefCell::new(String::new());
    let __plots = std::cell::RefCell::new(Vec::new());
    let __outputs = std::cell::RefCell::new(Vec::new());
${macros ? `\n${macros}\n` : ''}

${escapedSource}

    Ok(finish_cell_output(
        __stdout.into_inner(),
        __plots.into_inner(),
        __outputs.into_inner(),
    ))
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

function generateRustPreludeMacros(source) {
  return [
    source.includes('println!') ? generatePrintlnMacro() : '',
    source.includes('emit_text!') ? generateTextMacro() : '',
    source.includes('emit_json!') ? generateJsonMacro() : '',
    source.includes('emit_html!') ? generateHtmlMacro() : '',
    source.includes('emit_image_svg!') || source.includes('emit_svg!') ? generateImageSvgMacro() : '',
    source.includes('emit_image_png!') || source.includes('emit_png_base64!') ? generateImagePngMacro() : '',
    source.includes('emit_svg!') ? generateSvgMacro() : '',
    source.includes('emit_png_base64!') ? generatePngBase64Macro() : '',
    source.includes('emit_table!') ? generateTableMacro() : '',
    source.includes('emit_table_with_columns!') ? generateTableWithColumnsMacro() : '',
    source.includes('emit_records_table!') ? generateRecordsTableMacro() : '',
    source.includes('emit_line_chart!') ? generateLineChartMacro() : '',
    source.includes('emit_scatter_chart!') ? generateScatterChartMacro() : '',
    source.includes('emit_bar_chart!') ? generateBarChartMacro() : '',
    source.includes('emit_histogram!') ? generateHistogramMacro() : '',
    source.includes('emit_heatmap!') ? generateHeatmapMacro() : '',
    source.includes('emit_line_plot!') ? generateLinePlotMacro() : ''
  ]
    .filter(Boolean)
    .join('\n\n');
}

function generatePrintlnMacro() {
  return `    macro_rules! println {
        () => {
            __stdout.borrow_mut().push('\\n');
        };
        ($($arg:tt)*) => {{
            use std::fmt::Write as _;
            let mut stdout = __stdout.borrow_mut();
            writeln!(&mut *stdout, $($arg)*).map_err(|error| error.to_string())?;
        }};
    }`;
}

function generateTextMacro() {
  return `    macro_rules! emit_text {
        ($content:expr) => {{
            __outputs.borrow_mut().push(OutputArtifact::Text(TextArtifact {
                stream: "display",
                content: ($content).to_string(),
            }));
        }};
    }`;
}

function generateJsonMacro() {
  return `    macro_rules! emit_json {
        ($value:expr) => {{
            let artifact = json_artifact(
                serde_json::to_value(&$value).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Json(artifact));
        }};
    }`;
}

function generateHtmlMacro() {
  return `    macro_rules! emit_html {
        ($html:expr) => {{
            let artifact = html_artifact(($html).to_string())?;
            __outputs.borrow_mut().push(OutputArtifact::Html(artifact));
        }};
    }`;
}

function generateImageSvgMacro() {
  return `    macro_rules! emit_image_svg {
        ($svg:expr) => {{
            let artifact = image_artifact("image/svg+xml", ($svg).to_string(), None)?;
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
        ($svg:expr, $alt:expr) => {{
            let artifact = image_artifact(
                "image/svg+xml",
                ($svg).to_string(),
                Some(($alt).to_string()),
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
    }`;
}

function generateImagePngMacro() {
  return `    macro_rules! emit_image_png {
        ($base64:expr) => {{
            let artifact = image_artifact("image/png", ($base64).to_string(), None)?;
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
        ($base64:expr, $alt:expr) => {{
            let artifact = image_artifact(
                "image/png",
                ($base64).to_string(),
                Some(($alt).to_string()),
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
    }`;
}

function generateSvgMacro() {
  return `    macro_rules! emit_svg {
        ($svg:expr) => {{
            emit_image_svg!($svg);
        }};
        ($svg:expr, $alt:expr) => {{
            emit_image_svg!($svg, $alt);
        }};
    }`;
}

function generatePngBase64Macro() {
  return `    macro_rules! emit_png_base64 {
        ($base64:expr) => {{
            emit_image_png!($base64);
        }};
        ($base64:expr, $alt:expr) => {{
            emit_image_png!($base64, $alt);
        }};
    }`;
}

function generateTableMacro() {
  return `    macro_rules! emit_table {
        ($rows:expr) => {{
            let artifact = table_artifact_from_value(
                serde_json::to_value(&$rows).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Table(artifact));
        }};
    }`;
}

function generateTableWithColumnsMacro() {
  return `    macro_rules! emit_table_with_columns {
        ($columns:expr, $rows:expr) => {{
            let artifact = table_artifact_with_columns(
                serde_json::to_value(&$columns).map_err(|error| error.to_string())?,
                serde_json::to_value(&$rows).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Table(artifact));
        }};
    }`;
}

function generateRecordsTableMacro() {
  return `    macro_rules! emit_records_table {
        ($records:expr) => {{
            let artifact = table_artifact_from_value(
                serde_json::to_value(&$records).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Table(artifact));
        }};
    }`;
}

function generateLineChartMacro() {
  return `    macro_rules! emit_line_chart {
        ($series:expr) => {{
            let spec = xy_chart_spec(
                "line",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                None,
                None,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
        ($series:expr, $x_label:expr, $y_label:expr) => {{
            let spec = xy_chart_spec(
                "line",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                Some(($x_label).to_string()),
                Some(($y_label).to_string()),
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
    }`;
}

function generateScatterChartMacro() {
  return `    macro_rules! emit_scatter_chart {
        ($series:expr) => {{
            let spec = xy_chart_spec(
                "scatter",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                None,
                None,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
        ($series:expr, $x_label:expr, $y_label:expr) => {{
            let spec = xy_chart_spec(
                "scatter",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                Some(($x_label).to_string()),
                Some(($y_label).to_string()),
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
    }`;
}

function generateBarChartMacro() {
  return `    macro_rules! emit_bar_chart {
        ($categories:expr, $values:expr) => {{
            let spec = bar_chart_spec(
                serde_json::to_value(&$categories).map_err(|error| error.to_string())?,
                serde_json::to_value(&$values).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
    }`;
}

function generateHistogramMacro() {
  return `    macro_rules! emit_histogram {
        ($bins:expr) => {{
            let spec = histogram_chart_spec(
                serde_json::to_value(&$bins).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
    }`;
}

function generateHeatmapMacro() {
  return `    macro_rules! emit_heatmap {
        ($data:expr) => {{
            let spec = heatmap_chart_spec(
                serde_json::to_value(&$data).map_err(|error| error.to_string())?,
            )?;
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact { spec }));
        }};
    }`;
}

function generateLinePlotMacro() {
  return `    macro_rules! emit_line_plot {
        ($points:expr, $x_label:expr, $y_label:expr) => {{
            let x_label = ($x_label).to_owned();
            let y_label = ($y_label).to_owned();
            let points: Vec<[f64; 2]> = ($points)
                .iter()
                .map(|point| [f64::from(point.n), point.x])
                .collect();
            __plots.borrow_mut().push(PlotSpec::Line(LinePlotSpec {
                x_label: x_label.clone(),
                y_label: y_label.clone(),
                points: points.clone(),
            }));
            __outputs.borrow_mut().push(OutputArtifact::Chart(ChartArtifact {
                spec: serde_json::json!({
                    "kind": "line",
                    "xLabel": x_label,
                    "yLabel": y_label,
                    "xType": "value",
                    "yType": "value",
                    "tooltip": true,
                    "dataZoom": true,
                    "series": [{ "points": points }],
                }),
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
