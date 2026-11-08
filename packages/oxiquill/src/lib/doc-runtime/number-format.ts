import type { NumberFormat } from './types.js';
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

const siPrefixes = ['y', 'z', 'a', 'f', 'p', 'n', 'µ', 'm', '', 'k', 'M', 'G', 'T', 'P', 'E', 'Z', 'Y'];
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

function scaleForSi(value: number, exponent: number): number {
  const [coefficient, power] = value.toExponential().split('e');
  return Number(`${coefficient}e${Number(power) - exponent}`);
}

type FormatOptions = {
  context: 'chart' | 'table';
  ticks?: boolean;
  format?: NumberFormat;
  useGrouping?: boolean;
};

export function numberFormatter(
  values: readonly unknown[],
  locale: RuntimeLocale,
  { context, ticks = false, format = {}, useGrouping = false }: FormatOptions
): (value: number) => string {
  const table = context === 'table';
  const bounds = numericBounds(values);
  const magnitude = bounds ? Math.max(Math.abs(bounds.minimum), Math.abs(bounds.maximum)) : 0;
  const span = bounds ? bounds.maximum - bounds.minimum : 0;
  const narrow = span > 0 && span / magnitude <= 0.001;
  const fixed = format.fractionDigits;
  const precision = format.significantDigits ?? (ticks ? 17 : 6);
  const localeTag = locale === 'ja' ? 'ja-JP' : 'en-US';
  const zeroTolerance =
    !table &&
    !ticks &&
    format.notation !== 'scientific' &&
    format.notation !== 'standard' &&
    bounds &&
    bounds.minimum < 0 &&
    bounds.maximum > 0
      ? magnitude * Number.EPSILON
      : 0;
  const digits =
    fixed === undefined
      ? { maximumSignificantDigits: precision }
      : { minimumFractionDigits: fixed, maximumFractionDigits: fixed };
  const rounder = new Intl.NumberFormat('en-US', {
    ...(fixed === undefined ? { maximumSignificantDigits: format.significantDigits ?? 6 } : digits),
    useGrouping: false
  });
  let exponent = magnitude > 0 ? Math.floor(Math.log10(magnitude) / 3) * 3 : 0;
  if (exponent >= -24 && exponent <= 24 && Number(rounder.format(scaleForSi(magnitude, exponent))) >= 1000)
    exponent += 3;
  const si = format.notation === 'si' && exponent >= -24 && exponent <= 24;
  const chartScientific =
    format.notation === 'scientific' ||
    (format.notation === 'si'
      ? !si
      : format.notation !== 'standard' &&
        fixed === undefined &&
        !narrow &&
        (magnitude >= 1e6 || (magnitude > 0 && magnitude < 1e-4)));
  const suffix = table
    ? si
      ? siPrefixes[exponent / 3 + 8]
      : ''
    : (si ? siPrefixes[exponent / 3 + 8] : '') + (format.unit ?? '');
  const append = (text: string) => (suffix ? `${text} ${suffix}` : text);
  const chartFormatter = new Intl.NumberFormat(localeTag, {
    useGrouping: !si && !chartScientific && magnitude >= 10_000,
    notation: chartScientific && !si ? 'scientific' : 'standard',
    ...digits
  });
  return (value) => {
    if (!Number.isFinite(value)) return append(String(value));
    if (table && value === 0) return '0';
    const normalized = Math.abs(value) <= zeroTolerance ? 0 : value;
    const exactInteger =
      table && Number.isSafeInteger(value) && fixed === undefined && format.significantDigits === undefined;
    const scientific = table
      ? format.notation === 'scientific' ||
        (format.notation === 'si'
          ? !si
          : format.notation !== 'standard' && !exactInteger && (Math.abs(value) >= 1e6 || Math.abs(value) < 1e-4))
      : chartScientific;
    const formatter = table
      ? new Intl.NumberFormat(localeTag, {
          useGrouping: useGrouping && !si && !scientific,
          notation: scientific && !si ? 'scientific' : 'standard',
          ...(exactInteger && !si && !scientific ? { maximumFractionDigits: 0 } : digits)
        })
      : chartFormatter;
    const scaled = si ? scaleForSi(normalized, exponent) : normalized;
    // Charts retain their established rounding, including authored fixed decimals.
    // Tables round the decimal representation directly. Preserve finite extremes
    // if rounding to significant digits would overflow the double.
    const preserveTick = !si && ticks && format.significantDigits === undefined && fixed === undefined;
    const rounded =
      table || preserveTick
        ? scaled
        : (scientific && !si) || fixed === undefined
          ? Number(scaled.toPrecision(precision))
          : Number(scaled.toFixed(fixed));
    const displayed = Number.isFinite(rounded) ? rounded : scaled;
    // Intl rounds the shortest decimal representation directly, avoiding toFixed's
    // extra binary digits and toPrecision's overflow near Number.MAX_VALUE.
    const text = formatter.format(displayed || 0).replace(/^-0([.,]0+)?(E[+-]?\d+)?$/u, '0$1$2');
    if (!table && scientific && !si && normalized !== 0) {
      const [coefficient, power] = text.split('E');
      return append(`${coefficient}×10${String(Number(power)).replace(/./gu, (digit) => superscripts[digit])}`);
    }
    // Scientific zero has no exponent, and chart fixed precision keeps its padding.
    return append(scientific && !si && normalized === 0 ? text.split('E')[0] : text);
  };
}
