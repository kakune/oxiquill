import type { ChartSpec } from './types.js';
import { normalizeHeatmapSpec } from './heatmap-normalization.js';
import type { RuntimeLocale } from './runtime-localization.js';

export function numericBounds(values: readonly unknown[]): { minimum: number; maximum: number } | undefined {
  let minimum = Infinity;
  let maximum = -Infinity;
  for (const value of values) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    minimum = Math.min(minimum, value);
    maximum = Math.max(maximum, value);
  }
  return minimum === Infinity ? undefined : { minimum, maximum };
}

export function chartCoordinates(spec: ChartSpec): {
  x: readonly unknown[];
  y: readonly unknown[];
  value: readonly unknown[];
} {
  switch (spec.kind) {
    case 'bar':
      return { x: spec.categories, y: spec.series.flatMap((series) => series.values), value: [] };
    case 'histogram':
      return { x: spec.bins.flatMap((bin) => [bin[0], bin[1]]), y: spec.bins.map((bin) => bin[2]), value: [] };
    case 'heatmap': {
      const heatmap = normalizeHeatmapSpec(spec);
      return { x: heatmap.xCategories, y: heatmap.yCategories, value: heatmap.data.map((cell) => cell[2]) };
    }
    default: {
      const points = spec.series.flatMap((series) => series.points);
      return { x: points.map((point) => point[0]), y: points.map((point) => point[1]), value: [] };
    }
  }
}

const superscripts: Record<string, string> = {
  '-': '⁻',
  '0': '⁰',
  '1': '¹',
  '2': '²',
  '3': '³',
  '4': '⁴',
  '5': '⁵',
  '6': '⁶',
  '7': '⁷',
  '8': '⁸',
  '9': '⁹'
};

export function chartNumberFormatter(
  values: readonly unknown[],
  locale: RuntimeLocale,
  ticks = false
): (value: number) => string {
  const bounds = numericBounds(values);
  const magnitude = bounds ? Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) : 0;
  const span = bounds ? bounds.maximum - bounds.minimum : 0;
  const narrow = span > 0 && span / magnitude <= 0.001;
  const scientific = !narrow && (magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-4));
  // ECharts already rounds its generated ticks. Preserve their full precision,
  // including when zoom reveals a small interval within a wide original domain.
  const precision = ticks ? 17 : 6;
  const formatter = new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    useGrouping: !scientific && magnitude >= 10_000,
    maximumSignificantDigits: precision
  });
  return (value) => {
    if (!Number.isFinite(value)) return String(value);
    const clean = ticks ? value : Number(value.toPrecision(precision));
    if (clean === 0) return '0';
    if (!scientific) return formatter.format(clean);
    const [coefficient, exponent] = clean.toExponential().split('e');
    const power = String(Number(exponent)).replace(/./gu, (digit) => superscripts[digit]);
    return `${formatter.format(Number(coefficient))}×10${power}`;
  };
}

export function chartCoordinateFormatter(
  values: readonly unknown[],
  type: ChartSpec['xType'],
  locale: RuntimeLocale,
  ticks = false
): (value: unknown) => string {
  if (type === 'category') return (value) => String(value);
  if (type !== 'time') {
    const format = chartNumberFormatter(values, locale, ticks);
    return (value) => (typeof value === 'number' ? format(value) : String(value));
  }
  const bounds = numericBounds(values.map((value) => (typeof value === 'number' ? value : Date.parse(String(value)))));
  const span = bounds ? bounds.maximum - bounds.minimum : 0;
  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: 'UTC',
    ...(ticks
      ? span < 172_800_000
        ? {
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hourCycle: 'h23',
            ...(span < 60_000 ? { fractionalSecondDigits: 3 } : {})
          }
        : { year: 'numeric', month: 'short', day: 'numeric' }
      : { dateStyle: 'medium', timeStyle: 'medium' })
  });
  return (value) => {
    const time = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(time) ? `${formatter.format(time)}${ticks ? '' : ' UTC'}` : String(value);
  };
}
