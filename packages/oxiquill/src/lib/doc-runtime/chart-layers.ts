import type { ChartSpec, XyChartSpec, LineChartSpec, ScatterChartSpec, IntervalChartSpec } from './types.js';

/** Shared collection boundary; public mixed charts retain their ordered layers. */
export function chartItems(spec: ChartSpec) {
  return spec.kind === 'xy' ? spec.layers : 'series' in spec ? spec.series : [];
}

/** Reuse single-kind rendering contracts without converting authored coordinates. */
export function chartLayerSpec(spec: XyChartSpec, index: number): LineChartSpec | ScatterChartSpec | IntervalChartSpec {
  const { layers, ...base } = spec;
  const layer = layers[index];
  switch (layer.kind) {
    case 'line':
      return { ...base, kind: 'line', series: [layer] };
    case 'scatter':
      return { ...base, kind: 'scatter', series: [layer] };
    case 'band':
      return { ...base, kind: 'band', series: [layer] };
  }
}

export function chartLineItems(spec: ChartSpec) {
  return spec.kind === 'xy'
    ? spec.layers.map((layer) => (layer.kind === 'line' ? layer : undefined))
    : spec.kind === 'line' || spec.kind === 'area'
      ? spec.series
      : [];
}
