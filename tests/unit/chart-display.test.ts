import { describe, expect, it } from 'vitest';
import {
  chartHeight,
  categoryLabelLayout,
  truncateChartLabel
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-layout';
import { chartDataSummary, chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';

describe('chart display contracts', () => {
  it('uses bounded automatic heights and explicit author heights', () => {
    expect(chartHeight({ kind: 'line', series: [] })).toBe(360);
    expect(chartHeight({ kind: 'heatmap', data: [] })).toBe(240);
    expect(chartHeight({ kind: 'heatmap', data: Array.from({ length: 100 }, (_, y) => [0, y, 1]) })).toBe(720);
    expect(chartHeight({ kind: 'line', series: [], style: { height: 200 } })).toBe(200);
  });
  it('truncates graphemes and rotates before thinning categories', () => {
    expect(truncateChartLabel('e\u0301e\u0301', 12)).toBe('e\u0301…');
    expect(truncateChartLabel('🧑🏽‍🔬 lab', 12)).toBe('🧑🏽‍🔬…');
    expect(truncateChartLabel('label', 0)).toBe('…');
    expect(truncateChartLabel('label', 100)).toBe('label');
    expect(categoryLabelLayout(6, 600, true, 720)).toMatchObject({ interval: 0, rotate: 0 });
    expect(categoryLabelLayout(6, 240, true, 360)).toMatchObject({ interval: 0, rotate: 45 });
    expect(categoryLabelLayout(100, 240, true, 360).interval).toBeGreaterThan(0);
  });
  it('formats both scatter coordinates and preserves complete escaped labels', () => {
    const tooltip = chartSpecToEChartsOptions({
      kind: 'scatter',
      series: [{ name: '<script> & observation', points: [[1998, 0.1 + 0.2]] }]
    }).tooltip as { formatter: (value: unknown) => string };
    expect(tooltip.formatter({ seriesIndex: 0, value: [1998, 0.1 + 0.2] })).toBe(
      '&lt;script&gt; &amp; observation: 1998: 0.3'
    );
    expect(tooltip.formatter(null)).toBe('');
    const heat = chartSpecToEChartsOptions({ kind: 'heatmap', data: [['Long X', 'Long Y', 0.857]] }).tooltip as {
      formatter: (value: unknown) => string;
    };
    expect(heat.formatter({ value: ['Long X', 'Long Y', 0.857] })).toBe('Long X / Long Y: 0.857');
    const bar = chartSpecToEChartsOptions({ kind: 'bar', categories: ['Full category'], series: [{ values: [0.3] }] })
      .tooltip as { formatter: (value: unknown) => string };
    expect(bar.formatter([{ name: 'Full category', value: 0.3 }])).toBe('Full category<br/>0.3');
  });
  it('keeps full axis names in summaries and uses localized unnamed series', () => {
    const spec: ChartSpec = {
      kind: 'line',
      xLabel: 'x'.repeat(16000),
      yLabel: 'Value',
      series: [{ points: [[0, 1]] }, { points: [[1, 2]] }]
    };
    expect(chartDataSummary(spec, labelsForLanguage('en'))).toContain(spec.xLabel);
    expect(chartDataSummary(spec, labelsForLanguage('ja'))).toContain('系列 1');
    const legend = chartSpecToEChartsOptions(spec, 'light', { locale: 'ja' }).legend as {
      formatter: (name: string) => string;
    };
    expect(legend.formatter('line:1')).toBe('系列 2');
  });
  it('orients heat color legends responsively and formats fractional limits', () => {
    const spec: ChartSpec = {
      kind: 'heatmap',
      data: [
        [0, 0, 0],
        [1, 0, 0.857]
      ]
    };
    const small = chartSpecToEChartsOptions(spec, 'light', { width: 360 }).visualMap as {
      orient: string;
      formatter: (v: number) => string;
    };
    expect(small.orient).toBe('horizontal');
    expect(small.formatter(0.857)).toBe('0.857');
    expect(chartSpecToEChartsOptions(spec, 'dark', { width: 720 }).visualMap).toMatchObject({ orient: 'vertical' });
  });
  it('marks isolated points, negative bar tips, and zero crossings', () => {
    expect(chartSpecToEChartsOptions({ kind: 'area', series: [{ points: [[0, 1]] }] }).series[0]).toMatchObject({
      showSymbol: true,
      areaStyle: { origin: 0 }
    });
    const spec: ChartSpec = { kind: 'bar', categories: ['a', 'b', 'c'], series: [{ values: [-1, 2, null] }] };
    expect(chartSpecToEChartsOptions(spec).series[0]).toMatchObject({
      data: [{ value: -1, itemStyle: { borderRadius: [0, 0, 3, 3] } }, 2, null]
    });
    expect(chartSpecToEChartsOptions(spec).series.find((series) => series.id === 'oxiquill:annotations')).toMatchObject(
      { markLine: { data: [{ yAxis: 0 }] } }
    );
    expect(chartSpecToEChartsOptions({ ...spec, series: [{ values: [1, 2, null] }] }).xAxis).toMatchObject({
      axisLine: { show: false }
    });
    expect(
      chartSpecToEChartsOptions({ ...spec, yType: 'log', series: [{ values: [1, 2, null] }] }).xAxis
    ).toMatchObject({ axisLine: { show: false } });
  });
  it('retains markers, escapes authored text, and shows missing values under one axis heading', () => {
    const tooltip = chartSpecToEChartsOptions({
      kind: 'bar',
      categories: ['<B>'],
      series: [
        { name: '<S>', values: [null] },
        { name: 'Other', values: [2] }
      ]
    }).tooltip as { formatter: (value: unknown) => string };
    expect(
      tooltip.formatter([
        { name: '<B>', value: null, seriesIndex: 0, marker: '<span>●</span>' },
        { name: '<B>', value: 2, seriesIndex: 1, marker: '<span>◆</span>' }
      ])
    ).toBe('&lt;B&gt;<br/><span>●</span>&lt;S&gt;: -<br/><span>◆</span>Other: 2');
    expect(
      chartDataSummary({ kind: 'line', xLabel: '横軸', yLabel: '縦軸', series: [] }, labelsForLanguage('ja'))
    ).toBe('横軸。縦軸。グラフにデータがありません。');
  });
});
