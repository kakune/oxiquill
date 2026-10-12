// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import {
  chartSpecToEChartsOptions,
  defaultChartChrome
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { chartPalette } from '../../packages/oxiquill/src/lib/doc-runtime/chart-palette';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = {
  kind: 'boxplot',
  categories: ['First', 'Constant', 'Missing'],
  series: [{ values: [[-5, -3, -2, 0, 4], [2, 2, 2, 2, 2], null] }]
};
const validate = (patch) => validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch } }])[0];

it.each(['light', 'dark'])('renders supplied five-number summaries in %s', (theme) => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
  try {
    const result = validate({});
    expect(result.status).toBe('valid');
    const options = chartSpecToEChartsOptions(result.artifact.spec, theme);
    chart.setOption(options);
    expect(chart.getModel().getSeriesByIndex(0).getData().getItemGraphicEl(0)).toBeDefined();
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
    expect(options.tooltip.formatter({ name: 'First', value: [0, -5, -3, -2, 0, 4] })).toContain('Median: -2');
    expect(chartToTable(result.artifact.spec, labelsForLanguage('en')).rows[0]).toEqual([
      'Series 1',
      'First',
      -5,
      -3,
      -2,
      0,
      4
    ]);
    chart.setOption(chartSpecToEChartsOptions({ ...result.artifact.spec, categories: [], series: [] }), {
      replaceMerge: ['series']
    });
    expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
  } finally {
    chart.dispose();
  }
});

it.each([
  { series: [{ values: [[1, 3, 2, 4, 5], null, null] }] },
  { series: [{ values: [[1, 2, 3, 4], null, null] }] },
  { series: [{ values: [[1, 2, 3, 4, Infinity], null, null] }] },
  { series: [{ values: [] }] },
  { xType: 'value' },
  { yType: 'time' },
  { yType: 'log' }
])('rejects invalid boxplots %j', (patch) => expect(validate(patch).status).toBe('error'));

it.each(['light', 'dark'])('keeps the median visible inside series-colored boxes in %s', (theme) => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
  try {
    const authored = validate({
      series: [
        { values: [[-5, -3, -2, 0, 4], null, null] },
        { style: { color: '#b91c1c' }, values: [[1, 2, 3, 4, 8], null, null] }
      ]
    });
    chart.setOption({ ...chartSpecToEChartsOptions(authored.artifact.spec, theme), animation: false });
    const boxes = (chart.renderToSVGString().match(/<path [^>]*ecmeta_series_index="[01]"[^>]*>/gu) ?? []).filter(
      (path) => path.includes('ecmeta_ssr_type="chart"')
    );
    const paint = boxes.map((box) => [/fill="([^"]+)"/u.exec(box)?.[1], /stroke="([^"]+)"/u.exec(box)?.[1]]);
    expect(paint).toEqual([
      [defaultChartChrome(theme).background, chartPalette[0]],
      [defaultChartChrome(theme).background, '#b91c1c']
    ]);
  } finally {
    chart.dispose();
  }
});
