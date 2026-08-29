const pythonDisplayJsonAndScalarSupport = String.raw`
import base64
import builtins
import io
import json

__oxiquill_outputs = []
__oxiquill_displayed_figures = set()
__oxiquill_table_limit = 10000
__oxiquill_table_column_limit = 100

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
        import pandas as pd
        is_missing = pd.isna(value)
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
    column_labels = list(dataframe.columns)
    truncated_rows = row_count > max_rows
    truncated_columns = len(column_labels) > max_columns
    preview = dataframe.iloc[:max_rows, :max_columns]
    used_keys = set()
    columns = []
    if __oxiquill_should_include_index(dataframe.index, include_index):
        columns.append({
            "key": __oxiquill_column_key("__index__", used_keys),
            "label": str(getattr(dataframe.index, "name", None) or "index"),
            "type": __oxiquill_dtype_name(getattr(dataframe.index, "dtype", "unknown")),
        })
    for label in list(preview.columns):
        columns.append({
            "key": __oxiquill_column_key(label, used_keys),
            "label": str(label),
            "type": __oxiquill_dtype_name(getattr(preview[label], "dtype", "unknown")),
        })
    rows = []
    include_index_column = len(columns) > len(list(preview.columns))
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
def __oxiquill_configure_matplotlib():
    try:
        import matplotlib
    except Exception:
        return False
    try:
        matplotlib.use("Agg", force=True)
    except Exception:
        pass
    return True

def __oxiquill_is_matplotlib_figure(value):
    module = getattr(value.__class__, "__module__", "")
    return module.startswith("matplotlib.") and callable(getattr(value, "savefig", None))

def __oxiquill_figure_to_image(fig, *, preferred="svg", title=None, caption=None, mark_displayed=False):
    if mark_displayed:
        __oxiquill_displayed_figures.add(id(fig))
    if preferred == "svg":
        buffer = io.StringIO()
        fig.savefig(buffer, format="svg", bbox_inches="tight")
        return __oxiquill_meta(
            {
                "kind": "image",
                "mime": "image/svg+xml",
                "data": buffer.getvalue(),
                "alt": "matplotlib figure",
            },
            title,
            caption,
        )
    buffer = io.BytesIO()
    fig.savefig(buffer, format="png", bbox_inches="tight")
    return __oxiquill_meta(
        {
            "kind": "image",
            "mime": "image/png",
            "data": base64.b64encode(buffer.getvalue()).decode("ascii"),
            "alt": "matplotlib figure",
        },
        title,
        caption,
    )

def __oxiquill_collect_matplotlib_outputs(preferred="svg", close_figures=True):
    try:
        import matplotlib.pyplot as plt
    except Exception:
        return []
    outputs = []
    for number in list(plt.get_fignums()):
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
    __oxiquill_outputs.append(__oxiquill_artifact(value, title, caption))

def display_json(value, *, title=None):
    __oxiquill_outputs.append(__oxiquill_json_artifact(value, title))

def display_html(html, *, title=None):
    __oxiquill_outputs.append(__oxiquill_meta({"kind": "html", "html": str(html), "sandboxed": True}, title))

def display_image(data, mime, *, alt=None, title=None):
    artifact = {"kind": "image", "mime": str(mime), "data": __oxiquill_image_data(data)}
    if alt is not None:
        artifact["alt"] = str(alt)
    __oxiquill_outputs.append(__oxiquill_meta(artifact, title))

def display_table(value, *, title=None, caption=None):
    dataframe_artifact = __oxiquill_dataframe_artifact(value, title=title, caption=caption)
    if dataframe_artifact is not None:
        __oxiquill_outputs.append(dataframe_artifact)
        return
    rows = list(value)
    truncated = len(rows) > __oxiquill_table_limit
    preview = rows[:__oxiquill_table_limit]
    if preview and isinstance(preview[0], dict):
        keys = list(preview[0].keys())
        columns = [{"key": str(key), "label": str(key), "type": "unknown"} for key in keys]
        table_rows = [[__oxiquill_jsonable(row.get(key)) for key in keys] for row in preview]
    else:
        width = max((len(row) if isinstance(row, (list, tuple)) else 1 for row in preview), default=0)
        columns = [{"key": str(index), "label": str(index + 1), "type": "unknown"} for index in range(width)]
        table_rows = [
            [__oxiquill_jsonable(row[index]) if isinstance(row, (list, tuple)) and index < len(row) else None for index in range(width)]
            for row in preview
        ]
    __oxiquill_outputs.append(__oxiquill_meta({
        "kind": "table",
        "columns": columns,
        "rows": table_rows,
        "rowCount": len(rows),
        "truncated": truncated,
    }, title, caption))
`;

const pythonDisplayBootstrapSupport = String.raw`
def __oxiquill_reset_outputs():
    __oxiquill_outputs.clear()
    __oxiquill_displayed_figures.clear()

def __oxiquill_prepare_cell():
    __oxiquill_reset_outputs()
    __oxiquill_configure_matplotlib()

def __oxiquill_take_outputs():
    outputs = list(__oxiquill_outputs)
    __oxiquill_outputs.clear()
    return outputs

builtins.display = display
builtins.display_json = display_json
builtins.display_html = display_html
builtins.display_table = display_table
builtins.display_image = display_image
`;

export const pythonDisplaySupportCode = [
  pythonDisplayJsonAndScalarSupport,
  pythonDisplayTableSupport,
  pythonDisplayMimeSupport,
  pythonDisplayMatplotlibSupport,
  pythonDisplayDispatchSupport,
  pythonDisplayPublicFunctions,
  pythonDisplayBootstrapSupport
].join('\n');
