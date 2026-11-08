import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { outputArtifactLimits } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';
import { formatTableNumber } from '../../packages/oxiquill/src/lib/doc-runtime/table-format';
import { chartNumberFormatter } from '../../packages/oxiquill/src/lib/doc-runtime/chart-format';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import TableOutput, { tableToCsv } from '../../packages/oxiquill/src/components/doc-runtime/TableOutput';
import { CellOutput } from '../../packages/oxiquill/src/components/doc-runtime/CellOutput';
import type {
  CellExecutionResult,
  NumberFormat,
  TableArtifact
} from '../../packages/oxiquill/src/lib/doc-runtime/types';

const outcome = { kind: 'outcome', state: 'partial', label: 'Iteration limit reached' } as const;
const table: TableArtifact = {
  kind: 'table',
  columns: [
    { key: 'value', label: 'Quantity', type: 'number', format: { fractionDigits: 2, unit: 's' }, nullText: 'Missing' },
    { key: 'note', label: '=Note', nullText: '<absent>' }
  ],
  rows: [
    [1.2349, '=formula'],
    [1.2341, null],
    [null, 'text']
  ]
};
afterEach(cleanup);

it.each(['en', 'ja'] as const)('formats table numbers and explicit chart notation in %s', (locale) => {
  const examples: [number, NumberFormat, string][] = [
    [0, { fractionDigits: 2 }, '0'],
    [-0, { notation: 'scientific' }, '0'],
    [0.30000000000000004, { fractionDigits: 2 }, '0.30'],
    [-0.1, { fractionDigits: 2 }, '-0.10'],
    [-0.0001, { fractionDigits: 2, notation: 'standard' }, '0.00'],
    [1e-7, { notation: 'standard' }, '0.0000001'],
    [1e21, { notation: 'standard' }, '1000000000000000000000'],
    [1234, { notation: 'scientific', fractionDigits: 2 }, '1.23E3'],
    [0.0012, { notation: 'si' }, '1.2 m'],
    [1200, { notation: 'si', unit: 'V' }, '1.2 k'],
    [999.9996, { notation: 'si' }, '1 k'],
    [1e-27, { notation: 'si' }, '1E-27'],
    [Number.MIN_VALUE, {}, '5E-324'],
    [Number.MAX_VALUE, {}, '1.79769E308'],
    [Number.MAX_SAFE_INTEGER, {}, '9007199254740991'],
    [0.1, { fractionDigits: 20 }, '0.10000000000000000000']
  ];
  for (const [value, format, expected] of examples)
    expect(formatTableNumber(value, locale, false, format)).toBe(expected);
  expect(chartNumberFormatter([1e6, 1e6 + 1], locale, true, { notation: 'scientific' })(1e6)).toBe('1×10⁶');
  expect(chartNumberFormatter([1e-7], locale, false, { notation: 'standard' })(1e-7)).toBe('0.0000001');
  expect(chartNumberFormatter([-1, 1], locale, false, { notation: 'scientific' })(1e-20)).toBe('1×10⁻²⁰');
  expect(chartNumberFormatter([-1, 1], locale, false, { notation: 'standard' })(1e-20)).toBe('0.00000000000000000001');
  expect(chartNumberFormatter([0], locale, false, { fractionDigits: 2 })(-0)).toBe('0.00');
  expect(chartNumberFormatter([1.005], locale, false, { fractionDigits: 2 })(1.005)).toBe('1.00');
  expect(formatTableNumber(1.005, locale, false, { fractionDigits: 2 })).toBe('1.01');
  expect(chartNumberFormatter([Number.MAX_VALUE], locale)(Number.MAX_VALUE)).toBe('1.79769×10³⁰⁸');
});

it.each([
  { extra: 1 },
  { format: { extra: 1 } },
  { format: { significantDigits: 0 } },
  { format: { significantDigits: 18 } },
  { format: { fractionDigits: -1 } },
  { format: { fractionDigits: 21 } },
  { format: { significantDigits: 2, fractionDigits: 2 } },
  { format: { notation: 'compact' } },
  { format: { notation: null } },
  { format: { significantDigits: 1.5 } },
  { format: { fractionDigits: Infinity } },
  { format: { unit: '日'.repeat(6000) } },
  { nullText: 'a'.repeat(16385) },
  { type: 'string', format: {} },
  { type: undefined, format: {} }
])('rejects malformed table descriptors with their column index: %j', (patch) => {
  const result = validateOutputArtifacts([{ ...table, columns: [{ ...table.columns[0], ...patch }] }])[0];
  expect(result).toMatchObject({ status: 'error', index: 0, message: expect.stringContaining('column 1') });
});

it('accounts for added column metadata in the run budget', () => {
  const columns = Array.from({ length: 100 }, (_, index) => ({
    key: String(index),
    label: 'V',
    type: 'number',
    nullText: 'a'.repeat(16384),
    format: { unit: 'b'.repeat(16384) }
  }));
  const outputs = validateOutputArtifacts(Array.from({ length: 6 }, () => ({ kind: 'table', columns, rows: [] })));
  expect(outputs.at(-1)).toMatchObject({ status: 'error', message: expect.stringContaining('metadata exceeds') });
});

it.each(['en', 'ja'] as const)('sorts rounded cells and exports raw values in %s', (locale) => {
  render(<TableOutput table={table} labels={labelsForLanguage(locale)} />);
  expect(screen.getByRole('button', { name: 'Quantity (s)' })).toBeVisible();
  expect(screen.getAllByText('1.23')).toHaveLength(2);
  expect(screen.getByText('Missing')).toBeVisible();
  expect(screen.getByText('<absent>')).toBeVisible();
  fireEvent.click(screen.getByRole('button', { name: 'Quantity (s)' }));
  const rows = screen.getAllByRole('row');
  expect(within(rows[1]).getAllByRole('cell')[0]).toHaveAttribute('title', '1.2341');
  expect(within(rows[2]).getAllByRole('cell')[0]).toHaveAttribute('title', '1.2349');
  expect(tableToCsv(table.columns, table.rows)).toEqual({
    ok: true,
    csv: "Quantity (s),'=Note\n1.2349,'=formula\n1.2341,\n,text"
  });
});

it.each([
  { state: 'unknown' },
  { label: '' },
  { label: ' \n ' },
  { label: '日'.repeat(86) },
  { status: 'a'.repeat(257) },
  { explanation: 'a'.repeat(16385) },
  { extra: 1 },
  { diagnostics: [{ name: '', value: 1 }] },
  { diagnostics: [{ name: 'a'.repeat(65), value: 1 }] },
  { diagnostics: [{ name: 'x', value: NaN }] },
  { diagnostics: [{ name: 'x', value: Infinity }] },
  { diagnostics: [{ name: 'x', value: '1' }] },
  { diagnostics: [{ name: 'x', value: 1, unit: '日'.repeat(11) }] },
  { diagnostics: [{ name: 'x', value: 1, extra: 1 }] },
  { diagnostics: Array.from({ length: 17 }, () => ({ name: 'x', value: 1 })) }
])('isolates invalid outcomes: %j', (patch) => {
  expect(
    validateOutputArtifacts([
      { ...outcome, ...patch },
      { kind: 'text', stream: 'stdout', content: 'retained' }
    ])
  ).toMatchObject([
    { status: 'error', index: 0 },
    { status: 'valid', index: 1 }
  ]);
});

it('accepts exact UTF-8 limits and rejects a second outcome even after an invalid first', () => {
  expect(
    validateOutputArtifacts([
      {
        ...outcome,
        label: '日'.repeat(85) + 'x',
        status: 's'.repeat(256),
        explanation: 'a'.repeat(16384),
        diagnostics: Array.from({ length: 16 }, () => ({ name: 'a'.repeat(64), value: 1, unit: 'u'.repeat(32) }))
      }
    ])[0].status
  ).toBe('valid');
  const result = validateOutputArtifacts([{ ...outcome, state: '?' }, outcome]);
  expect(result).toMatchObject([
    { status: 'error', index: 0 },
    { status: 'error', index: 1, message: expect.stringContaining('at most one') }
  ]);
  expect(outputArtifactLimits.outcomeDiagnostics).toBe(16);
});

it.each(['satisfied', 'partial', 'failed', 'unavailable'] as const)(
  'renders %s as an outcome rather than an execution error',
  async (state) => {
    const labels = labelsForLanguage('ja');
    const result: CellExecutionResult = {
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'ordinary output' },
        {
          ...outcome,
          state,
          label: '<b>literal</b>',
          status: 'MaxIterations',
          diagnostics: [{ name: 'step', value: 0.02, unit: 's' }]
        }
      ]
    };
    const view = render(
      <CellOutput
        cellTitle="Solver"
        outputId="solver"
        labels={labels}
        runMode="button"
        isRunning={false}
        result={result}
      />
    );
    const region = screen.getByRole('region', { name: labels.cellOutput('Solver') });
    expect(region.querySelector('.doc-cell__outputs')?.firstElementChild).toHaveAttribute('data-outcome', state);
    expect(screen.getByText(`${labels.outcomeState(state)}: <b>literal</b>`)).toBeVisible();
    expect(region.querySelector('b')).toBeNull();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('0.02 s')).toBeVisible();
    await waitFor(() =>
      expect(screen.getAllByRole('status')[1]).toHaveTextContent(labels.outcomeAnnouncement(state, '<b>literal</b>'))
    );
    expect(screen.getAllByRole('status')[0]).toHaveTextContent(labels.cellCompleted);
    view.rerender(
      <CellOutput
        cellTitle="Solver"
        outputId="solver"
        labels={labels}
        runMode="button"
        isRunning={false}
        isStale
        result={result}
      />
    );
    await waitFor(() => expect(screen.getAllByRole('status')[1]).toHaveTextContent(/^$/u));
  }
);
