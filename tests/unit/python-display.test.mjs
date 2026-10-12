// @vitest-environment node
import { createRequire } from 'node:module';
import { beforeAll, expect, it } from 'vitest';
import { pythonDisplaySupportCode } from '../../packages/oxiquill/src/lib/doc-runtime/python-display-support.ts';

const require = createRequire(new URL('../../packages/oxiquill/package.json', import.meta.url));
const { loadPyodide } = require('pyodide');
let python;

beforeAll(async () => {
  python = await loadPyodide();
  python.runPython(pythonDisplaySupportCode);
}, 30_000);

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
