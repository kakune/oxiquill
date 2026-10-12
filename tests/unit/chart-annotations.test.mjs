// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions, chartDataSummary } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const spec = { kind: 'line', series: [], xMin: 0, xMax: 10, yMin: 0, yMax: 1 };
const line = { kind: 'line', axis: 'y', value: 0.5, label: 'Threshold' };
const range = { kind: 'range', axis: 'x', from: 2, to: 4, label: 'Window' };
const validate = (annotations, patch = {}) =>
  validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, ...patch, annotations } }])[0];

it('renders annotations without data, clips them, and removes them on rerun', () => {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    const result = validate([line, range]);
    expect(result.status).toBe('valid');
    chart.setOption(chartSpecToEChartsOptions(result.artifact.spec));
    expect(chart.renderToSVGString()).toContain('Threshold');
    expect(chart.renderToSVGString()).toContain('Window');
    expect(chartDataSummary(result.artifact.spec, labelsForLanguage('en'))).toContain('Threshold: Y: 0.5');
    chart.setOption(chartSpecToEChartsOptions({ ...spec, annotations: [{ ...line, value: 2 }] }), {
      replaceMerge: ['series']
    });
    expect(chart.renderToSVGString()).not.toContain('Threshold');
    chart.setOption(chartSpecToEChartsOptions(spec), { replaceMerge: ['series'] });
    expect(chart.getModel().getSeries()).toHaveLength(0);
  } finally {
    chart.dispose();
  }
});

it.each(
  [
    [{ ...line, axis: 'z' }],
    [{ ...line, kind: 'markLine' }],
    [{ ...line, value: Infinity }],
    [{ ...line, label: 'あ'.repeat(86) }],
    [{ ...line, label: 'two\nlines' }],
    [{ ...line, style: { width: 10 } }],
    [{ ...line, style: { color: 'red' } }],
    [{ ...line, style: { lineType: 'dash' } }],
    [{ ...line, style: { formatter: 'code' } }],
    [{ ...range, to: 1 }],
    [{ ...range, style: { opacity: 2 } }],
    Array.from({ length: 101 }, () => line)
  ].map((annotations) => ({ annotations }))
)('rejects invalid declarations: %j', ({ annotations }) => expect(validate(annotations).status).toBe('error'));

it('validates category references and positive log positions', () => {
  const category = { kind: 'bar', categories: ['A', 'B'], series: [], xMin: undefined, xMax: undefined };
  const base = { ...spec };
  delete base.xMin;
  delete base.xMax;
  const validateCategory = (value) =>
    validateOutputArtifacts([
      {
        kind: 'chart',
        spec: {
          ...base,
          kind: category.kind,
          categories: category.categories,
          annotations: [{ ...line, axis: 'x', value }]
        }
      }
    ])[0];
  expect(validateCategory(1)).toMatchObject({ status: 'valid', artifact: { spec: { annotations: [{ value: 'B' }] } } });
  expect(validateCategory('C').status).toBe('error');
  expect(validate([{ ...line, value: 0 }], { yType: 'log', yMin: 0.1 }).status).toBe('error');
  expect(validate(Array.from({ length: 100 }, () => line)).status).toBe('valid');
});
