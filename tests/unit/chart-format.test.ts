import { describe, expect, it } from 'vitest';
import {
  chartCoordinateFormatter,
  chartNumberFormatter,
  numericBounds
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-format';

describe('chart number formatting', () => {
  it.each(['en', 'ja'] as const)('uses stable axis notation and precise ticks in %s', (locale) => {
    expect(chartNumberFormatter([1998, 2019], locale)(1998)).toBe('1998');
    expect(chartNumberFormatter([0, 1], locale)(0.1 + 0.2)).toBe('0.3');
    expect(chartNumberFormatter([-1, 1], locale)(-0)).toBe('0');
    expect(chartNumberFormatter([1e6, 3e20], locale)(3e20)).toBe('3×10²⁰');
    expect(chartNumberFormatter([1e-10, 1e-8], locale)(1e-10)).toBe('1×10⁻¹⁰');
    const narrow = chartNumberFormatter([1_000_000, 1_000_010], locale, true);
    expect(narrow(1_000_002)).toBe('1,000,002');
    const adjacent = chartNumberFormatter([1e15, 1e15 + 1], locale, true);
    expect(adjacent(1e15)).not.toBe(adjacent(1e15 + 1));
    expect(chartNumberFormatter([0, 1], locale, true)(0.30000000000000004)).toBe('0.30000000000000004');
    const zoomed = chartNumberFormatter([0, 3e20], locale, true);
    expect(zoomed(1e20)).not.toBe(zoomed(1e20 + 16384));
    expect(chartNumberFormatter([1e6, 1e6], locale)(1e6)).toBe('1×10⁶');
    expect(chartNumberFormatter([], locale)(0)).toBe('0');
    expect(chartNumberFormatter([], locale)(Infinity)).toBe('Infinity');
  });
  it('ignores missing values and handles an empty range', () => {
    expect(numericBounds([null, NaN, Infinity, '2'])).toBeUndefined();
    expect(numericBounds([null, -2, 5])).toEqual({ minimum: -2, maximum: 5 });
  });
  it.each(['UTC', 'Asia/Tokyo', 'America/New_York'])('renders explicit UTC independently of TZ=%s', (timezone) => {
    const previous = process.env.TZ;
    process.env.TZ = timezone;
    try {
      for (const locale of ['en', 'ja'] as const) {
        const format = chartCoordinateFormatter([0, 3600000], 'time', locale);
        expect(format('2024-03-10T01:30:00-05:00')).toBe(format(Date.parse('2024-03-10T06:30:00Z')));
        expect(format(0)).toContain('UTC');
        expect(chartCoordinateFormatter([0, 3600000], 'time', locale, true)(0)).toBe('00:00:00');
        const milliseconds = chartCoordinateFormatter([0, 1000], 'time', locale, true);
        expect(milliseconds(0)).not.toBe(milliseconds(1));
      }
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });
});
