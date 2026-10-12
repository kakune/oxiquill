// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { heatmapColorScale } from '../../packages/oxiquill/src/lib/doc-runtime/chart-color-scale';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'heatmap',
  colorScale: 'diverging',
  center: 0,
  colorMin: -2,
  colorMax: 8,
  data: [
    [0, 0, -2],
    [1, 0, 0],
    [2, 0, 8]
  ]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

it.each(['light', 'dark'])('anchors an asymmetric %s scale at its center and saturates outside bounds', (theme) => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    chart.setOption(chartSpecToEChartsOptions(spec, theme));
    const color = (index) => chart.getModel().getSeriesByIndex(0).getData().getItemVisual(index, 'style').fill;
    const midpoint = color(1);
    expect(midpoint).toBe(theme === 'light' ? 'rgba(229,231,235,1)' : 'rgba(75,85,99,1)');
    const first = color(0);
    chart.setOption(
      chartSpecToEChartsOptions(
        {
          ...spec,
          data: [
            [0, 0, -20],
            [1, 0, 0],
            [2, 0, 80]
          ]
        },
        theme
      )
    );
    expect(color(0)).toBe(first);
    expect(color(1)).toBe(midpoint);
    chart.dispatchAction({ type: 'selectDataRange', selected: [-0.5, 0.5] });
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
  } finally {
    chart.dispose();
  }
});

it('uses symmetric automatic extents and invertible color coordinates', () => {
  for (const values of [[2, 4], [-2, -4], [-2, 4], [0, 0], []]) {
    const scale = heatmapColorScale({
      kind: 'heatmap',
      colorScale: 'diverging',
      data: values.map((value, index) => [index, 0, value])
    });
    expect(scale.min).toBe(-scale.max);
    for (const value of values) expect(scale.unmap(scale.map(value))).toBeCloseTo(value);
  }
  expect(heatmapColorScale({ kind: 'heatmap', data: [] })).toMatchObject({ min: 0, max: 1 });
  expect(heatmapColorScale({ kind: 'heatmap', data: [[0, 0, 2]] })).toMatchObject({ min: 2, max: 2 });
  const options = chartSpecToEChartsOptions(spec);
  expect(options.visualMap.formatter(0)).toBe('0');
  expect(options.visualMap.formatter(1)).toBe('8');
  expect(options.tooltip.formatter({ value: options.series[0].data[2] })).toContain('8');
});

it.each([
  { center: 10 },
  { colorMin: 2 },
  { colorMin: 8 },
  { colorMax: -2 },
  { colorMin: Infinity },
  { colorScale: 'other' },
  { colorScale: 'sequential' },
  { style: { palette: { light: ['#123', '#456'] } } }
])('rejects inconsistent scales %j', (patch) => expect(validate(patch).status).toBe('error'));
