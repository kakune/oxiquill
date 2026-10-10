import { histogramHeight } from './chart-histogram.js';
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
      return {
        x: spec.bins.flatMap((bin) => [bin[0], bin[1]]),
        y: spec.bins.map((bin) => histogramHeight(bin, spec.mode)),
        value: []
      };
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
  const zeroTolerance = !ticks && bounds && bounds.minimum < 0 && bounds.maximum > 0 ? magnitude * Number.EPSILON : 0;
  const formatter = new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    useGrouping: !scientific && magnitude >= 10_000,
    maximumSignificantDigits: precision
  });
  return (value) => {
    if (!Number.isFinite(value)) return String(value);
    if (Math.abs(value) <= zeroTolerance) return '0';
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
): (value: unknown, index?: number, extra?: TimeTickDetails) => string {
  if (type === 'category') return (value) => String(value);
  if (type !== 'time') {
    const format = chartNumberFormatter(values, locale, ticks);
    return (value) => (typeof value === 'number' ? format(value) : String(value));
  }
  if (ticks) return timeTickFormatter(locale);
  const formatter = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: 'UTC',
    dateStyle: 'medium',
    timeStyle: 'medium'
  });
  return (value) => {
    const time = typeof value === 'number' ? value : Date.parse(String(value));
    return Number.isFinite(time) ? `${formatter.format(time)} UTC` : String(value);
  };
}

type TimeUnit = 'year' | 'month' | 'day' | 'hour' | 'minute' | 'second' | 'millisecond';
interface TimeTickDetails {
  time?: { upperTimeUnit: TimeUnit; lowerTimeUnit: TimeUnit; level: number };
}

function timeTickFormatter(locale: RuntimeLocale) {
  const formats = new Map<TimeUnit, Intl.DateTimeFormat>();
  const calendar = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric'
  });
  return (value: unknown, _index?: number, extra?: TimeTickDetails): string => {
    const time = typeof value === 'number' ? value : Date.parse(String(value));
    if (!Number.isFinite(time)) return String(value);
    // ECharts supplies the actual tick unit after zoom, including calendar boundaries.
    const unit = extra?.time?.lowerTimeUnit ?? 'millisecond';
    let format = formats.get(unit);
    if (!format) {
      const date = unit === 'year' || unit === 'month' || unit === 'day';
      format = new Intl.DateTimeFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
        timeZone: 'UTC',
        ...(date
          ? {
              year: 'numeric',
              ...(unit !== 'year' ? { month: 'short' } : {}),
              ...(unit === 'day' ? { day: 'numeric' } : {})
            }
          : {
              hour: '2-digit',
              minute: '2-digit',
              hourCycle: 'h23',
              ...(unit === 'second' || unit === 'millisecond' ? { second: '2-digit' } : {}),
              ...(unit === 'millisecond' ? { fractionalSecondDigits: 3 } : {})
            })
      });
      formats.set(unit, format);
    }
    // Overlap hiding may remove a midnight tick. Keep the date on finer ticks too.
    const date = unit === 'year' || unit === 'month' || unit === 'day';
    return date ? format.format(time) : `${calendar.format(time)}\n${format.format(time)}`;
  };
}
