import type { CustomSeriesOption } from 'echarts/charts';
import type { IntervalChartSpec, IntervalChartSeries } from './types.js';

/** Adjacent endpoints are encoded together so zoom retains crossing segments. */
export function intervalSeries(spec: IntervalChartSpec, series: IntervalChartSeries): CustomSeriesOption {
  const band = spec.kind === 'band';
  return {
    type: 'custom',
    coordinateSystem: 'cartesian2d',
    clip: true,
    dimensions: ['x', 'center', 'lower', 'upper', 'nextX', 'nextCenter', 'nextLower', 'nextUpper', 'isolated'],
    encode: { x: band ? [0, 4] : 0, y: band ? [1, 2, 3, 5, 6, 7] : [1, 2, 3], tooltip: [0, 1, 2, 3] },
    data: series.points.map((point, index) => {
      const coordinate = (x: number | string) => (spec.xType === 'time' && typeof x === 'string' ? Date.parse(x) : x);
      const next = series.points[index + 1];
      return [
        coordinate(point[0]),
        ...point.slice(1),
        ...(next && point[1] !== null && next[1] !== null
          ? [coordinate(next[0]), ...next.slice(1)]
          : [null, null, null, null]),
        series.points[index - 1]?.[1] == null ? 1 : 0
      ];
    }),
    renderItem: (_params, api) => {
      if (!Number.isFinite(api.value(1))) return;
      const color = api.visual('color') as string;
      const center = api.coord([api.value(0), api.value(1)]);
      const lower = api.coord([api.value(0), api.value(2)]);
      const upper = api.coord([api.value(0), api.value(3)]);
      const stroke = { stroke: color, lineWidth: spec.style?.lineWidth ?? 2 };
      if (band && Number.isFinite(api.value(5))) {
        const nextCenter = api.coord([api.value(4), api.value(5)]);
        return {
          type: 'group',
          children: [
            {
              type: 'polygon',
              shape: {
                points: [lower, upper, api.coord([api.value(4), api.value(7)]), api.coord([api.value(4), api.value(6)])]
              },
              style: { fill: color, opacity: 0.2 }
            },
            {
              type: 'line',
              shape: { x1: center[0], y1: center[1], x2: nextCenter[0], y2: nextCenter[1] },
              style: stroke
            }
          ]
        };
      }
      if (band && !api.value(8)) return;
      return {
        type: 'group',
        children: [
          { type: 'line', shape: { x1: lower[0], y1: lower[1], x2: upper[0], y2: upper[1] }, style: stroke },
          ...[lower, upper].map((point) => ({
            type: 'line' as const,
            shape: { x1: point[0] - 4, y1: point[1], x2: point[0] + 4, y2: point[1] },
            style: stroke
          })),
          { type: 'circle', shape: { cx: center[0], cy: center[1], r: 3 }, style: { fill: color } }
        ]
      };
    }
  };
}
