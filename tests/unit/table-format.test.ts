import { describe, expect, it } from 'vitest';
import { formatTableNumber, tableColumnGrouping } from '../../packages/oxiquill/src/lib/doc-runtime/table-format';

describe.each(['en', 'ja'] as const)('table numbers in %s', (locale) => {
  it.each([
    [123456789, '123456789'],
    [2024, '2024'],
    [9007199254740991, '9007199254740991'],
    [0.30000000000000004, '0.3'],
    [9007199254740992, '9.0072E15'],
    [2 ** 60, '1.15292E18'],
    [-(2 ** 60), '-1.15292E18'],
    [1e21, '1E21'],
    [1e300, '1E300'],
    [1e-7, '1E-7'],
    [-0, '0'],
    [1000000.5, '1E6'],
    [0.0001, '0.0001'],
    [Infinity, 'Infinity']
  ])('formats %s as %s', (value, expected) => {
    expect(formatTableNumber(Number(value), locale)).toBe(expected);
  });
  it('preserves integer digits with column grouping', () => {
    expect(formatTableNumber(9007199254740991, locale, true)).toBe('9,007,199,254,740,991');
  });
});

it('chooses grouping from every retained row, not the visible page', () => {
  const rows = Array.from({ length: 30 }, (_, i) => [2024 + i, i === 29 ? -10000 : i, 'text']);
  expect(tableColumnGrouping(rows, 3)).toEqual([false, true, false]);
  expect(tableColumnGrouping([], 2)).toEqual([false, false]);
});
