import { describe, expect, it } from 'vitest';
import { chartNumberFormatter } from '../../packages/oxiquill/src/lib/doc-runtime/chart-format';
import { chartDataSummary, chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';
const line: ChartSpec = {
  kind: 'line',
  series: [
    {
      points: [
        [0, 0.1 + 0.2],
        [1, -0.0001]
      ]
    }
  ]
};

describe('authored number formats', () => {
  it.each(['en', 'ja'] as const)('scales decimal SI ticks without division artifacts in %s', (locale) => {
    for (const [value, expected] of [
      [0.7, '700 m'],
      [0.35, '350 m'],
      [5e-6, '5 µ'],
      [0.0018, '1.8 m'],
      [-0.7, '-700 m'],
      [0, '0']
    ] as const) {
      for (const ticks of [true, false]) {
        expect(chartNumberFormatter([value], locale, ticks, { notation: 'si' })(value)).toBe(expected);
      }
    }
    const ticks = chartNumberFormatter([0.7, 0.7000000000000001], locale, true, { notation: 'si', unit: 'V' });
    expect(ticks(0.7)).toBe('700 mV');
    expect(ticks(0.7000000000000001)).toBe('700.0000000000001 mV');
    expect(chartNumberFormatter([0.0018], locale, true, { notation: 'si', fractionDigits: 2 })(0.0018)).toBe('1.80 m');
    expect(chartNumberFormatter([0.0018], locale, true, { notation: 'si', significantDigits: 1 })(0.0018)).toBe('2 m');
    expect(chartNumberFormatter([0.9999996], locale, true, { notation: 'si' })(1)).toBe('1');
  });
  it.each(['en', 'ja'] as const)('formats precision, SI, units, and zero in %s', (locale) => {
    const fixed = chartNumberFormatter([0, 1], locale, false, { fractionDigits: 2, unit: 'V' });
    expect(fixed(0.1 + 0.2)).toBe('0.30 V');
    expect(fixed(-0.0001)).toBe('0.00 V');
    expect(fixed(-0)).toBe('0.00 V');
    expect(fixed(-0.1)).toBe('-0.10 V');
    expect(chartNumberFormatter([1], locale, false, { significantDigits: 3 })(1.23456)).toBe('1.23');
    for (const ticks of [true, false]) {
      expect(chartNumberFormatter([999.9996], locale, ticks, { notation: 'si', unit: 'V' })(1000)).toBe('1 kV');
      expect(chartNumberFormatter([1e-6], locale, ticks, { notation: 'si', unit: 'm' })(1e-6)).toBe('1 µm');
    }
    expect(chartNumberFormatter([1e-27], locale, false, { notation: 'si', unit: 'm' })(1e-27)).toBe('1×10⁻²⁷ m');
    expect(chartNumberFormatter([1e27], locale, false, { notation: 'si' })(1e27)).toBe('1×10²⁷');
    expect(chartNumberFormatter([0], locale, false, { notation: 'si', fractionDigits: 1 })(-0)).toBe('0.0');
    expect(chartNumberFormatter([1e-30], locale, false, { unit: 'm' })(1e-30)).toBe('1×10⁻³⁰ m');
    expect(chartNumberFormatter([1e3], locale, false, { notation: 'si', fractionDigits: 2, unit: 'V' })(-1e3)).toBe(
      '-1.00 kV'
    );
  });
  it.each([
    { significantDigits: 0 },
    { significantDigits: 18 },
    { significantDigits: 1.5 },
    { fractionDigits: -1 },
    { fractionDigits: 21 },
    { fractionDigits: Infinity },
    { fractionDigits: 2, significantDigits: 3 },
    { notation: 'compact' },
    { unit: 5 },
    { formatter: 'raw' },
    { notation: null }
  ])('rejects invalid format %j', (format) => {
    expect(validateOutputArtifacts([{ kind: 'chart', spec: { ...line, style: { yFormat: format } } }])[0].status).toBe(
      'error'
    );
  });
  it('rejects numeric formats on category/time axes and valueFormat outside heatmaps', () => {
    for (const patch of [
      { xType: 'category', style: { xFormat: { unit: 'V' } } },
      { yType: 'time', style: { yFormat: {} } },
      { style: { valueFormat: {} } }
    ])
      expect(validateOutputArtifacts([{ kind: 'chart', spec: { ...line, ...patch } }])[0].status).toBe('error');
  });
  it('aligns ticks, tooltips, and summaries and safely escapes units', () => {
    const spec = { ...line, style: { xFormat: { fractionDigits: 0 }, yFormat: { fractionDigits: 2, unit: '<V>&"' } } };
    expect(validateOutputArtifacts([{ kind: 'chart', spec }])[0].status).toBe('valid');
    const options = chartSpecToEChartsOptions(spec);
    const axis = options.yAxis as { axisLabel: { formatter: (v: number) => string } };
    const tooltip = options.tooltip as { formatter: (v: unknown) => string };
    expect(axis.axisLabel.formatter(0.1 + 0.2)).toBe('0.30 <V>&"');
    expect(tooltip.formatter([{ value: [0, 0.1 + 0.2] }])).toContain('0.30 &lt;V&gt;&amp;&quot;');
    expect(chartDataSummary(spec, labelsForLanguage('en'))).toContain('0.30 <V>&"');
    const defaultAxis = chartSpecToEChartsOptions(line).yAxis as typeof axis;
    expect(defaultAxis.axisLabel.formatter(0.3)).toBe('0.3');
    expect(line.series[0].points[0][1]).toBe(0.1 + 0.2);
  });
  it('formats the heatmap color scale and summary with the same value format', () => {
    const spec: ChartSpec = {
      kind: 'heatmap',
      data: [[0, 0, 0.1 + 0.2]],
      style: { valueFormat: { fractionDigits: 2, unit: 'V' } }
    };
    expect(validateOutputArtifacts([{ kind: 'chart', spec }])[0].status).toBe('valid');
    const map = chartSpecToEChartsOptions(spec).visualMap as { formatter: (value: number) => string };
    expect(map.formatter(0.1 + 0.2)).toBe('0.30 V');
    expect(chartDataSummary(spec, labelsForLanguage('ja'))).toContain('0.30 V');
  });
});
