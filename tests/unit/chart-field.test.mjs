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
  kind: 'field',
  xEdges: [-3, -1, 4],
  yEdges: [-2, 0, 3],
  values: [
    [1, 2],
    [null, 4]
  ]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

it('renders exact nonuniform grid rectangles and clips in both dimensions', () => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    const result = validate({});
    expect(result.status).toBe('valid');
    const options = chartSpecToEChartsOptions(result.artifact.spec);
    chart.setOption(options);
    const data = () => chart.getModel().getSeriesByIndex(0).getData();
    expect(data().count()).toBe(3);
    const shape = data().getItemGraphicEl(0).shape;
    const left = chart.convertToPixel({ xAxisIndex: 0 }, -3);
    const right = chart.convertToPixel({ xAxisIndex: 0 }, -1);
    expect(shape.x).toBeCloseTo(left);
    expect(shape.width).toBeCloseTo(right - left);
    const top = chart.convertToPixel({ yAxisIndex: 0 }, 0);
    const bottom = chart.convertToPixel({ yAxisIndex: 0 }, -2);
    expect(shape.y).toBeCloseTo(top);
    expect(shape.height).toBeCloseTo(bottom - top);
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 0, startValue: -2, endValue: 2 });
    chart.dispatchAction({ type: 'dataZoom', dataZoomIndex: 1, startValue: -1, endValue: 2 });
    const grid = chart.getModel().getComponent('grid').coordinateSystem.getRect();
    expect(data().getItemGraphicEl(0).shape.x).toBeCloseTo(grid.x);
    expect(data().getItemGraphicEl(0).shape.y + data().getItemGraphicEl(0).shape.height).toBeCloseTo(
      grid.y + grid.height
    );
    expect(options.tooltip.formatter({ value: [-3, -1, -2, 0, 1] })).toContain('X: [-3, -1), Y: [-2, 0): 1');
    expect(chartToTable(result.artifact.spec, labelsForLanguage('en')).rows[2]).toEqual([-3, -1, 0, 3, null]);
  } finally {
    chart.dispose();
  }
});

it.each([
  { xEdges: [0] },
  { xEdges: [-3, -3, 4] },
  { yEdges: [0, -1, 2] },
  { xEdges: [0, Infinity, 2] },
  { values: [[1, 2]] },
  { values: [[1], [2]] },
  {
    values: [
      [1, 2],
      [3, NaN]
    ]
  },
  { xType: 'category' },
  { yType: 'log' },
  { xEdges: [] }
])('rejects invalid fields %j', (patch) => expect(validate(patch).status).toBe('error'));

it('bounds cell allocation and renders an empty and a large known field', () => {
  expect(
    validate({
      xEdges: Array.from({ length: 1002 }, (_, i) => i),
      yEdges: Array.from({ length: 101 }, (_, i) => i),
      values: []
    }).status
  ).toBe('error');
  const empty = { kind: 'field', xEdges: [], yEdges: [], values: [] };
  expect(validate(empty).status).toBe('valid');
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    for (const field of [
      empty,
      {
        kind: 'field',
        xEdges: Array.from({ length: 201 }, (_, i) => i / 10),
        yEdges: Array.from({ length: 101 }, (_, i) => i / 10),
        values: Array.from({ length: 100 }, (_, y) =>
          Array.from({ length: 200 }, (_, x) => Math.sin(x / 10) * Math.cos(y / 10))
        )
      }
    ]) {
      chart.setOption(chartSpecToEChartsOptions(field), { notMerge: true });
      expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
      expect(chart.getModel().getSeriesByIndex(0).getData().count()).toBe(
        field.values.length * Math.max(0, field.xEdges.length - 1)
      );
    }
  } finally {
    chart.dispose();
  }
});
