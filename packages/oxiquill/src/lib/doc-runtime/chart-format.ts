import { histogramHeight } from './chart-histogram.js';
import type { ChartSpec, ChartNumberFormat } from './types.js';
import { normalizeHeatmapSpec } from './heatmap-normalization.js';
import type { RuntimeLocale } from './runtime-localization.js';

export { numericBounds } from './number-format.js';
import { numberFormatter } from './number-format.js';

export function chartCoordinates(spec: ChartSpec): {
  x: readonly unknown[];
  y: readonly unknown[];
  value: readonly unknown[];
} {
  switch (spec.kind) {
    case 'xy':
      return {
        x: spec.layers.flatMap((layer) => layer.points.map((point) => point[0])),
        y: spec.layers.flatMap((layer) => layer.points.flatMap((point) => point.slice(1))),
        value: []
      };
    case 'bar':
      return spec.orientation === 'horizontal'
        ? { x: spec.series.flatMap((series) => series.values), y: spec.categories, value: [] }
        : { x: spec.categories, y: spec.series.flatMap((series) => series.values), value: [] };
    case 'errorbar':
    case 'band': {
      const points = spec.series.flatMap((series) => series.points);
      return { x: points.map((point) => point[0]), y: points.flatMap((point) => point.slice(1)), value: [] };
    }
    case 'field':
      return { x: spec.xEdges, y: spec.yEdges, value: spec.values.flat() };
    case 'bubble': {
      const points = spec.series.flatMap((series) => series.points);
      return {
        x: points.map((point) => point[0]),
        y: points.map((point) => point[1]),
        value: points.map((point) => point[3])
      };
    }
    case 'boxplot':
      return {
        x: spec.categories,
        y: spec.series.flatMap((series) => series.values.flatMap((value) => value ?? [])),
        value: []
      };
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

export function chartNumberFormatter(
  values: readonly unknown[],
  locale: RuntimeLocale,
  ticks = false,
  format: ChartNumberFormat = {}
): (value: number) => string {
  return numberFormatter(values, locale, { context: 'chart', ticks, format });
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
