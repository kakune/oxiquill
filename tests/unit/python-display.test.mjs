// @vitest-environment node
import { createRequire } from 'node:module';
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { pythonDisplaySupportCode } from '../../packages/oxiquill/src/lib/doc-runtime/python-display-support.ts';

const require = createRequire(new URL('../../packages/oxiquill/package.json', import.meta.url));
const { loadPyodide } = require('pyodide');
let python;
let createPythonWorkerRequestHandler;

beforeAll(async () => {
  python = await loadPyodide();
  python.runPython(pythonDisplaySupportCode);
  vi.stubGlobal('self', { addEventListener() {}, postMessage() {} });
  ({ createPythonWorkerRequestHandler } = await import('../../packages/oxiquill/src/lib/doc-runtime/python-worker.ts'));
}, 30_000);

afterAll(() => vi.unstubAllGlobals());

beforeEach(() => python.runPython('__oxiquill_prepare_cell()'));

it('emits bounded scene snapshots, optional fields, and local producer errors', () => {
  python.runPython(`
points = [{"id": "a", "position": [0, 0, 0]}]
display_scene3d(points, edges=[], groups=[], axes={"x": {"unit": "nm"}}, camera={"yaw": 30}, title="<b>Scene</b>", caption="literal")
points[0]["position"][0] = 99
scene = __oxiquill_take_outputs()[0].to_py()
assert scene["kind"] == "scene3d" and scene["points"][0]["position"] == [0, 0, 0]
assert scene["edges"] == [] and scene["groups"] == []
assert scene["axes"] == {"x": {"unit": "nm"}} and scene["camera"] == {"yaw": 30}
assert scene["title"] == "<b>Scene</b>" and scene["caption"] == "literal"
display_scene3d([])
assert __oxiquill_take_outputs()[0].to_py() == {"kind": "scene3d", "points": []}
for field, arguments in [
    ("points", {"points": ({} for _ in range(10001))}),
    ("edges", {"points": [], "edges": ({} for _ in range(20001))}),
    ("finite", {"points": [{"id": "a", "position": [float("nan"), 0, 0]}]}),
    ("bytes", {"points": [], "title": "x" * (16 * 1024 * 1024)})
]:
    display_scene3d(**arguments)
    assert __oxiquill_take_outputs()[0]["kind"] == "__oxiquill_error", field
`);
});

it('reexecutes setup in fresh globals, hides setup output, and injects reader inputs last', async () => {
  const postMessage = vi.fn();
  const handle = createPythonWorkerRequestHandler({ ensurePyodide: async () => python, postMessage });
  const request = {
    requestId: 1,
    cellId: 'body',
    inputs: { factor: 3 },
    packages: [],
    setup: [
      {
        id: 'common',
        packages: [],
        timeoutMs: 1000,
        source: 'values = [1, 2]\nfactor = 999\nprint("hidden")\ndisplay_json({"hidden": True})\nvalues'
      }
    ],
    source: 'assert "leaked" not in globals()\nleaked = True\nvalues.append(factor)\nprint(values)\nsum(values)'
  };
  for (const requestId of [1, 2]) {
    await handle({ ...request, requestId });
    expect(postMessage.mock.lastCall[0]).toEqual({
      requestId,
      ok: true,
      result: {
        outputs: [
          { kind: 'text', stream: 'stdout', content: '[1, 2, 3]' },
          { kind: 'json', value: 6 }
        ]
      }
    });
  }
  await handle({
    ...request,
    setup: [
      {
        ...request.setup[0],
        source: 'print("failed setup")\ndisplay_json({"stage": "setup"})\nraise ValueError("setup failed")'
      }
    ]
  });
  expect(postMessage.mock.lastCall[0]).toMatchObject({
    ok: false,
    error: expect.stringContaining('Python setup "common" failed:'),
    partialResult: {
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'failed setup' },
        { kind: 'json', value: { stage: 'setup' } }
      ]
    }
  });
  await handle({ ...request, setup: [{ ...request.setup[0], source: 'values = [10]\nfactor = 999' }] });
  expect(postMessage.mock.lastCall[0]).toMatchObject({
    ok: true,
    result: {
      outputs: [
        { kind: 'text', stream: 'stdout', content: '[10, 3]' },
        { kind: 'json', value: 13 }
      ]
    }
  });
});

it('closes leftover figures before clearing display state without importing pyplot', () => {
  python.runPython(`
from types import SimpleNamespace
events = []
sys.modules["matplotlib.pyplot"] = SimpleNamespace(close=lambda value: events.append(value))
__oxiquill_displayed_figures.add(1)
__oxiquill_prepare_cell()
assert events == ["all"]
assert not __oxiquill_displayed_figures
del sys.modules["matplotlib.pyplot"]
__oxiquill_prepare_cell()
assert "matplotlib.pyplot" not in sys.modules
`);
});

it('bounds infinite row and column iterators before converting values', () => {
  python.runPython(`
from itertools import count
calls = 0
def infinite_rows():
    global calls
    while True:
        calls += 1
        yield [calls]
display_table(infinite_rows())
table = __oxiquill_take_outputs()[0]
assert calls == __oxiquill_table_limit + 1
assert len(table["rows"]) == __oxiquill_table_limit
assert table["truncated"] and "rowCount" not in table
display_table([count()])
table = __oxiquill_take_outputs()[0]
assert len(table["columns"]) == __oxiquill_table_column_limit
assert len(table["rows"][0]) == __oxiquill_table_column_limit
assert table["rowCount"] == 1 and table["truncated"]
class Unconvertible:
    def __str__(self):
        raise AssertionError("Discarded columns must not be converted")
display_table([[1] * __oxiquill_table_column_limit + [Unconvertible()]])
assert __oxiquill_take_outputs()[0]["truncated"]
`);
});

it('keeps exact counts only for known lengths or exhausted iterators', () => {
  python.runPython(`
for count_rows in [0, __oxiquill_table_limit, __oxiquill_table_limit + 1]:
    display_table([[1]] * count_rows)
    table = __oxiquill_take_outputs()[0]
    assert table["rowCount"] == count_rows
    assert table["truncated"] == (count_rows > __oxiquill_table_limit)
display_table(iter([[1], [2, 3]]))
table = __oxiquill_take_outputs()[0]
assert table["rowCount"] == 2
assert table["rows"] == [[1, None], [2, 3]]
class UnsafeLength:
    def __len__(self):
        raise AssertionError("Do not call user-defined length")
    def __iter__(self):
        yield [1]
display_table(UnsafeLength())
assert __oxiquill_take_outputs()[0]["rowCount"] == 1
display_table(range(10 ** 100))
table = __oxiquill_take_outputs()[0]
assert len(table["rows"]) == __oxiquill_table_limit
assert "rowCount" not in table
`);
});

it('retains completed rows and a local diagnostic when iteration fails', () => {
  python.runPython(`
def broken_rows():
    yield [1]
    raise ValueError("iterator failed")
display_table(broken_rows())
table, error = __oxiquill_take_outputs()
assert table["rows"] == [[1]] and table["truncated"]
assert "rowCount" not in table
assert error["kind"] == "__oxiquill_error"
assert "after 1 rows: iterator failed" in error["message"]
display_table([{index: index for index in range(1000)}])
table = __oxiquill_take_outputs()[0]
assert len(table["columns"]) == __oxiquill_table_column_limit
assert table["truncated"]
`);
});

it('bounds new chart payloads before leaving Python', () => {
  python.runPython(`
for spec in (
    {"kind": "xy", "layers": [{"id": "a", "kind": "line", "points": [[0, 1]] * 50001}, {"id": "b", "kind": "scatter", "points": [[0, 1]] * 50001}]},
    {"kind": "boxplot", "series": [{"values": [[0, 1, 2, 3, 4]] * 100001}]},
    {"kind": "bubble", "series": [{"points": [[0, 1, 2]] * 100001}]},
    {"kind": "field", "xEdges": [0, 1], "yEdges": [0, 1], "values": [[0] * 100001]},
    {"kind": "field", "xEdges": [0] * 100002, "yEdges": [], "values": []},
    {"kind": "line", "series": [], "annotations": [{}] * 101}
):
    display_chart(spec)
assert len(__oxiquill_outputs) == 6, repr(__oxiquill_outputs)
assert all(output["kind"] == "__oxiquill_error" and any(word in output["message"].lower() for word in ("limit", "maximum")) for output in __oxiquill_outputs), repr(__oxiquill_outputs)
`);
});

it('emits mixed charts through the generic Python API', () => {
  python.runPython(`
spec = {"kind": "xy", "layers": [
    {"id": "line", "kind": "line", "points": [[0, 1], [1, 2]]},
    {"id": "samples", "kind": "scatter", "points": [[0, 1.1]]},
    {"id": "band", "kind": "band", "points": [[0, 1, 0.5, 1.5]]}
]}
display_chart(spec)
assert __oxiquill_take_outputs()[0].to_py()["spec"] == spec
`);
});

it('emits column descriptors and outcomes while preserving plain table calls', () => {
  python.runPython(`
display_table([[1.234, None]], columns={"0": {"type": "number", "format": {"fractionDigits": 2, "unit": "s"}}, "2": {"nullText": "Missing"}})
table = __oxiquill_take_outputs()[0]
assert table["columns"][0]["format"] == {"fractionDigits": 2, "unit": "s"}
assert table["columns"][1]["nullText"] == "Missing"
assert table["rows"] == [[1.234, None]]
display_table([[1]], columns=["Count"])
assert __oxiquill_take_outputs()[0]["columns"][0] == {"key": "0", "label": "Count", "type": "unknown"}
display_outcome("partial", "Iteration limit reached", status="MaxIterations", diagnostics=[{"name": "residual", "value": 0.0013}])
result = __oxiquill_take_outputs()[0]
assert result.kind == "outcome" and result.state == "partial"
assert result.diagnostics[0].value == 0.0013
display_outcome("failed", "Invalid", diagnostics=[{"name": "residual", "value": float("nan")}])
from js import JSON
assert json.loads(JSON.stringify(__oxiquill_take_outputs()[0]))["diagnostics"][0]["value"] is None
`);
});
