// @vitest-environment node
import { createRequire } from 'node:module';
import { beforeAll, beforeEach, it } from 'vitest';
import { pythonDisplaySupportCode } from '../../packages/oxiquill/src/lib/doc-runtime/python-display-support.ts';

const require = createRequire(new URL('../../packages/oxiquill/package.json', import.meta.url));
const { loadPyodide } = require('pyodide');
let python;

beforeAll(async () => {
  python = await loadPyodide();
  python.runPython(pythonDisplaySupportCode);
}, 30_000);

beforeEach(() => python.runPython('__oxiquill_prepare_cell()'));

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
