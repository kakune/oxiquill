import { expect, it } from 'vitest';
import {
  chartSelectionIds,
  isolateChartSelection,
  reconcileChartSelection,
  visibleChartSeries
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-selection';
import { chartToTable } from '../../packages/oxiquill/src/lib/doc-runtime/chart-table';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import { tableToCsv } from '../../packages/oxiquill/src/components/doc-runtime/TableOutput';
import { chartFixtures } from '../fixtures/chart-specs';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const spec: ChartSpec = {
  kind: 'line',
  series: [
    { id: 'a', name: 'Same', points: [[0, 1]] },
    { id: 'b', name: 'Same', points: [[0, 2]] }
  ]
};

it('reconciles retained, removed, new, and reintroduced ids without touching data', () => {
  const previous = { 'line:id:a': false, 'line:id:vanished': false };
  expect(reconcileChartSelection(spec, previous)).toEqual({ 'line:id:a': false, 'line:id:b': true });
  expect(reconcileChartSelection({ ...spec, series: spec.series.toReversed() }, previous)).toEqual({
    'line:id:b': true,
    'line:id:a': false
  });
  expect(previous).toEqual({ 'line:id:a': false, 'line:id:vanished': false });
  expect(reconcileChartSelection(spec)).toEqual({ 'line:id:a': true, 'line:id:b': true });
});

it('isolates independently named ids, restores all, and counts an empty selection', () => {
  expect(isolateChartSelection(spec, 'line:id:b')).toEqual({ 'line:id:a': false, 'line:id:b': true });
  expect(isolateChartSelection(spec)).toEqual(reconcileChartSelection(spec));
  expect(visibleChartSeries(spec, { 'line:id:a': false, 'line:id:b': false })).toBe(0);
  expect(chartSelectionIds({ kind: 'line', series: [] })).toEqual([]);
  expect(chartSelectionIds({ kind: 'histogram', bins: [] })).toEqual(['histogram:0']);
});

it.each(Object.entries(chartFixtures))('retains all %s data and appends visibility only when supplied', (_, chart) => {
  const labels = labelsForLanguage('en');
  const original = chartToTable(chart, labels);
  const hidden = Object.fromEntries(chartSelectionIds(chart).map((id) => [id, false]));
  const table = chartToTable(chart, labels, hidden);
  expect(table.rows.map((row) => row.slice(0, -1))).toEqual(original.rows);
  expect(table.rows.every((row) => row.at(-1) === false)).toBe(true);
  expect(table.columns.at(-1)).toEqual({ key: 'visible', label: 'Visible', type: 'boolean' });
  expect(table.rowCount).toBe(original.rowCount);
});

it('preserves raw values and localized visibility through CSV, even for duplicate series names', () => {
  const labels = labelsForLanguage('ja');
  const table = chartToTable(spec, labels, { 'line:id:a': false });
  expect(table.rows).toEqual([
    ['Same', 0, 1, false],
    ['Same', 0, 2, true]
  ]);
  const result = tableToCsv(table.columns, table.rows, labels);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.csv).toContain('表示中');
    expect(result.csv).toContain('Same,0,1,false');
    expect(result.csv).toContain('Same,0,2,true');
  }
});
