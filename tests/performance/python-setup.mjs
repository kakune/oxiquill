import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { pythonDisplaySupportCode } from '../../packages/oxiquill/dist/lib/doc-runtime/python-display-support.js';

const require = createRequire(new URL('../../packages/oxiquill/package.json', import.meta.url));
const python = await require('pyodide').loadPyodide();
python.runPython(pythonDisplaySupportCode);
const setup = 'from math import sqrt\nsamples = [sqrt(value) for value in range(1, 101)]';
const body = 'sum(samples) / len(samples)';
const measurements = {};
for (const separate of [false, true]) {
  const times = [];
  for (let run = 0; run < 25; run += 1) {
    const start = performance.now();
    const globals = python.toPy({});
    try {
      python.runPython('__oxiquill_prepare_cell()');
      if (separate) {
        await python.runPythonAsync(setup, { globals });
        python.runPython('__oxiquill_close_figures(); __oxiquill_reset_outputs()');
      }
      const result = await python.runPythonAsync(separate ? body : `${setup}\n${body}`, { globals });
      assert.ok(Math.abs(result - 6.714629471031478) < 1e-12);
    } finally {
      globals.destroy();
    }
    if (run >= 5) times.push(performance.now() - start);
  }
  times.sort((a, b) => a - b);
  measurements[separate ? 'setup' : 'duplicated'] = { medianMs: times[10], p95Ms: times[18], runs: times.length };
}
console.log(
  JSON.stringify(
    {
      environment: 'Node Pyodide; warm interpreter; 100 square roots',
      preparationCopiesBefore: 2,
      preparationCopiesAfter: 1,
      measurements
    },
    null,
    2
  )
);
