import { outputArtifactLimits } from '../../../lib/doc-runtime/output-limits.mjs';

export function generateRustChartHelpers(capabilities) {
  return [
    generateChartArtifactHelper(),
    generateChartLimitHelper(),
    capabilities.lineChart || capabilities.scatterChart || capabilities.areaChart ? generateXyChartHelpers() : '',
    capabilities.barChart ? generateBarChartHelpers() : '',
    capabilities.histogramChart ? generateHistogramChartHelper() : '',
    capabilities.heatmapChart ? generateHeatmapChartHelper() : ''
  ]
    .filter(Boolean)
    .join('\n');
}

function generateXyChartHelpers() {
  return `fn xy_chart_spec(
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
    let spec = Value::Object(spec);
    Ok(spec)
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
`;
}

function generateBarChartHelpers() {
  return `fn bar_chart_spec(categories: Value, series: Value) -> Result<Value, String> {
    let categories = normalize_string_array(categories, "bar chart categories")?;
    let series = normalize_bar_series(series)?;
    let spec = serde_json::json!({
        "kind": "bar",
        "categories": categories,
        "series": series,
        "tooltip": true
    });
    Ok(spec)
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
`;
}

function generateHistogramChartHelper() {
  return `fn histogram_chart_spec(bins: Value) -> Result<Value, String> {
    match bins {
        value @ Value::Array(_) => {
            let spec = serde_json::json!({
                "kind": "histogram",
                "bins": value,
                "tooltip": true
            });
            Ok(spec)
        }
        _ => Err("histogram bins must serialize as an array".to_owned()),
    }
}
`;
}

function generateHeatmapChartHelper() {
  return `fn heatmap_chart_spec(data: Value) -> Result<Value, String> {
    match data {
        value @ Value::Array(_) => {
            let spec = serde_json::json!({
                "kind": "heatmap",
                "data": value,
                "tooltip": true
            });
            Ok(spec)
        }
        _ => Err("heatmap data must serialize as an array".to_owned()),
    }
}
`;
}

function generateChartLimitHelper() {
  return `fn ensure_chart_data_limit(spec: &Value) -> Result<(), String> {
    let kind = spec.get("kind").and_then(Value::as_str).unwrap_or_default();
    let data_items = match kind {
        "line" | "scatter" | "area" => spec
            .get("series")
            .and_then(Value::as_array)
            .map(|series| {
                series
                    .iter()
                    .map(|item| {
                        item.get("points")
                            .and_then(Value::as_array)
                            .map(|points| points.len().max(1))
                            .unwrap_or(1)
                    })
                    .sum()
            })
            .unwrap_or(0),
        "bar" => spec
            .get("series")
            .and_then(Value::as_array)
            .map(|series| {
                series
                    .iter()
                    .map(|item| item.get("values").and_then(Value::as_array).map(Vec::len).unwrap_or(0))
                    .sum()
            })
            .unwrap_or(0),
        "histogram" => spec.get("bins").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        "heatmap" => spec.get("data").and_then(Value::as_array).map(Vec::len).unwrap_or(0),
        _ => 0,
    };
    let category_items = ["categories", "xCategories", "yCategories", "series"]
        .iter()
        .filter_map(|key| spec.get(*key).and_then(Value::as_array))
        .map(Vec::len)
        .max()
        .unwrap_or(0);
    if data_items > ${outputArtifactLimits.chartDataItems} || category_items > ${outputArtifactLimits.chartDataItems} {
        return Err(format!(
            "Chart contains {} data items; maximum is {}.",
            data_items.max(category_items),
            ${outputArtifactLimits.chartDataItems}
        ));
    }
    Ok(())
}
`;
}

function generateChartArtifactHelper() {
  return `fn chart_artifact(spec: Value, metadata: Value) -> OutputArtifact {
    if let Err(error) = ensure_chart_data_limit(&spec) {
        return producer_error(&error);
    }
    let metadata = match metadata {
        Value::Null => serde_json::Map::new(),
        Value::Object(metadata) => metadata,
        _ => return producer_error("chart metadata must serialize as an object"),
    };
    if let Some(key) = metadata
        .keys()
        .find(|key| !matches!(key.as_str(), "id" | "title" | "caption"))
    {
        return producer_error(&format!("unsupported chart metadata field: {key}"));
    }
    let field = |key: &str| metadata.get(key).filter(|value| !value.is_null()).cloned();
    OutputArtifact::Chart(ChartArtifact {
        spec,
        id: field("id"),
        title: field("title"),
        caption: field("caption"),
    })
}
`;
}
