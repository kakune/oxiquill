import { normalizeHeatmapSpec } from './heatmap-normalization.js';
import type { ChartSpec } from './types.js';

export function chartHeight(spec: ChartSpec): number {
  return (
    spec.style?.height ??
    (spec.kind === 'heatmap'
      ? Math.min(720, Math.max(240, 120 + normalizeHeatmapSpec(spec).yCategories.length * 24))
      : 360)
  );
}

export function chartLayout(spec: ChartSpec, width: number, height: number, legend: boolean) {
  const verticalMap = hasChartColorScale(spec) && width >= 600;
  const bottom = hasChartColorScale(spec) && !verticalMap ? 88 : 16;
  const right = verticalMap ? 112 : 16;
  const top = legend ? 48 : 16;
  return {
    grid: {
      left: 64,
      right,
      top,
      bottom: bottom + 48,
      outerBoundsMode: 'auto',
      outerBounds: { left: 12, right, top, bottom },
      outerBoundsContain: 'all'
    },
    plotWidth: Math.max(40, width - 100 - right),
    plotHeight: Math.max(40, height - top - bottom - 64),
    visualMap: verticalMap
      ? {
          orient: 'vertical',
          right: 16,
          top: 'middle',
          left: null,
          bottom: null,
          itemHeight: Math.min(160, height - 100)
        }
      : {
          orient: 'horizontal',
          left: 'center',
          bottom: 16,
          right: null,
          top: null,
          itemHeight: Math.max(60, Math.min(160, width - 180))
        }
  };
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

export function truncateChartLabel(value: string, width: number): string {
  let used = 0;
  let result = '';
  for (const { segment } of segmenter.segment(value)) {
    const size = /[^\x00-\x7f]/u.test(segment) ? 12 : 7.2;
    if (used + size > width) return result.length > 0 ? `${result}…` : '…';
    used += size;
    result += segment;
  }
  return value;
}

export function categoryLabelLayout(count: number, extent: number, horizontal: boolean, chartWidth: number) {
  const band = extent / Math.max(1, count);
  const rotate = horizontal && band < 48 ? 45 : 0;
  const width = horizontal ? (rotate ? 60 : Math.max(8, band - 16)) : Math.min(120, chartWidth * 0.25);
  return {
    interval: Math.max(0, Math.ceil((horizontal ? 22 : 18) / band) - 1),
    rotate,
    hideOverlap: false,
    formatter: (value: string) => truncateChartLabel(value, Math.max(0, width - 12)),
    // The formatter owns truncation so grapheme clusters remain intact.
    margin: 10
  };
}

export function hasChartColorScale(spec: ChartSpec): boolean {
  return (
    spec.kind === 'heatmap' || spec.kind === 'field' || (spec.kind === 'bubble' && spec.colorMapping !== undefined)
  );
}
