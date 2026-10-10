// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  chartSpecToEChartsOptions,
  chartResizeOptions
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
import {
  chartAxes,
  chartPointIndexes,
  hasIsolatedPoint
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-viewport';
import { measureText } from './chart-svg-layout.mjs';

const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
echarts.setPlatformAPI({ measureText });

function withChart(spec, action, locale = 'en') {
  const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
  try {
    chart.setOption(chartSpecToEChartsOptions(spec, 'light', { reducedMotion: true, locale }));
    action(chart);
  } finally {
    chart.dispose();
  }
}

describe('real ECharts viewport regressions', () => {
  it.each(['en', 'ja'])('keeps calendar context and distinguishes fine time ticks in %s', (locale) => {
    for (const [start, end] of [
      ['2024-03-10T00:00:00Z', '2024-03-13T00:00:00Z'],
      ['2024-03-10T22:00:00Z', '2024-03-11T02:00:00Z'],
      ['2024-12-31T22:00:00Z', '2025-01-01T02:00:00Z']
    ]) {
      withChart(
        {
          kind: 'line',
          xType: 'time',
          series: [
            {
              points: [
                [start, 0],
                [end, 1]
              ]
            }
          ]
        },
        (chart) => {
          const labels = chart
            .getModel()
            .getComponent('xAxis')
            .axis.getViewLabels()
            .map((tick) => tick.formattedLabel);
          expect(labels.some((label) => /202[45]/u.test(label))).toBe(true);
          expect(labels.some((label) => /\d\d:\d\d/u.test(label))).toBe(true);
          for (let i = 1; i < labels.length; i++) expect(labels[i]).not.toBe(labels[i - 1]);
          expect(chart.renderToSVGString()).toMatch(/202[45]/u);
        },
        locale
      );
    }
    withChart(
      {
        kind: 'line',
        xType: 'time',
        series: [
          {
            points: [
              [0, 0],
              [600000, 1]
            ]
          }
        ]
      },
      (chart) => {
        chart.dispatchAction({ type: 'dataZoom', startValue: 1000, endValue: 1500 });
        const labels = chart
          .getModel()
          .getComponent('xAxis')
          .axis.getViewLabels()
          .map((tick) => tick.formattedLabel);
        expect(labels.length).toBeGreaterThan(2);
        expect(new Set(labels).size).toBe(labels.length);
        expect(chart.renderToSVGString()).toContain('00:00:01.');
      },
      locale
    );
  });

  it.each([
    {
      xType: 'value',
      points: [
        [3, 2],
        [1, 1],
        [2, 3]
      ],
      start: 1.5,
      end: 2.5
    },
    {
      xType: 'log',
      points: [
        [1000, 2],
        [1, 1],
        [10, 3]
      ],
      start: 5,
      end: 20
    },
    {
      xType: 'category',
      points: [
        ['c', 2],
        ['a', 1],
        ['b', 3]
      ],
      start: 'a',
      end: 'a'
    },
    {
      xType: 'time',
      points: [
        ['2024-03-11T00:00:00Z', 2],
        ['2024-03-10T00:00:00Z', 1],
        ['2024-03-10T01:00:00+00:00', 3]
      ],
      start: Date.parse('2024-03-10T00:30:00Z'),
      end: Date.parse('2024-03-10T01:30:00Z')
    }
  ])('finds the isolated point without sorting the authored $xType path', ({ xType, points, start, end }) => {
    const original = structuredClone(points);
    const spec = { kind: 'line', xType, series: [{ points }] };
    withChart(spec, (chart) => {
      const axes = chartAxes(chart);
      const [index] = chartPointIndexes(spec, axes);
      expect(hasIsolatedPoint(index, axes.x.getExtent(), axes.y.getExtent())).toBe(false);
      chart.dispatchAction({ type: 'dataZoom', startValue: start, endValue: end });
      const zoomed = chartAxes(chart);
      expect(hasIsolatedPoint(index, zoomed.x.getExtent(), zoomed.y.getExtent())).toBe(true);
      expect(points).toEqual(original);
    });
  });

  it('bounds searches at the end of 100,000 points and counts duplicate coordinates separately', () => {
    const points = Array.from({ length: 100000 }, (_, i) => [i, 1]);
    let reads = 0;
    const inspected = new Proxy(points, {
      get(target, property) {
        if (/^\d+$/u.test(String(property))) reads++;
        return Reflect.get(target, property);
      }
    });
    expect(hasIsolatedPoint({ x: inspected, y: inspected }, [99000, 99999], [0, 2])).toBe(false);
    expect(reads).toBeLessThan(100);
    expect(hasIsolatedPoint({ x: inspected, y: inspected }, [99999, 99999], [0, 2])).toBe(true);
    expect(hasIsolatedPoint({ x: [], y: [] }, [0, 1], [0, 1])).toBe(false);
    const duplicate = [
      [1, 1],
      [1, 1]
    ];
    expect(hasIsolatedPoint({ x: duplicate, y: duplicate }, [1, 1], [1, 1])).toBe(false);
  });

  it('retains the zero line when the first series is hidden', () => {
    const spec = {
      kind: 'line',
      series: [
        {
          name: 'A',
          points: [
            [0, -1],
            [1, 1]
          ]
        },
        {
          name: 'B',
          points: [
            [0, -2],
            [1, 2]
          ]
        }
      ]
    };
    withChart(spec, (chart) => {
      expect(chart.renderToSVGString()).toContain('stroke-width="1.5"');
      chart.dispatchAction({ type: 'legendUnSelect', name: 'line:0' });
      expect(chart.renderToSVGString()).toContain('stroke-width="1.5"');
    });
  });

  it('resizes layout without transmitting data or resetting interactive state', () => {
    const spec = {
      kind: 'line',
      series: [
        {
          name: 'A',
          points: [
            [0, 0],
            [1, 1],
            [2, 2]
          ]
        },
        {
          name: 'B',
          points: [
            [0, 2],
            [1, 3]
          ]
        }
      ]
    };
    withChart(spec, (chart) => {
      chart.dispatchAction({ type: 'dataZoom', start: 25, end: 75 });
      chart.dispatchAction({ type: 'legendUnSelect', name: 'line:1' });
      const before = chart.getOption();
      const patch = chartResizeOptions(spec, { x: 0, y: 0 }, 360, 360);
      expect(patch).not.toHaveProperty('series');
      expect(patch).not.toHaveProperty('dataZoom');
      chart.resize({ width: 360 });
      chart.setOption(patch);
      expect(chart.getOption().dataZoom).toEqual(before.dataZoom);
      expect(chart.getOption().legend[0].selected).toEqual(before.legend[0].selected);
      expect(chart.getOption().series[0].data).toEqual(before.series[0].data);
    });
  });
});
