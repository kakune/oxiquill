// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chartSpecToEChartsOptions,
  chartDataSummary,
  chartStructuralSignature
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'histogram',
  bins: [
    [-1, -0.5, 2],
    [0, 2, 4]
  ]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

describe('numeric histogram intervals', () => {
  it('normalizes legacy axes without changing bin order or values', () => {
    const bins = [
      [0.3, 0.7, 4],
      [-1, -0.5, 2]
    ];
    expect(validate({ bins, xType: 'category', xMin: -2 })).toMatchObject({
      status: 'valid',
      artifact: { spec: { bins, xType: 'value', xMin: -2 } }
    });
    expect(chartStructuralSignature(spec)).toBe(chartStructuralSignature({ ...spec, xType: 'category' }));
  });
  it.each([
    {
      bins: [
        [0, 2, 1],
        [1, 3, 2]
      ]
    },
    {
      bins: [
        [0, 2, 1],
        [0, 2, 2]
      ]
    },
    { mode: 'probability' },
    { xType: 'time' },
    { yType: 'time' },
    { yType: 'log', bins: [[0, 1, 0]] },
    { mode: 'density', bins: [[0, Number.MIN_VALUE, 1]] },
    { mode: 'density', bins: [[-Number.MAX_VALUE, Number.MAX_VALUE, 1]] },
    { mode: 'density', yType: 'log', bins: [[0, Number.MAX_VALUE, Number.MIN_VALUE]] }
  ])('rejects invalid intervals or modes %j', (patch) => expect(validate(patch).status).toBe('error'));
  it.each(['count', 'density'])(
    'renders exact widths and heights in %s mode, including partially visible bins',
    (mode) => {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
      try {
        chart.setOption(chartSpecToEChartsOptions({ ...spec, mode, style: { animation: false } }));
        const shape = (index) => chart.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(index)?.shape;
        for (const [index, [lower, upper, count]] of spec.bins.entries()) {
          const rect = shape(index);
          const x = (value) => chart.convertToPixel({ xAxisIndex: 0 }, value);
          expect(rect.x).toBeCloseTo(x(lower));
          expect(rect.width).toBeCloseTo(x(upper) - x(lower));
          const height = mode === 'density' ? count / (upper - lower) : count;
          expect(rect.height).toBeCloseTo(
            chart.convertToPixel({ yAxisIndex: 0 }, 0) - chart.convertToPixel({ yAxisIndex: 0 }, height)
          );
        }
        chart.dispatchAction({ type: 'dataZoom', startValue: -0.75, endValue: 1 });
        const grid = chart.getModel().getComponent('grid').coordinateSystem.getRect();
        expect(shape(0).x).toBeCloseTo(grid.x);
        expect(shape(1).x + shape(1).width).toBeCloseTo(grid.x + grid.width);
        expect(shape(0).width).toBeGreaterThan(0);
        expect(shape(1).width).toBeGreaterThan(0);
      } finally {
        chart.dispose();
      }
    }
  );
  it.each([
    { bins: [] },
    { bins: [[-1, -0.5, 0]] },
    { bins: [[-1, -0.5, 1]] },
    {
      yType: 'log',
      bins: [
        [0, 1, 0.1],
        [1, 2, 10]
      ]
    }
  ])('renders empty, single, zero, and log bins %j', (patch) => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
    try {
      chart.setOption(chartSpecToEChartsOptions({ ...spec, ...patch }));
      expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    } finally {
      chart.dispose();
    }
  });
  it('formats intervals and identifies density in tooltips and summaries without changing the data', () => {
    const histogram = { ...spec, mode: 'density', bins: [[0.1 + 0.2, 0.7, 4]] };
    const option = chartSpecToEChartsOptions(histogram);
    const tuple = option.series[0].data[0];
    expect(tuple[0]).toBe(0.1 + 0.2);
    expect(option.tooltip.formatter({ value: tuple })).toBe('[0.3, 0.7): Density: 10');
    expect(chartDataSummary(histogram, labelsForLanguage('en'))).toContain('Density');
    expect(option.yAxis.name).toBe('Density');
  });
});
