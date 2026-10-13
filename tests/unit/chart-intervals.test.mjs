// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'band',
  series: [
    {
      points: [
        [0, -3, -5, -2],
        [1, 0, -2, 3],
        [2, 4, 3, 6]
      ]
    }
  ]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

it.each(['band', 'errorbar'])('renders signed %s intervals and preserves their original values', (kind) => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    const result = validate({ kind });
    expect(result.status).toBe('valid');
    const options = chartSpecToEChartsOptions(result.artifact.spec);
    chart.setOption(options);
    expect(chart.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0)).toBeDefined();
    const svg = chart.renderToSVGString();
    expect(svg).not.toMatch(/NaN|Infinity/);
    expect(options.tooltip.formatter({ value: options.series[0].data[0] })).toContain('Lower boundary: -5');
    expect(chartToTable(result.artifact.spec, labelsForLanguage('en')).rows[0]).toEqual(['Series 1', 0, -3, -5, -2]);
    chart.dispatchAction({ type: 'dataZoom', startValue: kind === 'band' ? 0.25 : -0.25, endValue: 0.75 });
    expect(chart.getModel().getSeriesByIndex(0).getData().count()).toBeGreaterThan(0);
  } finally {
    chart.dispose();
  }
});

it.each([
  { series: [{ points: [[0, 1, 2, 3]] }] },
  { series: [{ points: [[0, 1, null, 3]] }] },
  {
    series: [
      {
        points: [
          [1, 1, 0, 2],
          [0, 1, 0, 2]
        ]
      }
    ]
  },
  { series: [{ points: [[0, 1, 0, 2, 3]] }] },
  { yType: 'log' },
  { xType: 'category' },
  { yType: 'time' }
])('rejects invalid intervals %j', (patch) => expect(validate(patch).status).toBe('error'));

it.each(
  [
    [],
    [[0, 2, 2, 2]],
    [[0, null, null, null]],
    [
      [0, 2, 1, 3],
      [1, null, null, null],
      [2, 1, 0, 2]
    ]
  ].map((points) => ({ points }))
)('renders empty, degenerate and disconnected bands: %j', ({ points }) => {
  expect(validate({ series: [{ points }] }).status).toBe('valid');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
  try {
    chart.setOption(chartSpecToEChartsOptions({ ...spec, series: [{ points }] }));
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
  } finally {
    chart.dispose();
  }
});
