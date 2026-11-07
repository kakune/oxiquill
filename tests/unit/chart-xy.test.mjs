import { validateChartArtifact } from '../../packages/oxiquill/src/lib/doc-runtime/output-validation-chart';
// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions, chartDataSummary } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import { chartFixtures } from '../fixtures/chart-specs';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = chartFixtures.mixedXy;
const validate = (value) => validateOutputArtifacts([{ kind: 'chart', spec: value }])[0];

it('renders ordered layers, shared bounds, annotations and original table coordinates', () => {
  const result = validate(spec);
  expect(result.status).toBe('valid');
  const options = chartSpecToEChartsOptions(result.artifact.spec);
  expect(options.series.map(({ type }) => type)).toEqual(['custom', 'line', 'scatter', 'line']);
  expect(options.series[1].lineStyle.type).toBe('dashed');
  expect(options.series[2].data).toEqual(spec.layers[2].points);
  expect(options.xAxis.min).toBe(0);
  expect(options.yAxis.max).toBe(6);
  const table = chartToTable(result.artifact.spec, labelsForLanguage('en'));
  expect(table.rows[0]).toEqual(['band', 'band', 'Uncertainty', 0, 1, 0.5, 1.5]);
  expect(table.rows.at(-1)).toEqual(['samples', 'scatter', 'Samples', 2, 3.2, null, null]);
  expect(chartDataSummary(result.artifact.spec, labelsForLanguage('en'))).toContain('8');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    chart.setOption(options);
    expect(chart.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0)).toBeDefined();
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    expect(options.tooltip.formatter({ seriesId: 'xy:id:band', value: options.series[0].data[0] })).toContain(
      'Lower boundary: 0.5'
    );
    chart.dispatchAction({ type: 'legendUnSelect', name: 'xy:id:samples' });
    const reversed = { ...spec, layers: spec.layers.toReversed() };
    chart.setOption(chartSpecToEChartsOptions(reversed, 'dark'), { replaceMerge: ['series'] });
    expect(chart.getOption().legend[0].selected['xy:id:samples']).toBe(false);
    expect(chartSpecToEChartsOptions(reversed, 'dark').series[1].lineStyle.color).toBe('#88bbff');
  } finally {
    chart.dispose();
  }
});

it.each([
  { id: '' },
  { id: 'reference' },
  { id: undefined },
  { kind: 'bar' },
  { stack: 'total' },
  { xType: 'value' },
  { style: { lineType: 'dashed' } },
  { points: [[0, 3, 4, 5]] },
  {
    points: [
      [1, 1, 0, 2],
      [0, 1, 0, 2]
    ]
  },
  { points: [[0, 1, null, 2]] },
  { points: [[0, Infinity, 0, 2]] }
])('rejects invalid layers with index and ID diagnostics: %j', (patch) => {
  const result = validate({ ...spec, layers: [{ ...spec.layers[0], ...patch }, ...spec.layers.slice(1)] });
  expect(result.status).toBe('error');
  expect(result.message).toContain(patch.id === 'reference' ? 'XY layer 2 (reference)' : 'XY layer 1');
  if (typeof patch.id !== 'string' || patch.id === undefined) {
    if (!Object.hasOwn(patch, 'id')) expect(result.message).toContain('(band)');
  }
});

it.each([
  { xType: 'category' },
  { xType: 'log' },
  { yType: 'time' },
  { yType: 'category' },
  { yType: 'log', layers: [{ id: 'bad', kind: 'line', points: [[0, 0]] }] }
])('rejects incompatible axes and log coordinates: %j', (patch) => {
  expect(validate({ ...spec, ...patch }).status).toBe('error');
});

it('accepts empty layers, time/log coordinates, and band gaps without projecting table values', () => {
  const time = '2026-01-01T00:00:00Z';
  const value = {
    kind: 'xy',
    xType: 'time',
    yType: 'log',
    layers: [
      { id: 'empty', kind: 'scatter', points: [] },
      {
        id: 'gap',
        kind: 'band',
        points: [
          [time, 2, 1, 3],
          ['2026-01-02T00:00:00Z', null, null, null]
        ]
      }
    ]
  };
  expect(validate(value).status).toBe('valid');
  expect(chartToTable(value, labelsForLanguage('en')).rows[0][3]).toBe(time);
  expect(validate({ kind: 'xy', layers: [] }).status).toBe('valid');
});

it('counts all layers against aggregate limits and isolates errors from other outputs', () => {
  const points = Array.from({ length: 50001 }, (_, x) => [x, 1]);
  const large = {
    kind: 'xy',
    layers: [
      { id: 'a', kind: 'line', points },
      { id: 'b', kind: 'scatter', points }
    ]
  };
  const results = validateOutputArtifacts([
    { kind: 'chart', spec: large },
    { kind: 'text', stream: 'stdout', content: 'still here' }
  ]);
  expect(results.map(({ status }) => status)).toEqual(['error', 'valid']);
  expect(results[0].message).toContain('100002');
  expect(
    validate({
      kind: 'xy',
      layers: Array.from({ length: 100001 }, (_, id) => ({ id: String(id), kind: 'scatter', points: [] }))
    }).status
  ).toBe('error');
});

it('applies the remaining run byte budget to the complete mixed spec', () => {
  expect(() => validateChartArtifact({ kind: 'chart', spec }, 1)).toThrow('remaining 16 MiB run limit');
});

it('counts an empty layer as an item at the aggregate boundary', () => {
  const full = {
    kind: 'xy',
    layers: [{ id: 'full', kind: 'scatter', points: Array.from({ length: 100000 }, (_, x) => [x, 1]) }]
  };
  expect(validate(full).status).toBe('valid');
  expect(validate({ ...full, layers: [...full.layers, { id: 'empty', kind: 'line', points: [] }] }).message).toContain(
    '100001'
  );
});
