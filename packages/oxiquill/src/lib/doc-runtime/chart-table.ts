import type { ChartSpec, TableArtifact, TableColumn } from './types.js';
import type { RuntimeLabels } from './runtime-localization.js';
import { outputArtifactLimits } from './output-limits.mjs';
import { chartAxisType } from './chart-axes.js';
import { histogramHeight } from './chart-histogram.js';

export function chartToTable(spec: ChartSpec, labels: RuntimeLabels): TableArtifact {
  const rows: unknown[][] = [];
  const limit = outputArtifactLimits.rowsPerTable;
  let rowCount = 0;
  let columns: TableColumn[];
  const column = (key: string, label: string, type: TableColumn['type'] = 'number'): TableColumn => ({
    key,
    label,
    type
  });
  if (spec.kind === 'field') {
    columns = [
      column('xLower', 'X: ' + labels.chartBinLower),
      column('xUpper', 'X: ' + labels.chartBinUpper),
      column('yLower', 'Y: ' + labels.chartBinLower),
      column('yUpper', 'Y: ' + labels.chartBinUpper),
      column('value', labels.chartValue)
    ];
    rowCount = spec.values.reduce((sum, row) => sum + row.length, 0);
    for (let y = 0; y < spec.values.length && rows.length < limit; y++)
      for (let x = 0; x < spec.values[y].length && rows.length < limit; x++)
        rows.push([spec.xEdges[x], spec.xEdges[x + 1], spec.yEdges[y], spec.yEdges[y + 1], spec.values[y][x]]);
  } else if (spec.kind === 'bubble') {
    columns = [
      column('series', labels.chartSeries, 'string'),
      column(
        'x',
        spec.xLabel ?? 'X',
        spec.xType === 'time' ? 'datetime' : spec.xType === 'category' ? 'string' : 'number'
      ),
      column(
        'y',
        spec.yLabel ?? 'Y',
        spec.yType === 'time' ? 'datetime' : spec.yType === 'category' ? 'string' : 'number'
      ),
      column('size', labels.chartSize),
      column('color', labels.chartValue)
    ];
    spec.series.forEach((series, index) => {
      rowCount += series.points.length;
      for (const [x, y, size, color] of series.points.slice(0, limit - rows.length))
        rows.push([
          series.name ?? labels.chartSeriesName(index + 1),
          spec.xType === 'time' ? timeCoordinate(x) : x,
          spec.yType === 'time' ? timeCoordinate(y) : y,
          size,
          color ?? null
        ]);
    });
  } else if (spec.kind === 'boxplot') {
    columns = [
      column('series', labels.chartSeries, 'string'),
      column('category', spec.xLabel ?? 'X', 'string'),
      ...['min', 'q1', 'median', 'q3', 'max'].map((key, index) => column(key, labels.chartBoxStatistics[index]))
    ];
    spec.series.forEach((series, index) => {
      rowCount += series.values.length;
      series.values
        .slice(0, limit - rows.length)
        .forEach((value, category) =>
          rows.push([
            series.name ?? labels.chartSeriesName(index + 1),
            spec.categories[category],
            ...(value ?? [null, null, null, null, null])
          ])
        );
    });
  } else if (spec.kind === 'errorbar' || spec.kind === 'band') {
    columns = [
      column('series', labels.chartSeries, 'string'),
      column(
        'x',
        spec.xLabel ?? 'X',
        spec.xType === 'time' ? 'datetime' : spec.xType === 'category' ? 'string' : 'number'
      ),
      column('center', labels.chartValue),
      column('lower', labels.chartBinLower),
      column('upper', labels.chartBinUpper)
    ];
    spec.series.forEach((series, index) => {
      rowCount += series.points.length;
      for (const point of series.points.slice(0, limit - rows.length))
        rows.push([
          series.name ?? labels.chartSeriesName(index + 1),
          spec.xType === 'time' ? timeCoordinate(point[0]) : point[0],
          ...point.slice(1)
        ]);
    });
  } else if (spec.kind === 'histogram') {
    columns = [
      column('lower', labels.chartBinLower),
      column('upper', labels.chartBinUpper),
      column('count', labels.chartHistogramCount)
    ];
    if (spec.mode === 'density') columns.push(column('height', labels.chartHistogramDensity));
    rowCount = spec.bins.length;
    for (const bin of spec.bins.slice(0, limit))
      rows.push(spec.mode === 'density' ? [...bin, histogramHeight(bin, spec.mode)] : [...bin]);
  } else if (spec.kind === 'heatmap') {
    columns = [
      column('x', spec.xLabel ?? 'X', 'string'),
      column('y', spec.yLabel ?? 'Y', 'string'),
      column('value', labels.chartValue)
    ];
    rowCount = spec.data.length;
    for (const [x, y, value] of spec.data.slice(0, limit)) {
      rows.push([
        typeof x === 'number' ? (spec.xCategories?.[x] ?? String(x)) : x,
        typeof y === 'number' ? (spec.yCategories?.[y] ?? String(y)) : y,
        value
      ]);
    }
  } else {
    columns = [
      column('series', labels.chartSeries, 'string'),
      column(
        'x',
        spec.xLabel ?? 'X',
        chartAxisType(spec, 'x') === 'category' ? 'string' : spec.xType === 'time' ? 'datetime' : 'number'
      ),
      column(
        'y',
        spec.yLabel ?? 'Y',
        chartAxisType(spec, 'y') === 'category' ? 'string' : spec.yType === 'time' ? 'datetime' : 'number'
      )
    ];
    const x = spec.kind !== 'bar' && spec.xType === 'time' ? timeCoordinate : sameCoordinate;
    const y = spec.yType === 'time' ? timeCoordinate : sameCoordinate;
    spec.series.forEach((series, index) => {
      const name = series.name?.trim() ? series.name : labels.chartSeriesName(index + 1);
      if ('values' in series && spec.kind === 'bar') {
        rowCount += series.values.length;
        for (let i = 0; i < series.values.length && rows.length < limit; i++)
          rows.push(
            spec.orientation === 'horizontal'
              ? [name, series.values[i], spec.categories[i]]
              : [name, spec.categories[i], series.values[i]]
          );
      } else if ('points' in series) {
        rowCount += series.points.length;
        for (let i = 0; i < series.points.length && rows.length < limit; i++) {
          const [pointX, pointY] = series.points[i];
          rows.push([name, x(pointX), y(pointY)]);
        }
      }
    });
  }
  return { kind: 'table', title: labels.chartData, columns, rows, rowCount, truncated: rowCount > rows.length };
}

function sameCoordinate(value: unknown): unknown {
  return value;
}

/** Shows whole epoch milliseconds as the UTC instants the chart displays; authored ISO strings stay as written. */
function timeCoordinate(value: unknown): unknown {
  if (typeof value !== 'number' || !Number.isInteger(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}
