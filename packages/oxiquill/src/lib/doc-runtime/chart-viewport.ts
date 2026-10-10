import type { ChartSpec } from './types.js';

type Point = readonly [number, number];
type Extent = readonly [number, number];
export interface ChartScale {
  getExtent: () => Extent;
  parse: (value: unknown) => number;
}
export interface ChartAxes {
  x: ChartScale;
  y: ChartScale;
}

/** Keep the ECharts model boundary here; getOption() would clone every data point. */
export function chartAxes(instance: unknown): ChartAxes | undefined {
  const chart = instance as {
    getModel?: () => { getComponent: (axis: string) => { axis?: { scale: ChartScale } } | undefined };
  };
  const model = chart.getModel?.();
  const x = model?.getComponent('xAxis')?.axis?.scale;
  const y = model?.getComponent('yAxis')?.axis?.scale;
  return x && y ? { x, y } : undefined;
}

export function chartPointIndexes(spec: ChartSpec, axes: ChartAxes) {
  if (spec.kind !== 'line' && spec.kind !== 'area') return [];
  return spec.series.map((series) => {
    const points: Point[] = series.points
      .map(([x, y]): Point => [axes.x.parse(x), axes.y.parse(y)])
      .filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y));
    return {
      x: points.toSorted((a, b) => a[0] - b[0]),
      y: points.toSorted((a, b) => a[1] - b[1])
    };
  });
}

function bound(points: readonly Point[], dimension: 0 | 1, value: number, upper: boolean): number {
  let low = 0;
  let high = points.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    const coordinate = points[middle][dimension];
    if (coordinate < value || (upper && coordinate === value)) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function hasIsolatedPoint(index: { x: readonly Point[]; y: readonly Point[] }, x: Extent, y: Extent): boolean {
  const xStart = bound(index.x, 0, x[0], false);
  const xEnd = bound(index.x, 0, x[1], true);
  const yStart = bound(index.y, 1, y[0], false);
  const yEnd = bound(index.y, 1, y[1], true);
  const horizontal = xEnd - xStart <= yEnd - yStart;
  const points = horizontal ? index.x : index.y;
  const start = horizontal ? xStart : yStart;
  const end = horizontal ? xEnd : yEnd;
  const other = horizontal ? y : x;
  const dimension = horizontal ? 1 : 0;
  let count = 0;
  for (let i = start; i < end; i++) {
    const value = points[i][dimension];
    if (value >= other[0] && value <= other[1] && ++count > 1) return false;
  }
  return count === 1;
}
