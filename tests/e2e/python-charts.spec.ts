import { expect, test } from '@playwright/test';
import contract from '../fixtures/output-contract.json' with { type: 'json' };
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import type { RawCellExecutionResult } from '../../packages/oxiquill/src/lib/doc-runtime/types';

test('declarative charts and bounded DataFrame lines work in real Pyodide', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'The producer contract runs in real Chromium Pyodide.');
  test.setTimeout(240_000);
  const fixtures = contract.filter((fixture) => fixture.artifact.kind === 'chart' && !fixture.pointCount);
  const results: RawCellExecutionResult[] = [];
  await page.exposeFunction('observeChartResult', (result: RawCellExecutionResult) => results.push(result));
  await page.addInitScript(
    (sources: string[]) => {
      const post = Worker.prototype.postMessage;
      const observed = new WeakSet<Worker>();
      let run = 0;
      Worker.prototype.postMessage = function (
        message: unknown,
        options?: StructuredSerializeOptions | Transferable[]
      ) {
        if (message && typeof message === 'object') {
          if ('type' in message && message.type === 'prepare') message = { ...message, packages: [] };
          if (
            message &&
            typeof message === 'object' &&
            'cellId' in message &&
            message.cellId === 'features__rich-output__python-rich-outputs'
          ) {
            if (!observed.has(this)) {
              observed.add(this);
              this.addEventListener('message', (event: MessageEvent<{ result?: RawCellExecutionResult }>) => {
                if (event.data.result) {
                  void (
                    globalThis as unknown as { observeChartResult: (result: RawCellExecutionResult) => Promise<void> }
                  ).observeChartResult(event.data.result);
                }
              });
            }
            message = { ...message, packages: [], source: sources[Math.min(run++, sources.length - 1)] };
          }
        }
        return Reflect.apply(post, this, [message, options]);
      };
    },
    [
      `
import json
import sys
assert "pandas" not in sys.modules
fixtures = json.loads(${JSON.stringify(JSON.stringify(fixtures))})
for fixture in fixtures:
    artifact = fixture["artifact"]
    display_chart(artifact["spec"], **{key: artifact[key] for key in ("id", "title", "caption") if key in artifact})
`,
      `
import pandas as pd
import numpy as np
df = pd.DataFrame({"t": [np.int64(0), np.int64(1)], "a": [np.float64(1), np.float64(2)], "b": [3, 4]})
display_line(df, x="t", y=["b", "a"], id="lines", title="DataFrame lines", caption="Two columns", style={"animation": False})
times = pd.DataFrame({"t": pd.to_datetime(["2026-10-10T09:00:00+09:00", "2026-10-10T10:00:00+09:00"]), "a": [1, 2]})
display_line(times, x="t", y="a")
display_line(pd.DataFrame({"label": ["a", "b"], "value": [1, 2]}), x="label", y="value")
spec = {"kind": "line", "series": [{"points": [[0, 1]]}]}
display_chart(spec)
spec["series"][0]["points"][0][1] = 99
`,
      `
import pandas as pd
display("before")
for missing in [None, float("nan"), float("inf"), pd.NaT]:
    display_line(pd.DataFrame({"x": [0, 1], "y": [1, missing]}), x="x", y="y")
display_line(pd.DataFrame({"x": pd.to_datetime(["2026-10-10"]), "y": [1]}), x="x", y="y")
display_line(pd.DataFrame({"x": [0, "a"], "y": [1, 2]}), x="x", y="y")
display_line(pd.DataFrame({"x": [0], "y": [1]}), x="missing", y="y")
display_line(pd.DataFrame({"x": [0], "y": [1]}), x="x", y=["y", "y"])
display_line(pd.DataFrame({"x": [0], "y": [1]}), x="x", y=[])
display_line([], x="x", y="y")
display_chart({"kind": "line", "xType": "time", "series": [{"points": [["2026-10-10T00:00:00+25:00", 1]]}]})
display_chart({"kind": "line", "series": [{"points": [[0, float("nan")]]}]})
display("after")
`,
      `
import pandas as pd
for count in [99999, 100000, 100001]:
    display_chart({"kind": "line", "series": [{"points": [[0, 1]] * count}]})
for count in [50000, 50001]:
    display_line(pd.DataFrame({"x": range(count), "a": [1] * count, "b": [2] * count}), x="x", y=["a", "b"])
`,
      `display_chart({"kind": "area", "series": []}, title="Fresh run")`
    ]
  );
  await page.goto('/features/rich-output/');
  const cell = page.getByTestId('cell-features__rich-output__python-rich-outputs');
  await cell.scrollIntoViewIfNeeded();
  const run = async (count: number) => {
    const button = cell.getByRole('button', { name: 'Run', exact: true });
    await expect(button).toBeEnabled();
    await button.click();
    await expect.poll(() => results.length, { timeout: 120_000 }).toBe(count);
    // Pyodide reports package-loading progress on stdout before the authored outputs.
    return validateOutputArtifacts(results[count - 1].outputs ?? []).filter(
      (result) => !(result.status === 'valid' && result.artifact.kind === 'text' && result.artifact.stream === 'stdout')
    );
  };
  await run(1);
  for (const [index, fixture] of fixtures.entries()) {
    expect(validateOutputArtifacts([results[0].outputs?.[index]])[0]).toEqual(fixture.expected);
  }
  const second = await run(2);
  expect(second.every((result) => result.status === 'valid')).toBe(true);
  const lines = second.filter((result) => result.status === 'valid' && result.artifact.kind === 'chart');
  expect(lines.map((result) => result.status)).toEqual(['valid', 'valid', 'valid', 'valid']);
  expect(lines[0]).toMatchObject({
    artifact: {
      id: 'lines',
      title: 'DataFrame lines',
      caption: 'Two columns',
      spec: {
        series: [
          {
            name: 'b',
            points: [
              [0, 3],
              [1, 4]
            ]
          },
          {
            name: 'a',
            points: [
              [0, 1],
              [1, 2]
            ]
          }
        ],
        style: { animation: false }
      }
    }
  });
  expect(lines[1]).toMatchObject({
    artifact: {
      spec: {
        xType: 'time',
        series: [
          {
            points: [
              [Date.parse('2026-10-10T00:00:00Z'), 1],
              [Date.parse('2026-10-10T01:00:00Z'), 2]
            ]
          }
        ]
      }
    }
  });
  expect(lines[2]).toMatchObject({ artifact: { spec: { xType: 'category' } } });
  expect(lines[3]).toMatchObject({ artifact: { spec: { series: [{ points: [[0, 1]] }] } } });
  await expect(cell.getByText('DataFrame lines', { exact: true })).toBeVisible();
  const invalid = await run(3);
  expect(invalid[0].status).toBe('valid');
  expect(invalid.at(-1)?.status).toBe('valid');
  expect(invalid.slice(1, -1).every((result) => result.status === 'error')).toBe(true);
  for (const result of invalid.slice(1, 5))
    expect(result).toMatchObject({ message: expect.stringContaining("row 2, column 'y'") });
  expect(invalid[5]).toMatchObject({ message: expect.stringContaining('explicit time zone') });
  await expect(cell.getByText('"after"', { exact: true })).toBeVisible();
  const boundary = await run(4);
  expect(boundary.map((result) => result.status)).toEqual(['valid', 'valid', 'error', 'valid', 'error']);
  const fresh = await run(5);
  expect(fresh).toHaveLength(1);
  expect(fresh[0]).toMatchObject({ artifact: { title: 'Fresh run' } });
  await expect(cell.getByTestId('doc-plot')).toHaveCount(1);
});
