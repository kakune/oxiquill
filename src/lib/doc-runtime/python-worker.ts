import {
  isOutputArtifact,
  legacyResultToOutputs
} from './output-artifacts';
import type { CellExecutionResult, OutputArtifact, RuntimeWorkerRequest, RuntimeWorkerResponse } from './types';

type LoadPyodide = typeof import('pyodide').loadPyodide;
type PyodideRuntime = Awaited<ReturnType<LoadPyodide>>;

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

const worker = self as unknown as WorkerScope;
let pyodideReady: Promise<PyodideRuntime> | undefined;
let loadPyodideReady: Promise<LoadPyodide> | undefined;
const pyodideModuleUrl = '/pyodide/pyodide.mjs';
const requestQueue = createSerialRequestQueue(handleRequest);

export const pythonDisplaySupportCode = String.raw`
import base64
import builtins
import io
import json

__oxiquill_outputs = []
__oxiquill_displayed_figures = set()
__oxiquill_table_limit = 1000

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

def __oxiquill_image_data(data):
    if isinstance(data, bytes):
        return base64.b64encode(data).decode("ascii")
    return str(data)

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

def __oxiquill_artifact(value, title=None, caption=None):
    if value is None or isinstance(value, (str, int, float, bool, list, tuple, dict)):
        return __oxiquill_json_artifact(value, title, caption)
    if __oxiquill_is_matplotlib_figure(value):
        return __oxiquill_figure_to_image(value, title=title, caption=caption, mark_displayed=True)
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
    return __oxiquill_meta({"kind": "text", "stream": "display", "content": str(value)}, title, caption)

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

worker.addEventListener('message', (event) => {
  requestQueue.enqueue(event.data);
});

export function createSerialRequestQueue<Request>(
  handle: (request: Request) => Promise<void>
): { enqueue: (request: Request) => void } {
  let tail = Promise.resolve();

  return {
    enqueue(request) {
      tail = tail
        .catch(() => undefined)
        .then(() => handle(request))
        .catch(() => undefined);
    }
  };
}

async function handleRequest(request: RuntimeWorkerRequest): Promise<void> {
  try {
    const pyodide = await ensurePyodide();
    const stdout: string[] = [];
    const stderr: string[] = [];

    pyodide.setStdout({ batched: (output) => stdout.push(output) });
    pyodide.setStderr({ batched: (output) => stderr.push(output) });

    if (request.packages && request.packages.length > 0) {
      await pyodide.loadPackage(Array.from(request.packages));
    }
    if (request.source) {
      await pyodide.loadPackagesFromImports(request.source);
    }
    pyodide.runPython('__oxiquill_prepare_cell()');

    const globals = pyodide.toPy(request.inputs);
    let value: unknown = null;

    try {
      value = toSerializable(await pyodide.runPythonAsync(request.source ?? '', { globals }));
    } finally {
      globals.destroy();
    }
    const displayOutputs = toOutputArtifacts(
      toSerializable(pyodide.runPython('__oxiquill_take_outputs()'))
    );
    const matplotlibOutputs = toOutputArtifacts(
      toSerializable(pyodide.runPython('__oxiquill_collect_matplotlib_outputs()'))
    );

    const result = createPythonCellResult({
      stdout: stdout.join('\n').trimEnd(),
      stderr: stderr.join('\n').trimEnd(),
      value,
      plots: [],
      displayOutputs: [...displayOutputs, ...matplotlibOutputs]
    });

    worker.postMessage({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function ensurePyodide(): Promise<PyodideRuntime> {
  pyodideReady ??= getLoadPyodide().then(async (loadPyodide) => {
    const pyodide = await loadPyodide({ indexURL: '/pyodide/' });
    await pyodide.runPythonAsync(pythonDisplaySupportCode);
    return pyodide;
  });
  return pyodideReady;
}

function getLoadPyodide(): Promise<LoadPyodide> {
  loadPyodideReady ??= importPyodideModule().then((module) => module.loadPyodide);
  return loadPyodideReady;
}

async function importPyodideModule(): Promise<{ loadPyodide: LoadPyodide }> {
  const response = await fetch(pyodideModuleUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${pyodideModuleUrl}: ${response.status} ${response.statusText}`);
  }

  const moduleUrl = URL.createObjectURL(
    new Blob([await response.text()], { type: 'text/javascript' })
  );

  try {
    return (await import(/* @vite-ignore */ moduleUrl)) as { loadPyodide: LoadPyodide };
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function toSerializable(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === 'object' && value && 'toJs' in value) {
    const proxy = value as { destroy?: () => void; toJs: (options?: unknown) => unknown };
    try {
      return proxy.toJs({ dict_converter: Object.fromEntries });
    } finally {
      proxy.destroy?.();
    }
  }

  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}

export function createPythonCellResult({
  displayOutputs,
  plots,
  stderr,
  stdout,
  value
}: {
  displayOutputs: readonly OutputArtifact[];
  plots: CellExecutionResult['plots'];
  stderr: string;
  stdout: string;
  value: unknown;
}): CellExecutionResult {
  const streamOutputs = legacyResultToOutputs({ stdout, stderr, plots: [] });
  const valueOutputs = legacyResultToOutputs({ value, plots: [] });

  return {
    stdout,
    stderr,
    value,
    plots,
    outputs: [...streamOutputs, ...displayOutputs, ...valueOutputs]
  };
}

function toOutputArtifacts(value: unknown): readonly OutputArtifact[] {
  return Array.isArray(value) ? value.filter(isOutputArtifact) : [];
}
