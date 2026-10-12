import type { BaseChartSpec, ChartAxisType, ChartSpec } from './types.js';

type AxesSpec = BaseChartSpec & { kind: string; orientation?: 'vertical' | 'horizontal' };

export function chartAxisType(spec: AxesSpec, axis: 'x' | 'y'): ChartAxisType {
  if (
    (spec.kind === 'boxplot' && axis === 'x') ||
    spec.kind === 'heatmap' ||
    (spec.kind === 'bar' && axis === (spec.orientation === 'horizontal' ? 'y' : 'x'))
  )
    return 'category';
  if (axis === 'x' && spec.kind === 'histogram') return 'value';
  return spec[axis === 'x' ? 'xType' : 'yType'] ?? 'value';
}

export function chartIncludesZero(spec: AxesSpec, axis: 'x' | 'y'): boolean {
  if (chartAxisType(spec, axis) !== 'value') return false;
  return (
    spec[axis === 'x' ? 'xIncludeZero' : 'yIncludeZero'] ??
    (axis === (spec.kind === 'bar' && spec.orientation === 'horizontal' ? 'x' : 'y') &&
      ['bar', 'histogram', 'area'].includes(spec.kind))
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
