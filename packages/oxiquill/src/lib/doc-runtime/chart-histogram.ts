import type { CustomSeriesOption } from 'echarts/charts';
import type { HistogramChartSpec } from './types.js';

type Bin = HistogramChartSpec['bins'][number];

export function histogramHeight(bin: Bin, mode: HistogramChartSpec['mode']): number {
  return mode === 'density' ? bin[2] / (bin[1] - bin[0]) : bin[2];
}

export function histogramLabel(spec: HistogramChartSpec): string {
  const mode = spec.mode === 'density' ? 'Density' : 'Count';
  return spec.yLabel ? `${spec.yLabel} (${mode})` : mode;
}

export function histogramSeries(spec: HistogramChartSpec): CustomSeriesOption {
  return {
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    clip: true,
    dimensions: ['lower', 'upper', 'height', 'count'],
    encode: { x: [0, 1], y: 2, tooltip: [0, 1, 2] },
    data: spec.bins.map((bin) => [bin[0], bin[1], histogramHeight(bin, spec.mode), bin[2]]),
    renderItem: (params, api) => {
      const grid = params.coordSys as typeof params.coordSys & { x: number; y: number; width: number; height: number };
      const lower = api.coord([api.value(0), api.value(2)]);
      const upper = api.coord([api.value(1), api.value(2)]);
      // A log axis has no zero; its positive lower bound is the visible baseline.
      const baseline = spec.yType === 'log' ? grid.y + grid.height : api.coord([api.value(0), 0])[1];
      const left = Math.max(grid.x, lower[0]);
      const right = Math.min(grid.x + grid.width, upper[0]);
      const top = Math.max(grid.y, Math.min(lower[1], baseline));
      const bottom = Math.min(grid.y + grid.height, Math.max(lower[1], baseline));
      if (right <= left || bottom <= top) return;
      return {
        type: 'rect',
        shape: { x: left, y: top, width: right - left, height: bottom - top },
        style: { fill: api.visual('color') }
      };
    }
  };
}
