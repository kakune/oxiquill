// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/components/doc-runtime/ChartOutput';
import { chartFixtures } from '../fixtures/chart-specs';
import { measureText, svgLayoutIssues } from './chart-svg-layout.mjs';
import { chartHeight } from '../../packages/oxiquill/src/lib/doc-runtime/chart-layout';

const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
echarts.setPlatformAPI({ measureText });

describe('chart layout inspection', () => {
  it('rejects a real ECharts option that places axis text outside the canvas', () => {
    const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 360, height: 360 });
    try {
      const options = chartSpecToEChartsOptions(chartFixtures.large, 'light', { reducedMotion: true, width: 360 });
      options.grid = { left: 4, right: 4, top: 4, bottom: 4, outerBoundsMode: 'none' };
      options.yAxis.nameGap = 80;
      options.yAxis.nameMoveOverlap = false;
      chart.setOption(options);
      expect(svgLayoutIssues(chart.renderToSVGString(), 360, 360)).toEqual(
        expect.arrayContaining([expect.stringMatching(/^Outside:/u)])
      );
    } finally {
      chart.dispose();
    }
  });
  it('detects deliberate overlap and overflow in SVG output', () => {
    expect(
      svgLayoutIssues(
        '<svg xmlns="http://www.w3.org/2000/svg"><text x="-20" y="10">Outside</text><text x="-20" y="10">Collision</text></svg>',
        360,
        360
      )
    ).toEqual(expect.arrayContaining(['Outside: Outside', 'Overlap: Outside / Collision']));
  });
  for (const [name, spec] of Object.entries(chartFixtures))
    for (const width of [360, 720])
      for (const theme of ['light', 'dark']) {
        it(`contains visible text without collisions: ${name} ${width} ${theme}`, () => {
          const height = chartHeight(spec);
          const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width, height });
          try {
            chart.setOption(chartSpecToEChartsOptions(spec, theme, { reducedMotion: true, width, height }));
            expect(svgLayoutIssues(chart.renderToSVGString(), width, height)).toEqual([]);
          } finally {
            chart.dispose();
          }
        });
      }
});
