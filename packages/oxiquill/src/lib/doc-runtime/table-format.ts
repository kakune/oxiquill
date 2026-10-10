import type { RuntimeLocale } from './runtime-localization.js';

export function tableColumnGrouping(rows: readonly unknown[][], columnCount: number): boolean[] {
  return Array.from({ length: columnCount }, (_, column) =>
    rows.some((row) => typeof row[column] === 'number' && Math.abs(row[column]) >= 10_000)
  );
}

export function formatTableNumber(value: number, locale: RuntimeLocale, useGrouping = false): string {
  if (!Number.isFinite(value)) return String(value);
  if (value === 0) return '0';
  const integer = Number.isInteger(value);
  const scientific = !integer && (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4);
  return new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    useGrouping,
    notation: scientific ? 'scientific' : 'standard',
    ...(integer ? { maximumFractionDigits: 0 } : { maximumSignificantDigits: 6 })
  }).format(value);
}
