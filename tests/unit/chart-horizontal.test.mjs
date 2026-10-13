// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import {
  chartSpecToEChartsOptions,
  chartDataSummary,
  chartResizeOptions
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'bar',
  orientation: 'horizontal',
  categories: ['Long first category', 'Second', 'Missing'],
  series: [{ values: [4, -2, null] }],
  xLabel: 'Amount',
  yLabel: 'Category'
};

it('uses screen axes for horizontal bars, formats, summaries, tables, and zoom', () => {
  const result = validateOutputArtifacts([{ kind: 'chart', spec }])[0];
  expect(result.status).toBe('valid');
  const options = chartSpecToEChartsOptions(spec);
  expect(options.xAxis).toMatchObject({ type: 'value', scale: false });
  expect(options.yAxis).toMatchObject({ type: 'category', inverse: true, data: spec.categories });
  expect(options.dataZoom[0]).toMatchObject({ yAxisIndex: 0 });
  expect(options.tooltip.formatter([{ value: 4, name: spec.categories[0] }])).toContain('Long first category<br/>4');
  expect(chartToTable(spec, labelsForLanguage('en')).rows[0]).toEqual(['Series 1', 4, spec.categories[0]]);
  expect(chartDataSummary(spec, labelsForLanguage('en'))).toContain('-2–4');
  expect(chartResizeOptions(spec, { x: 0, y: 3 }, 360, 360).yAxis.axisLabel.formatter(spec.categories[0])).toContain(
    '…'
  );
});

it.each([
  { orientation: 'diagonal' },
  { xType: 'category' },
  { yType: 'value' },
  { xMin: 1 },
  { xIncludeZero: false },
  { yMin: 0 },
  { style: { yFormat: { unit: 'm' } } }
])('rejects mismatched horizontal settings %j', (patch) => {
  expect(validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0].status).toBe('error');
});

it('renders proportional signed bars and changes orientation on update', () => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
  try {
    for (const orientation of ['horizontal', 'vertical']) {
      chart.setOption(chartSpecToEChartsOptions({ ...spec, orientation }), { notMerge: true });
      const data = chart.getModel().getSeriesByIndex(0).getData();
      const dimension = orientation === 'horizontal' ? 'width' : 'height';
      expect(Math.abs(data.getItemLayout(0)[dimension] / data.getItemLayout(1)[dimension])).toBeCloseTo(2);
      expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    }
  } finally {
    chart.dispose();
  }
});
