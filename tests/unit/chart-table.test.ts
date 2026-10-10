import { expect, it } from 'vitest';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
const labels = labelsForLanguage('en');

it.each(['line', 'area', 'scatter'] as const)('retains exact %s coordinates and series names', (kind) => {
  expect(
    chartToTable(
      {
        kind,
        xType: 'time',
        series: [{ name: 'Named', points: [['2024-01-01', 0.30000000000000004]] }, { points: [[0, 2]] }]
      },
      labels
    ).rows
  ).toEqual([
    ['Named', '2024-01-01', 0.30000000000000004],
    ['Series 2', 0, 2]
  ]);
});

it('keeps categories, nulls, and bin counts separately from density', () => {
  expect(chartToTable({ kind: 'bar', categories: ['a', 'b'], series: [{ values: [null, -3] }] }, labels).rows).toEqual([
    ['Series 1', 'a', null],
    ['Series 1', 'b', -3]
  ]);
  expect(chartToTable({ kind: 'histogram', mode: 'density', bins: [[1, 3, 6]] }, labels).rows).toEqual([[1, 3, 6, 3]]);
  expect(chartToTable({ kind: 'histogram', bins: [[1, 3, 6]] }, labels).rows).toEqual([[1, 3, 6]]);
});

it('resolves heatmap indexes while retaining literal coordinates', () => {
  expect(
    chartToTable(
      {
        kind: 'heatmap',
        xCategories: ['A', 'B'],
        data: [
          [1, 3, 5],
          ['A', 'Y', 6]
        ]
      },
      labels
    ).rows
  ).toEqual([
    ['B', '3', 5],
    ['A', 'Y', 6]
  ]);
});

it('bounds 100,000 points before allocating table rows and reports the total', () => {
  const points = Array.from({ length: 100_000 }, (_, i) => [i, i] as const);
  const table = chartToTable({ kind: 'line', series: [{ points }] }, labels);
  expect(table.rows).toHaveLength(10_000);
  expect(table.rowCount).toBe(100_000);
  expect(table.truncated).toBe(true);
  expect(chartToTable({ kind: 'heatmap', data: [] }, labels).rows).toEqual([]);
});

it('localizes table headers', () => {
  expect(
    chartToTable({ kind: 'histogram', bins: [] }, labelsForLanguage('ja')).columns.map((column) => column.label)
  ).toEqual(['区間の下端', '区間の上端', '度数']);
});
