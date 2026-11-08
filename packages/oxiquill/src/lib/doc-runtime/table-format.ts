import type { NumberFormat, TableColumn } from './types.js';
import { numberFormatter } from './number-format.js';
import type { RuntimeLocale } from './runtime-localization.js';

export function tableColumnGrouping(rows: readonly unknown[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_, column) =>
    rows.some((row) => typeof row[column] === 'number' && Math.abs(row[column]) >= 10_000)
  );
}

export function formatTableNumber(
  value: number,
  locale: RuntimeLocale,
  useGrouping = false,
  format: NumberFormat = {}
): string {
  return numberFormatter([value], locale, { context: 'table', useGrouping, format })(value);
}

export function tableColumnLabel(column: TableColumn): string {
  return column.format?.unit ? `${column.label} (${column.format.unit})` : column.label;
}
