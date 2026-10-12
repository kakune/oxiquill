import { outputArtifactLimits } from './output-limits.mjs';
import { chartPalette } from './chart-palette.js';

const pythonDisplayJsonAndScalarSupport = String.raw`
import base64
import builtins
import datetime
import io
from itertools import islice
import json
import math
import os
import sys
import warnings

__oxiquill_outputs = []
__oxiquill_displayed_figures = set()
__oxiquill_table_limit = ${outputArtifactLimits.rowsPerTable}
__oxiquill_table_column_limit = ${outputArtifactLimits.columnsPerTable}
__oxiquill_artifact_limit = ${outputArtifactLimits.artifactsPerRun}
__oxiquill_output_byte_limit = ${outputArtifactLimits.validatedBytesPerRun}
__oxiquill_diagnostic_byte_limit = ${outputArtifactLimits.bytesPerDiagnostic}
__oxiquill_image_byte_limit = ${outputArtifactLimits.decodedBytesPerImage}
__oxiquill_metadata_byte_limit = ${outputArtifactLimits.bytesPerMetadataField}
__oxiquill_chart_limit = ${outputArtifactLimits.chartDataItems}
__oxiquill_output_bytes = 0
__oxiquill_output_omission = None

def __oxiquill_bound_text(value, max_bytes):
    text = str(value)
    encoded = text.encode("utf-8")
    if len(encoded) <= max_bytes:
        return text
    marker = "…"
    prefix = encoded[:max(0, max_bytes - len(marker.encode("utf-8")))]
    return prefix.decode("utf-8", errors="ignore") + marker

def __oxiquill_error_artifact(message):
    return {
        "kind": "__oxiquill_error",
        "message": __oxiquill_bound_text(message, __oxiquill_diagnostic_byte_limit),
    }

def __oxiquill_append_output(artifact, *, json_snapshot=False):
    global __oxiquill_output_bytes, __oxiquill_output_omission
    if len(__oxiquill_outputs) >= __oxiquill_artifact_limit:
        __oxiquill_output_omission = "Python output exceeded the artifact count limit."
        return
    try:
        serialized = json.dumps(artifact, ensure_ascii=False, separators=(",", ":"))
    except Exception as error:
        artifact = __oxiquill_error_artifact(f"Python output could not be serialized: {error}")
        serialized = json.dumps(artifact, ensure_ascii=False, separators=(",", ":"))
    artifact_bytes = len(serialized.encode("utf-8"))
    if artifact_bytes > __oxiquill_output_byte_limit - __oxiquill_output_bytes:
        __oxiquill_output_omission = "Python output exceeded the cumulative artifact byte limit."
        return
    if json_snapshot:
        from js import JSON
        # Pyodide maps Python None to undefined; JSON preserves nullable bar values.
        artifact = JSON.parse(serialized)
    __oxiquill_outputs.append(artifact)
    __oxiquill_output_bytes += artifact_bytes

def __oxiquill_meta(artifact, title=None, caption=None):
    if title is not None:
        artifact["title"] = str(title)
    if caption is not None:
        artifact["caption"] = str(caption)
    return artifact

def __oxiquill_jsonable(value):
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, (list, tuple)):
        return [__oxiquill_jsonable(item) for item in value]
    if isinstance(value, dict):
        return {str(key): __oxiquill_jsonable(item) for key, item in value.items()}
    return str(value)

def __oxiquill_json_artifact(value, title=None, caption=None):
    json_value = __oxiquill_jsonable(value)
    json.dumps(json_value)
    return __oxiquill_meta({"kind": "json", "value": json_value}, title, caption)

def __oxiquill_scalar_value(value):
    try:
        pd = sys.modules.get("pandas")
        is_missing = pd.isna(value) if pd is not None else False
        try:
            if bool(is_missing):
                return None
        except Exception:
            pass
    except Exception:
        pass
    item = getattr(value, "item", None)
    if callable(item):
        try:
            value = item()
        except Exception:
            pass
    isoformat = getattr(value, "isoformat", None)
    if callable(isoformat):
        try:
            return isoformat()
        except Exception:
            pass
    return __oxiquill_jsonable(value)
`;

const pythonDisplayTableSupport = String.raw`
def __oxiquill_column_key(label, used_keys):
    base = str(label) or "column"
    key = base
    counter = 2
    while key in used_keys:
        key = f"{base}_{counter}"
        counter += 1
    used_keys.add(key)
    return key

def __oxiquill_dtype_name(dtype):
    name = str(dtype)
    lower = name.lower()
    if lower in ("bool", "boolean"):
        return "boolean"
    if lower.startswith("int") or lower.startswith("uint") or lower in ("int64", "int32", "int16", "int8"):
        return "integer"
    if lower.startswith("float") or lower in ("float64", "float32"):
        return "number"
    if "datetime" in lower or "timestamp" in lower:
        return "datetime"
    if lower in ("string", "str"):
        return "string"
    if lower == "object":
        return "unknown"
    return "unknown"

def __oxiquill_is_default_range_index(index):
    return (
        index.__class__.__name__ == "RangeIndex"
        and getattr(index, "name", None) is None
        and getattr(index, "start", None) == 0
        and getattr(index, "step", None) == 1
    )

def __oxiquill_should_include_index(index, include_index=None):
    if include_index is not None:
        return bool(include_index)
    return not __oxiquill_is_default_range_index(index)

def __oxiquill_is_pandas_dataframe(value):
    cls = value.__class__
    module = getattr(cls, "__module__", "")
    return cls.__name__ == "DataFrame" and (module == "pandas" or module.startswith("pandas."))

def __oxiquill_is_pandas_series(value):
    cls = value.__class__
    module = getattr(cls, "__module__", "")
    return cls.__name__ == "Series" and (module == "pandas" or module.startswith("pandas."))

def __oxiquill_pandas_dataframe_artifact(
    dataframe,
    *,
    title=None,
    caption=None,
    max_rows=__oxiquill_table_limit,
    max_columns=__oxiquill_table_column_limit,
    include_index=None,
):
    row_count = int(len(dataframe))
    include_index_column = __oxiquill_should_include_index(dataframe.index, include_index)
    data_column_limit = max(0, max_columns - int(include_index_column))
    truncated_rows = row_count > max_rows
    truncated_columns = len(dataframe.columns) > data_column_limit
    preview = dataframe.iloc[:max_rows, :data_column_limit]
    used_keys = set()
    columns = []
    if include_index_column:
        columns.append({
            "key": __oxiquill_column_key("__index__", used_keys),
            "label": str(getattr(dataframe.index, "name", None) or "index"),
            "type": __oxiquill_dtype_name(getattr(dataframe.index, "dtype", "unknown")),
        })
    for column_index, label in enumerate(preview.columns):
        columns.append({
            "key": __oxiquill_column_key(label, used_keys),
            "label": str(label),
            "type": __oxiquill_dtype_name(preview.dtypes.iloc[column_index]),
        })
    rows = []
    for row_index, values in enumerate(preview.itertuples(index=False, name=None)):
        row = []
        if include_index_column:
            row.append(__oxiquill_scalar_value(preview.index[row_index]))
        row.extend(__oxiquill_scalar_value(value) for value in values)
        rows.append(row)
    return __oxiquill_meta({
        "kind": "table",
        "columns": columns,
        "rows": rows,
        "rowCount": row_count,
        "truncated": truncated_rows or truncated_columns,
    }, title, caption)

def __oxiquill_pandas_series_artifact(
    series,
    *,
    title=None,
    caption=None,
    max_rows=__oxiquill_table_limit,
    include_index=None,
):
    row_count = int(len(series))
    preview = series.iloc[:max_rows]
    truncated = row_count > max_rows
    include_index_column = __oxiquill_should_include_index(series.index, include_index)
    used_keys = set()
    columns = []
    if include_index_column:
        columns.append({
            "key": __oxiquill_column_key("__index__", used_keys),
            "label": str(getattr(series.index, "name", None) or "index"),
            "type": __oxiquill_dtype_name(getattr(series.index, "dtype", "unknown")),
        })
    value_label = str(series.name) if series.name is not None else "value"
    columns.append({
        "key": __oxiquill_column_key(value_label, used_keys),
        "label": value_label,
        "type": __oxiquill_dtype_name(getattr(series, "dtype", "unknown")),
    })
    rows = []
    for row_index, value in enumerate(preview):
        row = []
        if include_index_column:
            row.append(__oxiquill_scalar_value(preview.index[row_index]))
        row.append(__oxiquill_scalar_value(value))
        rows.append(row)
    return __oxiquill_meta({
        "kind": "table",
        "columns": columns,
        "rows": rows,
        "rowCount": row_count,
        "truncated": truncated,
    }, title, caption)

def __oxiquill_dataframe_artifact(value, *, title=None, caption=None):
    try:
        if __oxiquill_is_pandas_dataframe(value):
            return __oxiquill_pandas_dataframe_artifact(value, title=title, caption=caption)
        if __oxiquill_is_pandas_series(value):
            return __oxiquill_pandas_series_artifact(value, title=title, caption=caption)
    except Exception as error:
        return __oxiquill_meta({
            "kind": "text",
            "stream": "stderr",
            "content": f"Failed to convert dataframe output: {error}",
        }, title, caption)
    return None
`;

const pythonDisplayMimeSupport = String.raw`
def __oxiquill_image_data(data):
    if isinstance(data, bytes):
        return base64.b64encode(data).decode("ascii")
    return str(data)

def __oxiquill_extract_repr_payload(value):
    if isinstance(value, tuple) and len(value) > 0:
        return value[0]
    return value

def __oxiquill_text_artifact(content, *, title=None, caption=None):
    return __oxiquill_meta(
        {"kind": "text", "stream": "display", "content": str(content)},
        title,
        caption,
    )

def __oxiquill_mimebundle_artifact(value, *, title=None, caption=None):
    method = getattr(value, "_repr_mimebundle_", None)
    if not callable(method):
        return None
    try:
        bundle = __oxiquill_extract_repr_payload(method(include=None, exclude=None))
    except TypeError:
        bundle = __oxiquill_extract_repr_payload(method())
    except Exception as error:
        return __oxiquill_text_artifact(f"Failed to render MIME bundle: {error}", title=title, caption=caption)
    if not isinstance(bundle, dict):
        return __oxiquill_text_artifact(bundle, title=title, caption=caption)
    return __oxiquill_artifact_from_mimebundle(bundle, title=title, caption=caption)

def __oxiquill_artifact_from_mimebundle(bundle, *, title=None, caption=None):
    html = bundle.get("text/html")
    if html:
        return __oxiquill_meta({"kind": "html", "html": str(html), "sandboxed": True}, title, caption)
    svg = bundle.get("image/svg+xml")
    if svg:
        return __oxiquill_meta(
            {"kind": "image", "mime": "image/svg+xml", "data": __oxiquill_image_data(svg)},
            title,
            caption,
        )
    png = bundle.get("image/png")
    if png:
        return __oxiquill_meta(
            {"kind": "image", "mime": "image/png", "data": __oxiquill_image_data(png)},
            title,
            caption,
        )
    jpeg = bundle.get("image/jpeg")
    if jpeg:
        return __oxiquill_meta(
            {"kind": "image", "mime": "image/jpeg", "data": __oxiquill_image_data(jpeg)},
            title,
            caption,
        )
    for mime, payload in bundle.items():
        if mime.startswith("application/vnd.vegalite.") and mime.endswith("+json"):
            artifact = {"kind": "json", "value": __oxiquill_jsonable(payload)}
            if title is None:
                artifact["title"] = "Vega-Lite specification"
            return __oxiquill_meta(artifact, title, caption)
    json_payload = bundle.get("application/json")
    if json_payload is not None:
        return __oxiquill_json_artifact(json_payload, title, caption)
    markdown = bundle.get("text/markdown")
    if markdown:
        return __oxiquill_text_artifact(markdown, title=title, caption=caption)
    plain = bundle.get("text/plain")
    if plain:
        return __oxiquill_text_artifact(plain, title=title, caption=caption)
    return __oxiquill_text_artifact(
        f"Unsupported MIME bundle: {', '.join(sorted(str(mime) for mime in bundle.keys()))}",
        title=title,
        caption=caption,
    )

def __oxiquill_json_repr_artifact(value, *, title=None, caption=None):
    method = getattr(value, "_repr_json_", None)
    if not callable(method):
        return None
    try:
        return __oxiquill_json_artifact(__oxiquill_extract_repr_payload(method()), title, caption)
    except Exception as error:
        return __oxiquill_text_artifact(f"Failed to render JSON repr: {error}", title=title, caption=caption)

def __oxiquill_markdown_repr_artifact(value, *, title=None, caption=None):
    method = getattr(value, "_repr_markdown_", None)
    if not callable(method):
        return None
    markdown = method()
    if not markdown:
        return None
    return __oxiquill_text_artifact(markdown, title=title, caption=caption)
`;

const pythonDisplayMatplotlibSupport = String.raw`
def __oxiquill_configure_matplotlib(available=False):
    os.environ["MPLBACKEND"] = "Agg"
    matplotlib = sys.modules.get("matplotlib")
    if matplotlib is None and available:
        import matplotlib
    if matplotlib is None:
        return False
    try:
        matplotlib.use("Agg", force=True)
    except Exception:
        pass
    from cycler import cycler
    matplotlib.rcdefaults()
    matplotlib.rcParams.update({
        "axes.prop_cycle": cycler(color=${JSON.stringify(chartPalette)}),
        "font.family": "sans-serif",
        "axes.grid": True,
        "axes.axisbelow": True,
        "grid.color": "#d1d5db",
        "grid.alpha": 0.45,
        "axes.spines.top": False,
        "axes.spines.right": False,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
        "savefig.transparent": False,
        "svg.fonttype": "none",
    })
    return True

def __oxiquill_is_matplotlib_figure(value):
    module = getattr(value.__class__, "__module__", "")
    return module.startswith("matplotlib.") and callable(getattr(value, "savefig", None))

def __oxiquill_figure_alt(fig):
    parts = [fig.get_suptitle()]
    for axes in fig.get_axes():
        parts.extend(axes.get_title(loc=loc) for loc in ("center", "left", "right"))
        parts.extend([axes.get_xlabel(), axes.get_ylabel()])
    description = "; ".join(dict.fromkeys(part.strip() for part in parts if part and part.strip()))
    return __oxiquill_bound_text(description or "matplotlib figure", __oxiquill_metadata_byte_limit)

def __oxiquill_figure_to_image(fig, *, preferred="svg", title=None, caption=None, mark_displayed=False):
    if mark_displayed:
        __oxiquill_displayed_figures.add(id(fig))
    if preferred == "svg":
        buffer = io.StringIO()
        import matplotlib
        with warnings.catch_warnings():
            if matplotlib.rcParams["svg.fonttype"] == "none":
                # Browser fonts supply these glyphs for SVG text, but not for PNG or paths.
                warnings.filterwarnings("ignore", message=r"Glyph .* missing from font\(s\)", category=UserWarning)
            fig.savefig(buffer, format="svg", bbox_inches="tight")
        data = buffer.getvalue()
        if len(data.encode("utf-8")) <= __oxiquill_image_byte_limit:
            return __oxiquill_meta(
                {
                    "kind": "image",
                    "mime": "image/svg+xml",
                    "data": data,
                    "alt": __oxiquill_figure_alt(fig),
                },
                title,
                caption,
            )
        limit_mib = __oxiquill_image_byte_limit / (1024 * 1024)
        print(f"Matplotlib SVG exceeded the {limit_mib:g} MiB image limit; rendered PNG at 150 DPI.", file=sys.stderr)
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight", dpi=150)
    return __oxiquill_meta(
        {
            "kind": "image",
            "mime": "image/png",
            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "alt": __oxiquill_figure_alt(fig),
        },
        title,
        caption,
    )

def __oxiquill_collect_matplotlib_outputs(preferred="svg", close_figures=True):
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is None:
        return []
    outputs = []
    for number in list(plt.get_fignums()):
        if len(outputs) >= __oxiquill_artifact_limit:
            break
        fig = plt.figure(number)
        if id(fig) in __oxiquill_displayed_figures:
            continue
        try:
            outputs.append(__oxiquill_figure_to_image(fig, preferred=preferred))
        except Exception as error:
            outputs.append({
                "kind": "text",
                "stream": "stderr",
                "content": f"Failed to render matplotlib figure {number}: {error}",
            })
    if close_figures:
        plt.close("all")
    return outputs
`;

const pythonDisplayDispatchSupport = String.raw`
def __oxiquill_artifact(value, title=None, caption=None):
    if value is None or isinstance(value, (str, int, float, bool, list, tuple, dict)):
        return __oxiquill_json_artifact(value, title, caption)
    dataframe_artifact = __oxiquill_dataframe_artifact(value, title=title, caption=caption)
    if dataframe_artifact is not None:
        return dataframe_artifact
    if __oxiquill_is_matplotlib_figure(value):
        return __oxiquill_figure_to_image(value, title=title, caption=caption, mark_displayed=True)
    mimebundle_artifact = __oxiquill_mimebundle_artifact(value, title=title, caption=caption)
    if mimebundle_artifact is not None:
        return mimebundle_artifact
    json_repr_artifact = __oxiquill_json_repr_artifact(value, title=title, caption=caption)
    if json_repr_artifact is not None:
        return json_repr_artifact
    for method_name, mime in (
        ("_repr_svg_", "image/svg+xml"),
        ("_repr_png_", "image/png"),
        ("_repr_jpeg_", "image/jpeg"),
    ):
        method = getattr(value, method_name, None)
        if callable(method):
            data = method()
            if data:
                return __oxiquill_meta(
                    {"kind": "image", "mime": mime, "data": __oxiquill_image_data(data)},
                    title,
                    caption,
                )
    html_repr = getattr(value, "_repr_html_", None)
    if callable(html_repr):
        html = html_repr()
        if html:
            return __oxiquill_meta({"kind": "html", "html": str(html), "sandboxed": True}, title, caption)
    markdown_repr_artifact = __oxiquill_markdown_repr_artifact(value, title=title, caption=caption)
    if markdown_repr_artifact is not None:
        return markdown_repr_artifact
    return __oxiquill_text_artifact(value, title=title, caption=caption)
`;

const pythonDisplayPublicFunctions = String.raw`
def display(value, *, title=None, caption=None):
    __oxiquill_append_output(__oxiquill_artifact(value, title, caption))

def display_json(value, *, title=None):
    __oxiquill_append_output(__oxiquill_json_artifact(value, title))

def display_html(html, *, title=None):
    __oxiquill_append_output(__oxiquill_meta({"kind": "html", "html": str(html), "sandboxed": True}, title))

def display_image(data, mime, *, alt=None, title=None):
    artifact = {"kind": "image", "mime": str(mime), "data": __oxiquill_image_data(data)}
    if alt is not None:
        artifact["alt"] = str(alt)
    __oxiquill_append_output(__oxiquill_meta(artifact, title))

def display_table(value, *, title=None, caption=None):
    dataframe_artifact = __oxiquill_dataframe_artifact(value, title=title, caption=caption)
    if dataframe_artifact is not None:
        __oxiquill_append_output(dataframe_artifact)
        return
    table_rows = []
    keys = None
    truncated = False
    row_count = None
    failure = None
    try:
        if type(value) in (list, tuple, range):
            try:
                row_count = len(value)
            except OverflowError:
                pass
        iterator = iter(value)
        sentinel = object()
        for index in range(__oxiquill_table_limit + 1):
            row = next(iterator, sentinel)
            if row is sentinel:
                row_count = len(table_rows)
                break
            if index == __oxiquill_table_limit:
                truncated = True
                break
            if index == 0 and isinstance(row, dict):
                key_preview = list(islice(row, __oxiquill_table_column_limit + 1))
                truncated |= len(key_preview) > __oxiquill_table_column_limit
                keys = key_preview[:__oxiquill_table_column_limit]
            if keys is not None:
                values = [row.get(key) for key in keys]
            else:
                try:
                    row_iterator = iter(row) if not isinstance(row, (str, bytes)) else iter([row])
                except TypeError:
                    row_iterator = iter([row])
                values = list(islice(row_iterator, __oxiquill_table_column_limit + 1))
                truncated |= len(values) > __oxiquill_table_column_limit
                values = values[:__oxiquill_table_column_limit]
            table_rows.append([__oxiquill_jsonable(item) for item in values])
    except Exception as error:
        truncated = True
        failure = f"Table conversion stopped after {len(table_rows)} rows: {error}"
    width = max((len(row) for row in table_rows), default=0)
    used_keys = set()
    columns = [
        {"key": __oxiquill_column_key(key, used_keys), "label": str(key), "type": "unknown"}
        for key in keys
    ] if keys is not None else [
        {"key": str(index), "label": str(index + 1), "type": "unknown"} for index in range(width)
    ]
    for row in table_rows:
        row.extend([None] * (len(columns) - len(row)))
    artifact = {
        "kind": "table",
        "columns": columns,
        "rows": table_rows,
        "truncated": truncated,
    }
    if row_count is not None:
        artifact["rowCount"] = row_count
    __oxiquill_append_output(__oxiquill_meta(artifact, title, caption))
    if failure is not None:
        __oxiquill_append_output(__oxiquill_error_artifact(failure))
`;

const pythonDisplayChartSupport = String.raw`
def __oxiquill_check_chart_size(spec):
    if not isinstance(spec, dict):
        raise ValueError("Chart spec must be a dict.")
    for key in ("categories", "xCategories", "yCategories", "series", "bins", "data"):
        items = spec.get(key)
        if isinstance(items, (list, tuple)) and len(items) > __oxiquill_chart_limit:
            raise ValueError(f"Chart contains {len(items)} data items; maximum is {__oxiquill_chart_limit}.")
    series = spec.get("series")
    if not isinstance(series, (list, tuple)):
        return
    count = 0
    for item in series:
        if not isinstance(item, dict):
            continue
        field = "values" if spec.get("kind") == "bar" else "points"
        values = item.get(field)
        if isinstance(values, (list, tuple)):
            count += len(values) if field == "values" else max(1, len(values))
        if count > __oxiquill_chart_limit:
            raise ValueError(f"Chart contains {count} data items; maximum is {__oxiquill_chart_limit}.")

def display_chart(spec, *, id=None, title=None, caption=None):
    try:
        if len(__oxiquill_outputs) >= __oxiquill_artifact_limit:
            __oxiquill_append_output({})
            return
        __oxiquill_check_chart_size(spec)
        artifact = {"kind": "chart", "spec": spec}
        for key, value in (("id", id), ("title", title), ("caption", caption)):
            if value is not None:
                artifact[key] = value
        # Bound serialization before crossing into JavaScript, and snapshot mutable inputs.
        encoder = json.JSONEncoder(ensure_ascii=False, allow_nan=False, separators=(",", ":"))
        chunks = []
        byte_count = 0
        for chunk in encoder.iterencode(artifact):
            byte_count += len(chunk.encode("utf-8"))
            if byte_count > __oxiquill_output_byte_limit - __oxiquill_output_bytes:
                raise ValueError("Python chart exceeded the cumulative artifact byte limit.")
            chunks.append(chunk)
        __oxiquill_append_output(json.loads("".join(chunks)), json_snapshot=True)
    except Exception as error:
        __oxiquill_append_output(__oxiquill_error_artifact(str(error)))

def __oxiquill_line_coordinate(value, row, column, *, allow_category=False):
    pd = sys.modules.get("pandas")
    context = f"Line chart row {row}, column {column!r}"
    if not pd.api.types.is_scalar(value):
        raise ValueError(f"{context} must be a scalar.")
    if pd.isna(value):
        raise ValueError(f"{context} is missing.")
    if isinstance(value, datetime.datetime):
        if not allow_category:
            raise ValueError(f"{context} must be a finite number.")
        if value.tzinfo is None or value.utcoffset() is None:
            raise ValueError(f"{context} requires an explicit time zone.")
        return value.timestamp() * 1000, "time"
    item = getattr(value, "item", None)
    if callable(item):
        value = item()
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return value, "value"
    if allow_category and isinstance(value, str):
        return value, "category"
    raise ValueError(f"{context} must be a finite number" + (", string, or timezone-aware datetime." if allow_category else "."))

def display_line(df, *, x, y, id=None, title=None, caption=None, style=None):
    try:
        if not __oxiquill_is_pandas_dataframe(df):
            raise ValueError("display_line expects a pandas DataFrame.")
        columns = [y] if isinstance(y, str) else y
        if not isinstance(x, str) or not isinstance(columns, list) or not columns or not all(isinstance(name, str) for name in columns):
            raise ValueError("display_line requires an x column name and a y column name or nonempty list of names.")
        # Each series counts at least one item, as in the chart validator.
        item_count = max(1, len(df)) * len(columns)
        if item_count > __oxiquill_chart_limit:
            raise ValueError(f"Chart contains {item_count} data items; maximum is {__oxiquill_chart_limit}.")
        if not df.columns.is_unique or len(set(columns)) != len(columns):
            raise ValueError("display_line requires unique column names.")
        for name in [x, *columns]:
            if name not in df.columns:
                raise ValueError(f"Line chart column {name!r} does not exist.")
        series = [{"name": name, "points": []} for name in columns]
        x_type = None
        # Select only the requested columns; do not materialize an entire DataFrame.
        for row, values in enumerate(df.loc[:, [x, *columns]].itertuples(index=False, name=None), 1):
            x_value, coordinate_type = __oxiquill_line_coordinate(values[0], row, x, allow_category=True)
            if x_type is not None and coordinate_type != x_type:
                raise ValueError(f"Line chart row {row}, column {x!r} mixes coordinate types.")
            x_type = coordinate_type
            for output, name, value in zip(series, columns, values[1:]):
                y_value, _ = __oxiquill_line_coordinate(value, row, name)
                output["points"].append([x_value, y_value])
        spec = {"kind": "line", "series": series, "xLabel": x, "xType": x_type or "value", "yType": "value", "tooltip": True, "dataZoom": True}
        if len(columns) == 1:
            spec["yLabel"] = columns[0]
        if style is not None:
            spec["style"] = style
        display_chart(spec, id=id, title=title, caption=caption)
    except Exception as error:
        __oxiquill_append_output(__oxiquill_error_artifact(str(error)))
`;

const pythonDisplayBootstrapSupport = String.raw`
def __oxiquill_reset_outputs():
    global __oxiquill_output_bytes, __oxiquill_output_omission
    __oxiquill_outputs.clear()
    __oxiquill_displayed_figures.clear()
    __oxiquill_output_bytes = 0
    __oxiquill_output_omission = None

def __oxiquill_close_figures():
    plt = sys.modules.get("matplotlib.pyplot")
    if plt is not None:
        plt.close("all")

def __oxiquill_prepare_cell(matplotlib_available=False):
    __oxiquill_close_figures()
    __oxiquill_reset_outputs()
    __oxiquill_configure_matplotlib(matplotlib_available)

def __oxiquill_take_outputs():
    outputs = list(__oxiquill_outputs)
    if __oxiquill_output_omission is not None:
        outputs = outputs[:max(0, __oxiquill_artifact_limit - 1)]
        outputs.append(__oxiquill_error_artifact(__oxiquill_output_omission))
    __oxiquill_outputs.clear()
    return outputs

builtins.display = display
builtins.display_json = display_json
builtins.display_html = display_html
builtins.display_table = display_table
builtins.display_image = display_image
builtins.display_chart = display_chart
builtins.display_line = display_line
`;

export const pythonDisplaySupportCode = [
  pythonDisplayJsonAndScalarSupport,
  pythonDisplayTableSupport,
  pythonDisplayMimeSupport,
  pythonDisplayMatplotlibSupport,
  pythonDisplayDispatchSupport,
  pythonDisplayPublicFunctions,
  pythonDisplayChartSupport,
  pythonDisplayBootstrapSupport
].join('\n');
