import type { CustomSeriesOption } from 'echarts/charts';
import type { FieldChartSpec } from './types.js';

export function fieldCells(spec: FieldChartSpec): (readonly [number, number, number, number, number | null])[] {
  return spec.values.flatMap((row, y) =>
    row.map((value, x) => [spec.xEdges[x], spec.xEdges[x + 1], spec.yEdges[y], spec.yEdges[y + 1], value] as const)
  );
}

export function fieldSeries(spec: FieldChartSpec): CustomSeriesOption {
  return {
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    clip: true,
    dimensions: ['xLower', 'xUpper', 'yLower', 'yUpper', 'value'],
    encode: { x: [0, 1], y: [2, 3], tooltip: [0, 1, 2, 3, 4] },
    data: fieldCells(spec).filter((cell) => cell[4] !== null),
    renderItem: (params, api) => {
      const grid = params.coordSys as typeof params.coordSys & { x: number; y: number; width: number; height: number };
      const lower = api.coord([api.value(0), api.value(2)]);
      const upper = api.coord([api.value(1), api.value(3)]);
      const left = Math.max(grid.x, lower[0]);
      const right = Math.min(grid.x + grid.width, upper[0]);
      const top = Math.max(grid.y, upper[1]);
      const bottom = Math.min(grid.y + grid.height, lower[1]);
      if (right <= left || bottom <= top) return;
      return {
        type: 'rect',
        shape: { x: left, y: top, width: right - left, height: bottom - top },
        style: { fill: api.visual('color') }
      };
    }
  };
}
