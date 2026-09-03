// @vitest-environment node

import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/components/doc-runtime/ChartOutput';

const requireFromPackage = createRequire(resolve(process.cwd(), 'packages/oxiquill/package.json'));
const echarts = requireFromPackage('echarts');
const charts = [];

afterEach(() => {
  charts.splice(0).forEach((chart) => chart.dispose());
});

describe('real ECharts heatmap rendering', () => {
  it('renders inferred numeric categories', () => {
    const chart = renderHeatmap({
      kind: 'heatmap',
      data: [
        [0, 0, 1],
        [1, 0, 2]
      ]
    });

    expect(chart.getModel().getSeriesByIndex(0).getData().count()).toBe(2);
    expect(chart.renderToSVGString()).toContain('<svg');
  });

  it('renders explicit numeric category indices as their canonical names', () => {
    const chart = renderHeatmap({
      kind: 'heatmap',
      xCategories: ['first', 'second'],
      yCategories: ['row'],
      data: [[1, 0, 7]]
    });
    const data = chart.getModel().getSeriesByIndex(0).getData();

    expect(data.count()).toBe(1);
    expect(data.getRawDataItem(0)).toEqual(['second', 'row', 7]);
    expect(chart.renderToSVGString()).toContain('<svg');
  });

  it('renders an empty categorical heatmap', () => {
    const chart = renderHeatmap({ kind: 'heatmap', data: [] });

    expect(chart.getModel().getSeriesByIndex(0).getData().count()).toBe(0);
    expect(chart.renderToSVGString()).toContain('<svg');
  });
});

function renderHeatmap(spec) {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 320, height: 240 });
  charts.push(chart);
  expect(() => chart.setOption(chartSpecToEChartsOptions(spec))).not.toThrow();
  return chart;
}
