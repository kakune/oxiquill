// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartSpecToEChartsOptions, chartSeriesId } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartPalette } from '../../packages/oxiquill/src/lib/doc-runtime/chart-palette';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const points = [
  [0, 1],
  [1, 2]
];
const series = [
  {
    id: 'a',
    name: 'Same',
    points,
    style: {
      color: { light: '#123', dark: '#456' },
      smooth: true,
      showSymbol: true,
      symbol: 'diamond',
      lineType: 'dotted'
    }
  },
  { id: 'b', name: 'Same', points }
];
const spec = { kind: 'line', series };
const validate = (spec) => validateOutputArtifacts([{ kind: 'chart', spec }])[0];

describe('series identity and styles', () => {
  it.each([
    { id: '' },
    { id: '  ' },
    { id: 3 },
    { style: { color: 'red' } },
    { style: { color: {} } },
    { style: { color: { light: '#ggg' } } },
    { style: { color: { light: '#123', other: '#456' } } },
    { style: { symbol: 'image://x' } },
    { style: { lineType: 'dashdot' } },
    { style: { step: true } },
    { style: { smooth: 'yes' } },
    { style: { showSymbol: 1 } },
    { style: { smooth: true, step: 'end' } },
    { style: { unknown: 1 } }
  ])('rejects invalid presentation %j', (patch) =>
    expect(validate({ kind: 'line', series: [{ points, ...patch }] }).status).toBe('error')
  );
  it('rejects duplicate IDs and fields unsupported by the series kind', () => {
    expect(validate({ ...spec, series: [series[0], series[0]] }).status).toBe('error');
    expect(validate({ kind: 'scatter', series: [series[0]] }).status).toBe('error');
    expect(
      validate({ kind: 'bar', categories: ['a'], series: [{ values: [1], style: { symbol: 'circle' } }] }).status
    ).toBe('error');
    expect(
      validate({
        kind: 'bar',
        categories: ['a'],
        series: [
          { id: 'a', values: [1] },
          { id: 'a', values: [2] }
        ]
      }).status
    ).toBe('error');
  });
  it('keeps legacy series valid and accepts appropriate presentation for every series kind', () => {
    expect(validate(spec).status).toBe('valid');
    for (const kind of ['line', 'area']) {
      expect(
        validate({
          kind,
          series: [{ points, style: { step: 'middle', smooth: false, symbol: 'none', showSymbol: false } }]
        }).status
      ).toBe('valid');
      expect(validate({ kind, series: [{ points }] }).status).toBe('valid');
    }
    expect(
      validate({ kind: 'scatter', series: [{ id: 'a', points, style: { symbol: 'rect', color: '#123' } }] }).status
    ).toBe('valid');
    expect(
      validate({
        kind: 'bar',
        categories: ['a'],
        series: [{ id: 'a', values: [1], style: { color: { dark: '#123' } } }]
      }).status
    ).toBe('valid');
    expect(chartSeriesId({ kind: 'line', series: [{ id: '0', points }, { points }] }, 0)).not.toBe('line:0');
  });
  it('resolves theme colors and gives explicit symbols and patterns priority over palette cycling', () => {
    expect(chartSpecToEChartsOptions(spec, 'dark').series[0]).toMatchObject({
      id: 'line:id:a',
      name: 'line:id:a',
      lineStyle: { color: '#456', type: 'dotted' },
      symbol: 'diamond',
      smooth: true,
      showSymbol: true
    });
    const options = chartSpecToEChartsOptions(
      {
        kind: 'scatter',
        style: { palette: { light: ['#000'] } },
        series: [{ points }, { points, style: { symbol: 'triangle', color: { dark: '#456' } } }]
      },
      'light'
    );
    expect(options.series[1]).toMatchObject({ symbol: 'triangle', itemStyle: { color: '#000' } });
    const legend = chartSpecToEChartsOptions(spec).legend;
    expect(legend.data).toEqual(['line:id:a', 'line:id:b']);
    expect(legend.formatter('line:id:a')).toBe('Same');
    expect(legend.formatter('line:id:b')).toBe('Same');
  });
  it('retains selection across reorder, rename, deletion, addition, and theme updates and clears removed styles', () => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
    const apply = (spec, theme = 'light') => {
      const options = chartSpecToEChartsOptions(spec, theme);
      delete options.dataZoom;
      chart.setOption(options, { replaceMerge: ['series'] });
    };
    try {
      apply(spec);
      chart.dispatchAction({ type: 'legendUnSelect', name: 'line:id:a' });
      const renamed = { id: 'a', name: 'Renamed', points };
      apply({ ...spec, series: [series[1], renamed] }, 'dark');
      let option = chart.getOption();
      expect(option.legend[0].selected['line:id:a']).toBe(false);
      expect(option.legend[0].selected['line:id:b']).toBe(true);
      expect(option.legend[0].data).toEqual(['line:id:b', 'line:id:a']);
      const index = option.series.findIndex((series) => series.id === 'line:id:a');
      expect(option.series[index]).toMatchObject({
        smooth: false,
        step: false,
        showSymbol: false,
        symbol: 'emptyCircle',
        lineStyle: { color: chartPalette[1], type: 'solid' }
      });
      expect(option.tooltip[0].formatter([{ seriesId: 'line:id:a', seriesIndex: index, value: [0, 1] }])).toContain(
        'Renamed: 1'
      );
      apply({ ...spec, series: [renamed] });
      expect(chart.getOption().series).toHaveLength(1);
      expect(chart.getOption().legend[0].selected['line:id:a']).toBe(false);
      apply({ ...spec, series: [{ id: 'c', name: 'New', points }, renamed] });
      option = chart.getOption();
      expect(option.series).toHaveLength(2);
      expect(option.legend[0].selected['line:id:a']).toBe(false);
    } finally {
      chart.dispose();
    }
  });
});
