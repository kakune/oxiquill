import type { ChartSpec, TableArtifact, TableColumn } from './types.js';
import type { RuntimeLabels } from './runtime-localization.js';
import { outputArtifactLimits } from './output-limits.mjs';
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
  if (spec.kind === 'histogram') {
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
        spec.kind === 'bar' || spec.xType === 'category' ? 'string' : spec.xType === 'time' ? 'unknown' : 'number'
      ),
      column(
        'y',
        spec.yLabel ?? 'Y',
        spec.yType === 'category' ? 'string' : spec.yType === 'time' ? 'unknown' : 'number'
      )
    ];
    spec.series.forEach((series, index) => {
      const name = series.name?.trim() ? series.name : labels.chartSeriesName(index + 1);
      if ('values' in series && spec.kind === 'bar') {
        rowCount += series.values.length;
        for (let i = 0; i < series.values.length && rows.length < limit; i++)
          rows.push([name, spec.categories[i], series.values[i]]);
      } else if ('points' in series) {
        rowCount += series.points.length;
        for (let i = 0; i < series.points.length && rows.length < limit; i++) rows.push([name, ...series.points[i]]);
      }
    });
  }
  return { kind: 'table', title: labels.chartData, columns, rows, rowCount, truncated: rowCount > rows.length };
}
