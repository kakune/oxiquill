// @vitest-environment node
import { JSDOM } from 'jsdom';
import { afterEach, expect, it, vi } from 'vitest';
import { exportChartImage } from '../../packages/oxiquill/src/lib/doc-runtime/chart-export';
import { defaultChartChrome } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';

vi.mock('../../packages/oxiquill/src/lib/doc-runtime/echarts-runtime', async () => {
  const { createRequire } = await import('node:module');
  const { resolve } = await import('node:path');
  return { loadECharts: async () => createRequire(resolve('packages/oxiquill/package.json'))('echarts') };
});
afterEach(() => vi.unstubAllGlobals());

it.each([
  { kind: 'line', series: [] },
  {
    kind: 'line',
    series: [
      {
        name: 'First',
        points: [
          [0, 1],
          [1, 3]
        ]
      },
      {
        name: 'Second',
        points: [
          [0, 2],
          [1, 4]
        ]
      }
    ]
  },
  {
    kind: 'histogram',
    bins: [
      [0, 1, 2],
      [1, 3, 4]
    ]
  },
  {
    kind: 'heatmap',
    data: [
      ['A', 'B', 0.25],
      ['C', 'B', 0.75]
    ]
  }
])('exports real SVG for $kind with explicit dimensions and background', async (spec) => {
  const dom = new JSDOM();
  vi.stubGlobal('document', dom.window.document);
  try {
    const blob = await exportChartImage({
      spec,
      theme: 'dark',
      chrome: defaultChartChrome('dark'),
      width: 720,
      height: 360,
      locale: 'en',
      state: {
        dataZoom: [{ start: 25, end: 75 }],
        legend: [{ selected: { 'line:1': false } }],
        visualMap: [{ range: [0.3, 0.6] }]
      },
      format: 'svg'
    });
    const svg = await blob.text();
    expect(svg).toContain('width="720"');
    expect(svg).toContain('height="360"');
    expect(svg).toContain('#181a1e');
    expect(svg).not.toContain('<animate');
  } finally {
    dom.window.close();
  }
});
