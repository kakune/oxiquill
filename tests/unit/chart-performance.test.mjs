// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartDataSummary, chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';

const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const points = Array.from({ length: 100000 }, (_, index) => [index, index === 5000 ? 100 : 1]);
const line = { kind: 'line', series: [{ points }] };
const options = (spec) => chartSpecToEChartsOptions(spec, 'light', { reducedMotion: true });

describe('measured chart optimizations', () => {
  it.each([9999, 10000, 100000])('uses measured thresholds at %i points', (count) => {
    const data = Array.from({ length: count }, (_, index) => [index, 1]);
    expect(options({ ...line, series: [{ points: data }] }).series[0].sampling).toBe(count >= 100000 ? 'lttb' : 'none');
    expect(options({ kind: 'scatter', series: [{ points: data }] }).series[0]).toMatchObject({
      large: count >= 10000,
      largeThreshold: 0
    });
  });
  it.each([
    { kind: 'area' },
    { xType: 'category' },
    { xType: 'log' },
    { yType: 'log' },
    { yType: 'time' },
    { series: [{ points, style: { step: 'middle' } }] },
    { series: [{ points, style: { smooth: true } }] },
    { series: [{ points, style: { showSymbol: true } }] },
    { series: [{ points: points.toReversed() }] },
    { series: [{ points: points.map(([x, y], index) => [index === 5000 ? 4999 : x, y]) }] },
    { series: [{ points: points.map(([x, y], index) => [index === 5000 ? 0 : x, y]) }] },
    { series: [{ points: points.map(([x, y], index) => [x, index === 5000 ? null : y]) }] }
  ])('preserves the unsampled path for case %#', (patch) => {
    expect(options({ ...line, ...patch }).series[0].sampling).toBe('none');
  });
  it('supports monotone numeric and ISO time coordinates and unequal spacing', () => {
    for (const x of [(index) => index * 60000, (index) => new Date(index * 60000).toISOString()])
      expect(
        options({ ...line, xType: 'time', series: [{ points: points.map(([, y], index) => [x(index), y]) }] }).series[0]
          .sampling
      ).toBe('lttb');
    expect(options({ ...line, series: [{ points: points.map(([x, y]) => [x * x, y]) }] }).series[0].sampling).toBe(
      'lttb'
    );
  });
  it('never enables large mode for point-specific bubble size and color', () => {
    expect(
      options({ kind: 'bubble', series: [{ points: points.map(([x, y]) => [x, y, x % 9, x % 3]) }] }).series[0].large
    ).toBe(false);
  });
  it.each([
    { style: { symbolSize: 2 } },
    { style: { symbolSize: 3.9 } },
    { series: [{ points, style: { symbol: 'emptyCircle' } }] },
    { series: [{ points, style: { symbol: 'none' } }] }
  ])('retains authored scatter symbols for case %#', (patch) => {
    expect(options({ kind: 'scatter', series: [{ points }], ...patch }).series[0].large).toBe(false);
  });
  it('retains original values and the existing missing-coordinate rejection', () => {
    const before = structuredClone(line);
    expect(options(line).series[0].data).toBe(points);
    const labels = labelsForLanguage('en');
    expect(chartDataSummary(line, labels)).toContain('Data items: 100000');
    const table = chartToTable(line, labels);
    expect(table.rows).toHaveLength(10000);
    expect(table.rowCount).toBe(100000);
    expect(table.truncated).toBe(true);
    expect(line).toEqual(before);
    for (const missing of [null, NaN, Infinity])
      expect(
        validateOutputArtifacts([{ kind: 'chart', spec: { ...line, series: [{ points: [[0, missing]] }] } }])[0].status
      ).toBe('error');
  });
  it('preserves a spike, restores detail on zoom, and disables sampling on a compatible update', () => {
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 720, height: 360 });
    try {
      chart.setOption(options(line));
      const series = () => chart.getModel().getSeriesByIndex(0);
      expect(series().getData().count()).toBeLessThan(100000);
      expect(series().getData().getDataExtent('y')).toEqual([1, 100]);
      expect(chart.renderToSVGString()).toContain('<path');
      chart.dispatchAction({ type: 'dataZoom', startValue: 4990, endValue: 5010 });
      expect(series().getData().count()).toBe(21);
      expect(series().getData().getRawIndex(10)).toBe(5000);
      expect(series().getDataParams(10).value).toEqual([5000, 100]);
      chart.setOption(options({ ...line, series: [{ points: points.slice(0, 20) }] }), { replaceMerge: ['series'] });
      expect(series().get('sampling')).toBe('none');
    } finally {
      chart.dispose();
    }
  });
  it('preserves scatter styles and switches large mode off after shrinking', () => {
    const chart = echarts.init(null, undefined, { renderer: 'svg', ssr: true, width: 720, height: 360 });
    const spec = { kind: 'scatter', series: [{ points, style: { color: '#123456', symbol: 'diamond' } }] };
    try {
      const large = options(spec);
      large.series[0].progressive = 0;
      chart.setOption(large);
      expect(chart.renderToSVGString()).toContain('#123456');
      expect(chart.getModel().getSeriesByIndex(0).get('symbol')).toBe('diamond');
      chart.setOption(options({ ...spec, series: [{ ...spec.series[0], points: [[0, 1]] }] }), {
        replaceMerge: ['series']
      });
      expect(chart.getModel().getSeriesByIndex(0).pipelineContext.large).toBe(false);
    } finally {
      chart.dispose();
    }
  });
});
