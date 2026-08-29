import { rustOutputCapabilities } from './capabilities.mjs';
import { generateRustChartHelpers } from './chart-helpers.mjs';

export function generateRustOutputTypes(rustCells) {
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
${
  capabilities.legacyPlot
    ? `#[derive(Debug, Serialize)]
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
`
    : `type PlotSpec = Value;
`
}
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

${
  capabilities.json
    ? `#[derive(Debug, Serialize)]
struct JsonArtifact {
    value: Value,
}

fn json_artifact(value: Value) -> JsonArtifact {
    JsonArtifact { value }
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
    let truncated = row_count > 10_000;
    let preview: Vec<Value> = rows.into_iter().take(10_000).collect();
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
    let truncated = row_count > 10_000;
    let preview: Vec<Value> = rows.into_iter().take(10_000).collect();
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
`;
}
