import { rustOutputCapabilities } from './capabilities.mjs';
import { generateRustChartHelpers } from './chart-helpers.mjs';
import { outputArtifactLimits } from '../../../lib/doc-runtime/output-limits.mjs';

export function generateRustOutputTypes(rustCells) {
  if (rustCells.length === 0) return '';

  const capabilities = rustOutputCapabilities(rustCells);
  const outputVariants = [
    `    #[serde(rename = "__oxiquill_error")]
    ProducerError(ProducerErrorArtifact),`,
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
type PlotSpec = Value;

#[derive(Debug, Serialize)]
#[serde(tag = "kind")]
enum OutputArtifact {
${outputVariants}
}

#[derive(Debug, Serialize)]
struct TextArtifact {
    stream: &'static str,
    content: String,
    truncated: bool,
}

#[derive(Debug, Serialize)]
struct ProducerErrorArtifact {
    message: String,
}

struct BoundedText {
    content: String,
    truncated: bool,
}

impl BoundedText {
    fn new() -> Self {
        Self {
            content: String::new(),
            truncated: false,
        }
    }
}

impl std::fmt::Write for BoundedText {
    fn write_str(&mut self, value: &str) -> std::fmt::Result {
        if self.truncated {
            return Ok(());
        }
        let remaining = ${outputArtifactLimits.bytesPerStream}_usize.saturating_sub(self.content.len());
        if value.len() <= remaining {
            self.content.push_str(value);
            return Ok(());
        }
        push_truncated(&mut self.content, value, remaining);
        self.truncated = true;
        Ok(())
    }
}

struct OutputCollector {
    byte_length: usize,
    omitted: bool,
    outputs: Vec<OutputArtifact>,
}

impl OutputCollector {
    fn new() -> Self {
        Self {
            byte_length: 0,
            omitted: false,
            outputs: Vec::new(),
        }
    }

    fn push(&mut self, artifact: OutputArtifact) {
        if self.outputs.len() >= ${outputArtifactLimits.artifactsPerRun} {
            self.omitted = true;
            return;
        }
        let artifact = bound_output_artifact(artifact);
        let Ok(serialized) = serde_json::to_string(&artifact) else {
            self.omitted = true;
            return;
        };
        if serialized.len() > ${outputArtifactLimits.validatedBytesPerRun}_usize.saturating_sub(self.byte_length) {
            self.omitted = true;
            return;
        }
        self.byte_length += serialized.len();
        self.outputs.push(artifact);
    }

    fn finish(mut self) -> Vec<OutputArtifact> {
        if self.omitted {
            self.outputs.truncate(${outputArtifactLimits.artifactsPerRun - 1});
            self.outputs.push(producer_error("Rust output exceeded its artifact or byte limit"));
        }
        self.outputs
    }
}

fn bound_output_artifact(mut artifact: OutputArtifact) -> OutputArtifact {
    match &mut artifact {
        OutputArtifact::Text(text) => {
            text.truncated |= truncate_string(&mut text.content, ${outputArtifactLimits.bytesPerTextJsonOrHtml});
        }
        OutputArtifact::Json(json) => {
            let oversized = serde_json::to_string(&json.value)
                .map(|serialized| serialized.len() > ${outputArtifactLimits.bytesPerTextJsonOrHtml})
                .unwrap_or(true);
            if oversized {
                json.value = Value::String("[Truncated]".to_owned());
                json.truncated = true;
            }
        }
        OutputArtifact::Html(html) if html.html.len() > ${outputArtifactLimits.bytesPerTextJsonOrHtml} => {
            return producer_error("Rust HTML output exceeded the per-artifact byte limit");
        }
        OutputArtifact::Image(image) if image.data.len() > ${Math.ceil((outputArtifactLimits.decodedBytesPerImage * 4) / 3) + 4} => {
            return producer_error("Rust image output exceeded the per-artifact byte limit");
        }
        _ => {}
    }
    artifact
}

fn producer_error(message: &str) -> OutputArtifact {
    OutputArtifact::ProducerError(ProducerErrorArtifact {
        message: bounded_error_message(message),
    })
}

fn bounded_error_message(message: &str) -> String {
    let mut bounded = String::new();
    push_truncated(&mut bounded, message, ${outputArtifactLimits.bytesPerError});
    bounded
}

fn truncate_string(value: &mut String, max_bytes: usize) -> bool {
    if value.len() <= max_bytes {
        return false;
    }
    let original = std::mem::take(value);
    push_truncated(value, &original, max_bytes);
    true
}

fn push_truncated(output: &mut String, value: &str, max_bytes: usize) {
    if value.len() <= max_bytes {
        output.push_str(value);
        return;
    }
    let marker = '…';
    let marker_bytes = marker.len_utf8();
    if max_bytes < marker_bytes {
        return;
    }
    let mut end = max_bytes - marker_bytes;
    while !value.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    output.push_str(&value[..end]);
    output.push(marker);
}

${
  capabilities.json
    ? `#[derive(Debug, Serialize)]
struct JsonArtifact {
    value: Value,
    truncated: bool,
}

fn json_artifact(value: Value) -> JsonArtifact {
    JsonArtifact { value, truncated: false }
}
`
    : ''
}
${
  capabilities.html
    ? `#[derive(Debug, Serialize)]
struct HtmlArtifact {
    html: String,
    sandboxed: bool,
}

fn html_artifact(html: String) -> HtmlArtifact {
    HtmlArtifact {
        html,
        sandboxed: true,
    }
}
`
    : ''
}
${
  capabilities.image
    ? `#[derive(Debug, Serialize)]
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
) -> ImageArtifact {
    ImageArtifact { mime, data, alt }
}
`
    : ''
}
${capabilities.table ? generateRustTableTypes() : ''}
${
  capabilities.chart
    ? `#[derive(Debug, Serialize)]
struct ChartArtifact {
    spec: Value,
}

${generateRustChartHelpers(capabilities)}
`
    : ''
}
#[derive(Debug, Serialize)]
struct CellOutput {
    stdout: String,
    plots: Vec<PlotSpec>,
    value: Value,
    outputs: Vec<OutputArtifact>,
}

fn finish_cell_output(
    stdout: BoundedText,
    outputs: OutputCollector,
) -> CellOutput {
    let BoundedText { content: stdout, truncated } = stdout;
    let mut outputs = outputs.finish();
    if !stdout.is_empty() {
        outputs.insert(
            0,
            OutputArtifact::Text(TextArtifact {
                stream: "stdout",
                content: stdout.clone(),
                truncated,
            }),
        );
        outputs.truncate(${outputArtifactLimits.artifactsPerRun});
    }
    CellOutput {
        stdout,
        plots: Vec::new(),
        value: Value::Null,
        outputs,
    }
}

fn serialize_cell_output(mut output: CellOutput) -> Result<String, String> {
    let mut omitted = false;
    loop {
        let serialized = serde_json::to_string(&output).map_err(|error| bounded_error_message(&error.to_string()))?;
        if serialized.len() <= ${outputArtifactLimits.workerResponseBytes} {
            if omitted && output.outputs.len() < ${outputArtifactLimits.artifactsPerRun} {
                output.outputs.push(producer_error("Rust response exceeded the complete response byte limit"));
                let with_diagnostic = serde_json::to_string(&output)
                    .map_err(|error| bounded_error_message(&error.to_string()))?;
                if with_diagnostic.len() <= ${outputArtifactLimits.workerResponseBytes} {
                    return Ok(with_diagnostic);
                }
                output.outputs.pop();
            }
            return Ok(serialized);
        }
        if output.outputs.pop().is_none() {
            return Err("Rust response exceeded the complete response byte limit".to_owned());
        }
        omitted = true;
    }
}
`;
}

function generateRustTableTypes() {
  return `#[derive(Debug, Serialize)]
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
    let truncated = row_count > ${outputArtifactLimits.rowsPerTable};
    let preview: Vec<Value> = rows.into_iter().take(${outputArtifactLimits.rowsPerTable}).collect();
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
    let truncated = row_count > ${outputArtifactLimits.rowsPerTable};
    let preview: Vec<Value> = rows.into_iter().take(${outputArtifactLimits.rowsPerTable}).collect();
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
            .take(${outputArtifactLimits.columnsPerTable})
            .map(|(key, value)| TableColumn {
                key: key.clone(),
                label: key.clone(),
                column_type: table_value_type(value),
            })
            .collect(),
        Value::Array(values) => values
            .iter()
            .take(${outputArtifactLimits.columnsPerTable})
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
        .take(${outputArtifactLimits.columnsPerTable})
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
`;
}
