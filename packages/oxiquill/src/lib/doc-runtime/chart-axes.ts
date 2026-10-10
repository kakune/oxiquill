import type { BaseChartSpec, ChartAxisType, ChartSpec } from './types.js';

type AxesSpec = BaseChartSpec & { kind: string };

export function chartAxisType(spec: AxesSpec, axis: 'x' | 'y'): ChartAxisType {
  if (spec.kind === 'heatmap' || (axis === 'x' && ['bar', 'histogram'].includes(spec.kind))) return 'category';
  return spec[axis === 'x' ? 'xType' : 'yType'] ?? 'value';
}

export function chartIncludesZero(spec: AxesSpec, axis: 'x' | 'y'): boolean {
  if (chartAxisType(spec, axis) !== 'value') return false;
  return (
    spec[axis === 'x' ? 'xIncludeZero' : 'yIncludeZero'] ??
    (axis === 'y' && ['bar', 'histogram', 'area'].includes(spec.kind))
  );
}

export function chartRangeSignature(spec: ChartSpec): string {
  return JSON.stringify([
    spec.xMin,
    spec.xMax,
    spec.yMin,
    spec.yMax,
    chartIncludesZero(spec, 'x'),
    chartIncludesZero(spec, 'y')
  ]);
}
