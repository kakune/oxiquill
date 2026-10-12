// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { bubbleSizeMapping } from '../../packages/oxiquill/src/lib/doc-runtime/chart-bubble';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'bubble',
  colorMapping: { min: 0, max: 10 },
  series: [
    {
      points: [
        [0, 1, 1, 2],
        [1, 2, 4, 8],
        [2, 3, 0, null],
        [3, 1, 4]
      ]
    }
  ]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

it('makes area proportional, handles zero and constant domains, and bounds explicit mappings', () => {
  const map = bubbleSizeMapping(spec);
  expect(map.diameter(4) / map.diameter(1)).toBe(2);
  expect(map.diameter(0)).toBe(0);
  expect(map.diameter(Number.MAX_VALUE)).toBe(40);
  expect(
    bubbleSizeMapping({ ...spec, sizeMapping: { scale: 'radius', minPixels: 4, maxPixels: 80, maxValue: 8 } }).diameter(
      4
    )
  ).toBe(40);
  expect(
    bubbleSizeMapping({
      ...spec,
      series: [
        {
          points: [
            [0, 0, 5],
            [1, 1, 5]
          ]
        }
      ]
    }).diameter(5)
  ).toBe(40);
  expect(bubbleSizeMapping({ ...spec, series: [] }).diameter(0)).toBe(0);
});

it('renders per-point sizes and colors while missing colors retain the series color', () => {
  const result = validate({});
  expect(result.status).toBe('valid');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    const options = chartSpecToEChartsOptions(result.artifact.spec);
    chart.setOption(options);
    const data = chart.getModel().getSeriesByIndex(0).getData();
    expect(data.getItemVisual(1, 'symbolSize') / data.getItemVisual(0, 'symbolSize')).toBe(2);
    expect(data.getItemVisual(2, 'symbolSize')).toBe(0);
    expect(data.getItemVisual(3, 'style').fill).toBe(options.series[0].itemStyle.color);
    expect(data.getItemVisual(0, 'style').fill).not.toBe(data.getItemVisual(1, 'style').fill);
    expect(options.series[0].large).toBe(false);
    expect(options.tooltip.formatter({ value: [0, 1, 4, 8] })).toContain('Size: 4');
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
  } finally {
    chart.dispose();
  }
});

it.each([
  { sizeMapping: { maxValue: 0 } },
  { sizeMapping: { minPixels: 50 } },
  { sizeMapping: { maxPixels: 101 } },
  { sizeMapping: { scale: 'volume' } },
  { colorMapping: { min: 2, max: 1 } },
  { colorMapping: null },
  { series: [{ points: [[0, 0, -1]] }] },
  { series: [{ points: [[0, 0]] }] },
  { series: [{ points: [[0, 0, 1, 2, 3]] }] }
])('rejects invalid mappings and dimensions %j', (patch) => expect(validate(patch).status).toBe('error'));

it('requires a color mapping only when a point supplies a color value', () => {
  const without = { ...spec };
  delete without.colorMapping;
  expect(validateOutputArtifacts([{ kind: 'chart', spec: without }])[0].status).toBe('error');
  expect(
    validateOutputArtifacts([
      {
        kind: 'chart',
        spec: {
          ...without,
          series: [
            {
              points: [
                [0, 1, 2],
                [1, 2, 3, null]
              ]
            }
          ]
        }
      }
    ])[0].status
  ).toBe('valid');
});
