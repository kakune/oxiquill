import { histogramHeight } from './chart-histogram.js';
import type { ChartSpec, ChartNumberFormat } from './types.js';
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
      return spec.orientation === 'horizontal'
        ? { x: spec.series.flatMap((series) => series.values), y: spec.categories, value: [] }
        : { x: spec.categories, y: spec.series.flatMap((series) => series.values), value: [] };
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

const siPrefixes = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];

function scaleForSi(value: number, exponent: number): number {
  // Shift the decimal exponent without introducing division rounding into ticks.
  const [coefficient, power] = value.toExponential().split('e');
  return Number(`${coefficient}e${Number(power) - exponent}`);
}

export function chartNumberFormatter(
  values: readonly unknown[],
  locale: RuntimeLocale,
  ticks = false,
  format: ChartNumberFormat = {}
): (value: number) => string {
  const bounds = numericBounds(values);
  const magnitude = bounds ? Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) : 0;
  const span = bounds ? bounds.maximum - bounds.minimum : 0;
  const narrow = span > 0 && span / magnitude <= 0.001;
  const precision = format.significantDigits ?? (ticks ? 17 : 6);
  const fixed = format.fractionDigits;
  const round = (value: number) =>
    fixed === undefined ? Number(value.toPrecision(precision)) : Number(value.toFixed(fixed));
  let exponent = magnitude > 0 ? Math.floor(Math.log10(magnitude) / 3) * 3 : 0;
  if (
    exponent >= -24 &&
    exponent <= 24 &&
    (fixed === undefined
      ? Number(scaleForSi(magnitude, exponent).toPrecision(format.significantDigits ?? 6))
      : round(scaleForSi(magnitude, exponent))) >= 1000
  )
    exponent += 3;
  const si = format.notation === 'si' && exponent >= -24 && exponent <= 24;
  const scientific =
    format.notation === 'si'
      ? !si
      : fixed === undefined && !narrow && (magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-4));
  const zeroTolerance = !ticks && bounds && bounds.minimum < 0 && bounds.maximum > 0 ? magnitude * Number.EPSILON : 0;
  const formatter = new Intl.NumberFormat(locale === 'ja' ? 'ja-JP' : 'en-US', {
    useGrouping: !scientific && !si && magnitude >= 10_000,
    ...(fixed === undefined
      ? { maximumSignificantDigits: precision }
      : { minimumFractionDigits: fixed, maximumFractionDigits: fixed })
  });
  const suffix = (si ? siPrefixes[exponent / 3 + 8] : '') + (format.unit ?? '');
  const appendUnit = (text: string) => (suffix ? text + ' ' + suffix : text);
  return (value) => {
    if (!Number.isFinite(value)) return appendUnit(String(value));
    const normalized = Math.abs(value) <= zeroTolerance ? 0 : value;
    if (si) return appendUnit(formatter.format(round(scaleForSi(normalized, exponent)) || 0));
    // ECharts rounds its generated ticks; preserve them unless precision is authored.
    const clean =
      ticks && format.significantDigits === undefined && fixed === undefined
        ? normalized
        : scientific
          ? Number(normalized.toPrecision(precision))
          : round(normalized);
    if (!scientific || clean === 0) return appendUnit(formatter.format(clean || 0));
    const [coefficient, powerText] = clean.toExponential().split('e');
    const power = String(Number(powerText)).replace(/./gu, (digit) => superscripts[digit]);
    return appendUnit(formatter.format(Number(coefficient)) + '×10' + power);
  };
}

export function chartCoordinateFormatter(
  values: readonly unknown[],
  type: ChartSpec['xType'],
  locale: RuntimeLocale,
  ticks = false,
  formatSpec?: ChartNumberFormat
): (value: unknown, index?: number, extra?: TimeTickDetails) => string {
  if (type === 'category') return (value) => String(value);
  if (type !== 'time') {
    const format = chartNumberFormatter(values, locale, ticks, formatSpec);
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
