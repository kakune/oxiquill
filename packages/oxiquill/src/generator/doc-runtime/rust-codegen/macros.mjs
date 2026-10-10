import { scanRustMacroInvocations } from './macro-invocations.mjs';
import { hasAnyMacro } from './capabilities.mjs';

const macroDescriptors = [
  [['println'], generatePrintlnMacro],
  [['emit_text'], generateTextMacro],
  [['emit_json'], generateJsonMacro],
  [['emit_html'], generateHtmlMacro],
  [['emit_image_svg', 'emit_svg'], generateImageSvgMacro],
  [['emit_image_png', 'emit_png_base64'], generateImagePngMacro],
  [['emit_svg'], generateSvgMacro],
  [['emit_png_base64'], generatePngBase64Macro],
  [['emit_table'], generateTableMacro],
  [['emit_table_with_columns'], generateTableWithColumnsMacro],
  [['emit_records_table'], generateRecordsTableMacro],
  [['emit_chart'], generateChartMacro],
  [['emit_line_chart'], () => generateXyChartMacro('line')],
  [['emit_scatter_chart'], () => generateXyChartMacro('scatter')],
  [['emit_area_chart'], () => generateXyChartMacro('area')],
  [['emit_bar_chart'], generateBarChartMacro],
  [['emit_histogram'], generateHistogramMacro],
  [['emit_heatmap'], generateHeatmapMacro],
  [['emit_line_plot'], generateLinePlotMacro]
];

export function generateRustPreludeMacros(source, macros = scanRustMacroInvocations(source)) {
  return macroDescriptors
    .filter(([tokens]) => hasAnyMacro(macros, tokens))
    .map(([, generate]) => generate())
    .join('\n\n');
}

function generatePrintlnMacro() {
  return `    macro_rules! println {
        () => {{
            use std::fmt::Write as _;
            writeln!(&mut *__stdout.borrow_mut()).map_err(|error| error.to_string())?;
        }};
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
                truncated: false,
            }));
        }};
    }`;
}

function generateJsonMacro() {
  return `    macro_rules! emit_json {
        ($value:expr) => {{
            let artifact = json_artifact(
                serde_json::to_value(&$value).map_err(|error| error.to_string())?,
            );
            __outputs.borrow_mut().push(OutputArtifact::Json(artifact));
        }};
    }`;
}

function generateHtmlMacro() {
  return `    macro_rules! emit_html {
        ($html:expr) => {{
            let artifact = html_artifact(($html).to_string());
            __outputs.borrow_mut().push(OutputArtifact::Html(artifact));
        }};
    }`;
}

function generateImageSvgMacro() {
  return `    macro_rules! emit_image_svg {
        ($svg:expr) => {{
            let artifact = image_artifact("image/svg+xml", ($svg).to_string(), None);
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
        ($svg:expr, $alt:expr) => {{
            let artifact = image_artifact(
                "image/svg+xml",
                ($svg).to_string(),
                Some(($alt).to_string()),
            );
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
    }`;
}

function generateImagePngMacro() {
  return `    macro_rules! emit_image_png {
        ($base64:expr) => {{
            let artifact = image_artifact("image/png", ($base64).to_string(), None);
            __outputs.borrow_mut().push(OutputArtifact::Image(artifact));
        }};
        ($base64:expr, $alt:expr) => {{
            let artifact = image_artifact(
                "image/png",
                ($base64).to_string(),
                Some(($alt).to_string()),
            );
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

function generateXyChartMacro(kind) {
  return `    macro_rules! emit_${kind}_chart {
        ($series:expr, options = $options:expr) => {{
            let mut spec = xy_chart_spec("${kind}", serde_json::to_value(&$series).map_err(|error| error.to_string())?, None, None)?;
            ${generateChartOptions()}
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
        ($series:expr$(, $style:expr)?) => {{
            let spec = xy_chart_spec(
                "${kind}",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                None,
                None,
            )?;
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
        ($series:expr, $x_label:expr, $y_label:expr$(, $style:expr)?) => {{
            let spec = xy_chart_spec(
                "${kind}",
                serde_json::to_value(&$series).map_err(|error| error.to_string())?,
                Some(($x_label).to_string()),
                Some(($y_label).to_string()),
            )?;
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
    }`;
}

function generateBarChartMacro() {
  return `    macro_rules! emit_bar_chart {
        ($categories:expr, $values:expr, options = $options:expr) => {{
            let mut spec = bar_chart_spec(serde_json::to_value(&$categories).map_err(|error| error.to_string())?, serde_json::to_value(&$values).map_err(|error| error.to_string())?)?;
            ${generateChartOptions()}
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
        ($categories:expr, $values:expr$(, $style:expr)?) => {{
            let spec = bar_chart_spec(
                serde_json::to_value(&$categories).map_err(|error| error.to_string())?,
                serde_json::to_value(&$values).map_err(|error| error.to_string())?,
            )?;
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
    }`;
}

function generateHistogramMacro() {
  return `    macro_rules! emit_histogram {
        ($bins:expr, options = $options:expr) => {{
            let mut spec = histogram_chart_spec(serde_json::to_value(&$bins).map_err(|error| error.to_string())?)?;
            ${generateChartOptions()}
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
        ($bins:expr$(, $style:expr)?) => {{
            let spec = histogram_chart_spec(
                serde_json::to_value(&$bins).map_err(|error| error.to_string())?,
            )?;
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
    }`;
}

function generateHeatmapMacro() {
  return `    macro_rules! emit_heatmap {
        ($data:expr$(, $style:expr)?) => {{
            let spec = heatmap_chart_spec(
                serde_json::to_value(&$data).map_err(|error| error.to_string())?,
            )?;
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
    }`;
}

function generateLinePlotMacro() {
  return `    macro_rules! emit_line_plot {
        ($points:expr, $x_label:expr, $y_label:expr$(, $style:expr)?) => {{
            let x_label = ($x_label).to_owned();
            let y_label = ($y_label).to_owned();
            let points: Vec<[f64; 2]> = ($points)
                .iter()
                .map(|point| [f64::from(point.n), point.x])
                .collect();
            let spec = serde_json::json!({
                    "kind": "line",
                    "xLabel": x_label,
                    "yLabel": y_label,
                    "xType": "value",
                    "yType": "value",
                    "tooltip": true,
                    "dataZoom": true,
                    "series": [{ "points": points }],
                });
            $(let spec = {
                let mut spec = spec;
                spec["style"] = serde_json::to_value(&$style).map_err(|error| error.to_string())?;
                spec
            };)?
            __outputs.borrow_mut().push(chart_artifact(spec, Value::Null));
        }};
    }`;
}

function generateChartOptions() {
  return `let options = serde_json::to_value(&$options).map_err(|error| error.to_string())?;
            let Value::Object(options) = options else {
                return Err("chart options must serialize as an object".to_owned());
            };
            for (key, value) in options {
                if !matches!(key.as_str(), "title" | "xLabel" | "yLabel" | "xType" | "yType" |
                    "legend" | "tooltip" | "dataZoom" | "style" | "xMin" | "xMax" | "yMin" |
                    "yMax" | "xIncludeZero" | "yIncludeZero") &&
                    !(key == "mode" && spec["kind"] == "histogram") {
                    return Err(format!("unsupported chart option: {key}"));
                }
                spec[key] = value;
            }`;
}

function generateChartMacro() {
  return `    macro_rules! emit_chart {
        ($spec:expr) => {{
            __outputs.borrow_mut().push(chart_artifact(
                serde_json::to_value(&$spec).map_err(|error| error.to_string())?,
                Value::Null,
            ));
        }};
        ($spec:expr, metadata = $metadata:expr) => {{
            __outputs.borrow_mut().push(chart_artifact(
                serde_json::to_value(&$spec).map_err(|error| error.to_string())?,
                serde_json::to_value(&$metadata).map_err(|error| error.to_string())?,
            ));
        }};
    }`;
}
