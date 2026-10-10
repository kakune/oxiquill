// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const line = {
  kind: 'line',
  series: [
    {
      points: [
        [0, 0.2],
        [1, 0.8]
      ]
    }
  ]
};
const validate = (spec) => validateOutputArtifacts([{ kind: 'chart', spec }])[0];

describe('authored axis ranges', () => {
  it.each([
    { yMin: 1, yMax: 1 },
    { yMin: 2, yMax: 1 },
    { xMin: Infinity },
    { xMax: null },
    { yMin: '0' },
    { xType: 'category', xMin: 0 },
    { xType: 'time', xMin: '2024-01-01' },
    { xType: 'time', xMin: 1e20 },
    { xType: 'log', xMin: 0 },
    { yType: 'log', yMax: -1 },
    { xType: 'time', xIncludeZero: false },
    { yType: 'category', yIncludeZero: true },
    { xIncludeZero: 'yes' }
  ])('rejects incompatible ranges %j', (patch) => {
    expect(validate({ ...line, ...patch }).status).toBe('error');
  });
  it.each(['bar', 'histogram', 'area'])('requires a zero baseline for %s', (kind) => {
    const spec =
      kind === 'bar'
        ? { kind, categories: [], series: [] }
        : kind === 'histogram'
          ? { kind, bins: [] }
          : { kind, series: [] };
    for (const patch of [{ yMin: 1 }, { yMax: -1 }, { yIncludeZero: false }])
      expect(validate({ ...spec, ...patch }).status).toBe('error');
    expect(validate({ ...spec, yMin: -1, yMax: 1 }).status).toBe('valid');
  });
  it('accepts value, time, and positive log bounds and keeps explicit bounds ahead of zero inclusion', () => {
    for (const patch of [
      { yMin: 1, yIncludeZero: true },
      { xType: 'time', xMin: 0 },
      { yType: 'log', yMin: 0.1 }
    ]) {
      const result = validate({ ...line, ...patch });
      expect(result.status).toBe('valid');
      expect(result.artifact.spec).toMatchObject(patch);
    }
  });
  it.each(
    [
      [],
      [[0, 0.5]],
      [
        [0, 0.5],
        [1, 0.5]
      ],
      [
        [0, 0.2],
        [1, 0.8]
      ]
    ].map((points) => ({ points }))
  )('keeps fixed ranges for %j and clears them on merge', ({ points }) => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
    try {
      const spec = { ...line, series: [{ points }], yMin: 0, yMax: 1 };
      chart.setOption(chartSpecToEChartsOptions(spec));
      expect(chart.getModel().getComponent('yAxis').axis.scale.getExtent()).toEqual([0, 1]);
      chart.setOption(
        chartSpecToEChartsOptions({
          ...line,
          series: [
            {
              points: [
                [0, 10],
                [1, 20]
              ]
            }
          ]
        })
      );
      expect(chart.getModel().getComponent('yAxis').axis.scale.getExtent()).toEqual([10, 20]);
    } finally {
      chart.dispose();
    }
  });
  it('supports one-sided bounds and explicit zero inclusion', () => {
    const options = chartSpecToEChartsOptions({ ...line, xMin: -5, yIncludeZero: true });
    expect(options.xAxis).toMatchObject({ min: -5, max: null, scale: true });
    expect(options.yAxis).toMatchObject({ min: null, max: null, scale: false });
  });
});
