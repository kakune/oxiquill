import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellExecutionResult, CellManifest, InputSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import {
  validateOutputArtifacts,
  type ValidatedImageArtifact
} from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import { chart, echartsInit, echartsUse, mermaidInitialize, mermaidRender } from './mocks/external-runtime';

type ManifestSnapshot = {
  cells: readonly CellManifest[];
  version: string;
};

const runtimeMocks = vi.hoisted(() => ({
  getCell: vi.fn(),
  getManifestSnapshot: vi.fn<() => ManifestSnapshot>(() => ({ cells: [], version: 'v1' })),
  manifestListeners: [] as Array<() => void>,
  manifestUnsubscribers: [] as Array<ReturnType<typeof vi.fn>>,
  scheduleGeneratedManifestRefresh: vi.fn(),
  runInteractiveCell: vi.fn()
}));

const mocks = {
  ...runtimeMocks,
  chart,
  echartsInit,
  echartsUse,
  mermaidInitialize,
  mermaidRender
};

vi.mock('../../packages/oxiquill/src/lib/doc-runtime/manifest', () => ({
  getCell: runtimeMocks.getCell,
  getManifestSnapshot: runtimeMocks.getManifestSnapshot,
  scheduleGeneratedManifestRefresh: runtimeMocks.scheduleGeneratedManifestRefresh,
  subscribeManifest: vi.fn((listener: () => void) => {
    runtimeMocks.manifestListeners.push(listener);
    const unsubscribe = vi.fn();
    runtimeMocks.manifestUnsubscribers.push(unsubscribe);
    return unsubscribe;
  })
}));
vi.mock('../../packages/oxiquill/src/lib/doc-runtime/runtime-client', () => ({
  runInteractiveCell: runtimeMocks.runInteractiveCell
}));

await import('./mocks/mermaid');
const { default: InteractiveCell } = await import('../../packages/oxiquill/src/components/doc-runtime/InteractiveCell');
const { default: ArtifactErrorBoundary } =
  await import('../../packages/oxiquill/src/components/doc-runtime/ArtifactErrorBoundary');
const {
  default: MermaidDiagram,
  getMermaidColorScheme,
  mermaidDiagramKind
} = await import('../../packages/oxiquill/src/components/doc-runtime/MermaidDiagram');
const {
  default: OutputRenderer,
  htmlArtifactContentSecurityPolicy,
  htmlArtifactSrcdoc,
  imageArtifactSource,
  artifactKeys,
  LazyChartOutput
} = await import('../../packages/oxiquill/src/components/doc-runtime/OutputRenderer');
const chartOutputModule = await import('../../packages/oxiquill/src/components/doc-runtime/ChartOutput');
const { chartDataSummary, chartSpecToEChartsOptions } = chartOutputModule;
const {
  default: TableOutput,
  formatTableCell,
  sortRows,
  tableToCsv,
  visibleRows
} = await import('../../packages/oxiquill/src/components/doc-runtime/TableOutput');

const pngBase64 = 'iVBORw0KGgo=';
const jpegBase64 = '/9j/';

function validatedImage(value: unknown): ValidatedImageArtifact {
  const result = validateOutputArtifacts([value])[0];
  if (result?.status !== 'valid' || result.artifact.kind !== 'image') {
    throw new Error('Expected a valid image artifact fixture.');
  }
  return result.artifact;
}

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];

  disconnect = vi.fn();
  observe = vi.fn();
  unobserve = vi.fn();

  constructor(readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
}

const inputs: InputSpec[] = [
  { name: 'enabled', type: 'checkbox', label: 'enabled', value: true, options: [] },
  {
    name: 'operation',
    type: 'select',
    label: 'operation',
    value: 'double',
    options: [
      { label: 'double', value: 'double' },
      { label: 'triple', value: 'triple' }
    ]
  },
  {
    name: 'style',
    type: 'radio',
    label: 'style',
    value: 'compact',
    options: [
      { label: 'compact', value: 'compact' },
      { label: 'verbose', value: 'verbose' }
    ]
  },
  { name: 'notes', type: 'textarea', label: 'notes', value: 'hello', options: [] },
  { name: 'ratio', type: 'range', label: 'ratio', value: 1.5, min: 0, max: 4, step: 0.5, options: [] },
  { name: 'count', type: 'number', label: 'count', value: 2, min: 0, max: 10, step: 1, options: [] },
  { name: 'label', type: 'text', label: 'label', value: 'sample', options: [] }
];

function makeCell(overrides: Partial<CellManifest> = {}): CellManifest {
  return {
    id: 'cell-one',
    language: 'rust',
    title: 'Cell one',
    run: 'button',
    source: 'println!("ok");',
    sourceHtml: '<pre class="shiki"><code>println!("ok");</code></pre>',
    inputs,
    packages: [],
    crates: [],
    timeoutMs: 1_000,
    showSource: true,
    pagePath: 'page.mdx',
    ...overrides
  };
}

let manifestSnapshot: ManifestSnapshot = { cells: [], version: 'v1' };

function setManifestCells(cells: readonly CellManifest[], version = 'v1') {
  manifestSnapshot = { cells, version };
  mocks.getManifestSnapshot.mockImplementation(() => manifestSnapshot);
}

function createDeferredResult() {
  let resolve!: (value: CellExecutionResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<CellExecutionResult>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

beforeEach(() => {
  vi.clearAllMocks();
  setManifestCells([]);
  runtimeMocks.manifestListeners = [];
  runtimeMocks.manifestUnsubscribers = [];
  mocks.manifestListeners = runtimeMocks.manifestListeners;
  mocks.manifestUnsubscribers = runtimeMocks.manifestUnsubscribers;
  TestResizeObserver.instances = [];
  document.documentElement.lang = 'en';
  document.documentElement.removeAttribute('data-theme');
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('InteractiveCell', () => {
  it('renders an error for unknown cells', () => {
    setManifestCells([]);

    render(<InteractiveCell cellId="missing" />);

    expect(screen.getByText('Unknown interactive cell: missing')).toBeVisible();
  });

  it('hydrates from its page-local cell prop without loading the global manifest', () => {
    setManifestCells([]);

    render(<InteractiveCell cellId="cell-one" cell={makeCell()} />);

    expect(screen.getByTestId('cell-cell-one')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Cell one' })).toBeVisible();
    expect(screen.getByRole('region', { name: 'Output for Cell one' })).toBeVisible();
  });

  it('renders controls, toggles source, runs button cells, and displays all output types', async () => {
    setManifestCells([makeCell()]);
    mocks.runInteractiveCell.mockResolvedValue({
      stdout: 'stdout',
      stderr: 'stderr',
      value: { ok: true },
      plots: [{ kind: 'line', x_label: 'x', y_label: 'y', points: [[0, 1]] }]
    });

    render(<InteractiveCell cellId="cell-one" />);

    expect(screen.getByText('Run the cell to show its output.')).toBeVisible();
    expect(screen.getByText('println!("ok");')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Hide code' }));
    expect(screen.queryByText('println!("ok");')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show code' }));
    expect(screen.getByText('println!("ok");')).toBeVisible();

    fireEvent.click(screen.getByLabelText('enabled'));
    fireEvent.input(screen.getByLabelText('operation'), { target: { value: 'triple' } });
    fireEvent.input(screen.getByLabelText('verbose'), { target: { value: 'verbose' } });
    fireEvent.input(screen.getByLabelText('notes'), { target: { value: 'changed' } });
    fireEvent.input(screen.getByRole('slider', { name: 'ratio' }), { target: { value: '2.5' } });
    fireEvent.input(screen.getByLabelText('count'), { target: { value: '4' } });
    fireEvent.input(screen.getByLabelText('label'), { target: { value: 'next' } });

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('stdout'));
    expect(screen.getByText('stderr')).toBeVisible();
    expect(screen.getByTestId('value-output')).toHaveTextContent('"ok": true');
    await waitFor(() =>
      expect(mocks.chart.setOption).toHaveBeenCalledWith(
        expect.objectContaining({
          xAxis: expect.objectContaining({ type: 'value', name: 'x' }),
          yAxis: expect.objectContaining({ type: 'value', name: 'y' })
        }),
        { notMerge: true }
      )
    );
    expect(mocks.runInteractiveCell).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cell-one' }),
      expect.objectContaining({
        enabled: false,
        operation: 'triple',
        style: 'verbose',
        notes: 'changed',
        ratio: 2.5,
        count: 4,
        label: 'next'
      }),
      'v1',
      expect.anything()
    );
  });

  it('scopes input ids and radio groups per cell', () => {
    const radioOnly = inputs.filter((input) => input.name === 'style');
    setManifestCells([
      makeCell({ id: 'cell-one', title: 'cell-one', inputs: radioOnly }),
      makeCell({ id: 'cell-two', title: 'cell-two', inputs: radioOnly })
    ]);

    render(
      <>
        <InteractiveCell cellId="cell-one" />
        <InteractiveCell cellId="cell-two" />
      </>
    );

    const first = within(screen.getByTestId('cell-cell-one'));
    const second = within(screen.getByTestId('cell-cell-two'));
    const firstCompact = first.getByLabelText('compact') as HTMLInputElement;
    const firstVerbose = first.getByLabelText('verbose') as HTMLInputElement;
    const secondCompact = second.getByLabelText('compact') as HTMLInputElement;

    expect(firstCompact.name).toBe('doc-input-cell-one-style');
    expect(secondCompact.name).toBe('doc-input-cell-two-style');
    expect(firstCompact).toBeChecked();
    expect(secondCompact).toBeChecked();

    fireEvent.input(firstVerbose, { target: { value: 'verbose' } });

    expect(firstVerbose).toBeChecked();
    expect(secondCompact).toBeChecked();
  });

  it('uses visible input labels as accessible names and associates optional descriptions', () => {
    setManifestCells([
      makeCell({
        inputs: [
          {
            name: 'internal_value',
            type: 'number',
            label: 'Visible value',
            description: 'Choose a value from zero through ten.',
            value: 2,
            min: 0,
            max: 10,
            step: 1,
            options: []
          },
          {
            name: 'internal_range',
            type: 'range',
            label: 'Visible range',
            description: 'Adjust the sample range.',
            value: 1.5,
            min: 0,
            max: 4,
            step: 0.5,
            options: []
          }
        ]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);

    const number = screen.getByRole('spinbutton', { name: 'Visible value' });
    expect(number).toHaveAttribute('id', 'doc-input-cell-one-internal_value');
    expect(number).toHaveAccessibleDescription('Choose a value from zero through ten.');
    expect(screen.queryByRole('spinbutton', { name: 'internal_value' })).not.toBeInTheDocument();

    const range = screen.getByRole('slider', { name: 'Visible range' });
    expect(range).toHaveAttribute('id', 'doc-input-cell-one-internal_range');
    expect(range).toHaveAttribute(
      'aria-describedby',
      'doc-input-cell-one-internal_range-description doc-input-cell-one-internal_range-value'
    );
    expect(screen.getByTestId('internal_range-value')).toHaveAttribute('for', 'doc-input-cell-one-internal_range');
  });

  it('reports numeric validation with localized error semantics', () => {
    document.documentElement.lang = 'ja';
    setManifestCells([
      makeCell({
        inputs: [
          {
            name: 'count',
            type: 'number',
            label: '回数',
            value: 2,
            min: 1,
            max: 10,
            step: 1,
            options: []
          }
        ]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    const input = screen.getByRole('spinbutton', { name: '回数' });
    fireEvent.input(input, { target: { value: '0' } });

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-errormessage', 'doc-input-cell-one-count-validation');
    expect(screen.getByRole('alert')).toHaveTextContent('1 以上の値を入力してください。');
    expect(screen.getByRole('button', { name: '実行' })).toBeDisabled();
  });

  it('preserves invalid numeric edits and never commits or runs them', async () => {
    mocks.runInteractiveCell.mockResolvedValue({ stdout: 'ok', plots: [] });
    setManifestCells([
      makeCell({
        inputs: [{ name: 'count', type: 'number', label: 'count', value: 1, min: -2, max: 2, step: 0.5, options: [] }]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    const input = screen.getByRole('spinbutton', { name: 'count' });
    const runButton = screen.getByRole('button', { name: 'Run' });

    for (const invalidValue of ['', '-', '1e309', '-2.5', '2.5', '1.25']) {
      fireEvent.input(input, { target: { value: invalidValue } });
      expect(input).toHaveValue(invalidValue);
      expect(runButton).toBeDisabled();
      fireEvent.click(runButton);
    }
    expect(mocks.runInteractiveCell).not.toHaveBeenCalled();

    fireEvent.input(input, { target: { value: '-1.5' } });
    expect(runButton).toBeEnabled();
    fireEvent.click(runButton);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledOnce());
    expect(mocks.runInteractiveCell).toHaveBeenCalledWith(expect.anything(), { count: -1.5 }, 'v1', expect.anything());
  });

  it('supports keyboard stepping for numeric spinbuttons and clamps at their bounds', () => {
    setManifestCells([
      makeCell({
        inputs: [{ name: 'count', type: 'integer', label: 'count', value: 1, min: 0, max: 2, step: 1, options: [] }]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    const input = screen.getByRole('spinbutton', { name: 'count' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('2');
    expect(input).toHaveAttribute('aria-valuenow', '2');
    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(input).toHaveValue('2');
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(input).toHaveValue('1');
  });

  it('formats range labels from fractional and exponential steps', () => {
    setManifestCells([
      makeCell({
        inputs: [
          { name: 'fine', type: 'range', label: 'fine', value: 1.2, min: 0, max: 2, step: 0.001, options: [] },
          {
            name: 'tiny',
            type: 'range',
            label: 'tiny',
            value: 0.0000003,
            min: 0,
            max: 0.000001,
            step: 1e-7,
            options: []
          }
        ]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByTestId('fine-value')).toHaveTextContent('1.200');
    expect(screen.getByTestId('tiny-value')).toHaveTextContent('0.0000003');
  });

  it('shows running and error states', async () => {
    setManifestCells([makeCell()]);
    mocks.runInteractiveCell.mockRejectedValue(new Error('failed'));

    render(<InteractiveCell cellId="cell-one" />);
    const runButton = screen.getByRole('button', { name: 'Run' });
    runButton.focus();
    fireEvent.click(runButton);

    expect(screen.getByText('Running cell...')).toBeVisible();
    expect(within(screen.getByRole('region', { name: 'Output for Cell one' })).getByRole('status')).toHaveTextContent(
      'Cell execution started.'
    );
    expect(screen.getByRole('button', { name: 'Running' })).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByRole('button', { name: 'Running' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Running' })).toHaveFocus();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cell execution failed: failed'));
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();
  });

  it('announces successful completion politely without moving focus', async () => {
    const execution = createDeferredResult();
    mocks.runInteractiveCell.mockReturnValue(execution.promise);
    setManifestCells([makeCell()]);

    render(<InteractiveCell cellId="cell-one" />);
    const runButton = screen.getByRole('button', { name: 'Run' });
    runButton.focus();
    fireEvent.click(runButton);

    await act(async () => {
      execution.resolve({
        stdout: 'done',
        plots: [],
        outputs: [{ kind: 'text', stream: 'stdout', content: 'done' }]
      });
      await execution.promise;
    });

    await waitFor(() =>
      expect(within(screen.getByRole('region', { name: 'Output for Cell one' })).getByRole('status')).toHaveTextContent(
        'Cell completed.'
      )
    );
    expect(screen.getByRole('button', { name: 'Run' })).toHaveFocus();
    expect(screen.getByTestId('run-output')).toHaveTextContent('done');
  });

  it('coerces non-Error failures to strings', async () => {
    setManifestCells([makeCell()]);
    mocks.runInteractiveCell.mockRejectedValueOnce('string failure').mockRejectedValueOnce(Object.create(null));

    render(<InteractiveCell cellId="cell-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('string failure')).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Cell execution failed: Unknown error.'));
  });

  it.each(['error', 'cancel', 'invalid'])(
    'keeps the last output mounted while running and after %s',
    async (outcome) => {
      setManifestCells([makeCell()]);
      mocks.runInteractiveCell.mockResolvedValueOnce({ stdout: 'retained', plots: [] });
      render(<InteractiveCell cellId="cell-one" />);
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
      const previous = await screen.findByTestId('run-output');
      const next = createDeferredResult();
      mocks.runInteractiveCell.mockReturnValueOnce(next.promise);
      fireEvent.click(screen.getByRole('button', { name: 'Run' }));
      await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(2));
      expect(screen.getByTestId('run-output')).toBe(previous);
      expect(screen.getByText('Updating…')).toHaveAttribute('aria-hidden', 'true');
      expect(screen.getByRole('region', { name: 'Output for Cell one' })).toHaveAttribute('aria-busy', 'true');
      if (outcome === 'invalid') {
        fireEvent.input(screen.getByRole('spinbutton', { name: 'count' }), { target: { value: '' } });
      } else {
        const failure = new Error('rerun failed');
        if (outcome === 'cancel') failure.name = 'AbortError';
        await act(async () => {
          next.reject(failure);
          await next.promise.catch(() => undefined);
        });
      }
      await waitFor(() =>
        expect(screen.getByRole('region', { name: 'Output for Cell one' })).toHaveAttribute('aria-busy', 'false')
      );
      expect(screen.getByTestId('run-output')).toBe(previous);
      expect(screen.getByTestId('run-output')).toHaveTextContent('retained');
      expect(screen.queryByText('Updating…')).not.toBeInTheDocument();
      expect(within(screen.getByRole('region', { name: 'Output for Cell one' })).getByRole('status')).toHaveTextContent(
        /^$/u
      );
      if (outcome === 'error') {
        expect(screen.getByRole('alert')).toHaveTextContent('rerun failed');
        mocks.runInteractiveCell.mockResolvedValueOnce({ stdout: 'recovered', plots: [] });
        fireEvent.click(screen.getByRole('button', { name: 'Retry cell' }));
        await waitFor(() => expect(previous).toHaveTextContent('recovered'));
        expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      }
    }
  );

  it('retains charts when unrelated artifacts are inserted and makes duplicate IDs unique', async () => {
    const chartArtifact = { kind: 'chart', spec: { kind: 'line', series: [] } };
    const { rerender } = render(<OutputRenderer outputs={validateOutputArtifacts([chartArtifact])} />);
    const plot = await screen.findByTestId('doc-plot');
    const outputs = validateOutputArtifacts([
      { kind: 'text', stream: 'stdout', content: 'new diagnostic' },
      null,
      chartArtifact,
      { kind: 'text', stream: 'stdout', content: 'one', id: 'duplicate' },
      { kind: 'text', stream: 'stdout', content: 'two', id: 'duplicate' },
      { kind: 'text', stream: 'stdout', content: 'three', id: 'duplicate:2' }
    ]);
    rerender(<OutputRenderer outputs={outputs} />);
    expect(screen.getByTestId('doc-plot')).toBe(plot);
    const keys = artifactKeys(outputs);
    expect(new Set(keys).size).toBe(outputs.length);
    expect(keys[2]).toBe(artifactKeys(validateOutputArtifacts([chartArtifact]))[0]);
    expect(keys[3]).toBe(
      artifactKeys(
        validateOutputArtifacts([{ kind: 'text', stream: 'stdout', content: 'replacement', id: 'duplicate' }])
      )[0]
    );
  });

  it('announces localized timeout failures as an alert', async () => {
    document.documentElement.lang = 'ja';
    setManifestCells([makeCell()]);
    mocks.runInteractiveCell.mockRejectedValue(new Error('Cell one timed out after 1000ms'));

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(screen.getByRole('button', { name: '実行' })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: '実行' }));

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'セルの実行に失敗しました: Cell one は 1000 ミリ秒でタイムアウトしました。'
      )
    );
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('runs autorun exactly once per cell and runtime version without rendering execution controls', async () => {
    mocks.runInteractiveCell.mockResolvedValue({ stdout: 'auto', plots: [] });
    setManifestCells([makeCell({ run: 'autorun' })], 'autorun-v1');

    const first = render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
    expect(screen.queryByLabelText('label')).not.toBeInTheDocument();

    first.unmount();
    const second = render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('auto'));
    expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(1);

    second.unmount();
    setManifestCells([makeCell({ run: 'autorun' })], 'autorun-v2');
    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(2));
  });

  it('runs reactive cells initially and debounces later input changes', async () => {
    mocks.runInteractiveCell.mockResolvedValue({ stdout: 'auto', plots: [] });
    setManifestCells([makeCell({ run: 'reactive' })]);

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();

    for (let value = 1; value <= 10; value += 1) {
      fireEvent.input(screen.getByRole('slider', { name: 'ratio' }), { target: { value: String(value / 4) } });
    }

    expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(2));
    expect(mocks.runInteractiveCell).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'cell-one' }),
      expect.objectContaining({ ratio: 2.5 }),
      'v1',
      expect.anything()
    );
  });

  it('blocks invalid reactive edits and schedules the latest values once validity returns', async () => {
    mocks.runInteractiveCell.mockResolvedValue({ stdout: 'auto', plots: [] });
    setManifestCells([
      makeCell({
        run: 'reactive',
        inputs: [{ name: 'count', type: 'number', label: 'count', value: 1, min: 0, max: 4, step: 0.5, options: [] }]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledOnce());
    const input = screen.getByRole('spinbutton', { name: 'count' });

    fireEvent.input(input, { target: { value: '' } });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
    expect(mocks.runInteractiveCell).toHaveBeenCalledOnce();

    fireEvent.input(input, { target: { value: '2' } });
    fireEvent.input(input, { target: { value: '3' } });
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(2));
    expect(mocks.runInteractiveCell).toHaveBeenLastCalledWith(expect.anything(), { count: 3 }, 'v1', expect.anything());
  });

  it('cancels an active reactive request and runs only the final replacement', async () => {
    const pending: Array<ReturnType<typeof createDeferredResult>> = [];
    const signals: AbortSignal[] = [];
    mocks.runInteractiveCell.mockImplementation((_cell, _values, _version, signal: AbortSignal) => {
      const deferred = createDeferredResult();
      pending.push(deferred);
      signals.push(signal);
      return deferred.promise;
    });
    setManifestCells([
      makeCell({
        run: 'reactive',
        inputs: [inputs.find((input) => input.name === 'label') as InputSpec]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(pending).toHaveLength(1));

    for (let index = 0; index < 10; index += 1) {
      fireEvent.input(screen.getByLabelText('label'), { target: { value: `newer input ${index}` } });
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));

    expect(pending).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(screen.getByText('Running cell...')).toBeVisible();
    expect(mocks.runInteractiveCell).toHaveBeenLastCalledWith(
      expect.anything(),
      { label: 'newer input 9' },
      'v1',
      expect.anything()
    );
    expect(screen.queryByText('obsolete result')).not.toBeInTheDocument();

    await act(async () => {
      pending[1].resolve({
        stdout: 'newer result',
        stderr: '',
        value: null,
        plots: [],
        outputs: [{ kind: 'text', stream: 'stdout', content: 'newer result' }]
      });
      await pending[1].promise;
    });

    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('newer result'));
  });

  it('ignores stale async errors from superseded reactive runs', async () => {
    const pending: Array<ReturnType<typeof createDeferredResult>> = [];
    mocks.runInteractiveCell.mockImplementation(() => {
      const deferred = createDeferredResult();
      pending.push(deferred);
      return deferred.promise;
    });
    setManifestCells([
      makeCell({
        run: 'reactive',
        inputs: [inputs.find((input) => input.name === 'label') as InputSpec]
      })
    ]);

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.input(screen.getByLabelText('label'), { target: { value: 'newer input' } });
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));

    await act(async () => {
      pending[0].reject(new Error('older failure'));
      await pending[0].promise.catch(() => undefined);
    });

    await waitFor(() => expect(pending).toHaveLength(2));
    expect(screen.queryByText('older failure')).not.toBeInTheDocument();

    await act(async () => {
      pending[1].resolve({
        stdout: 'newer result',
        stderr: '',
        value: null,
        plots: [],
        outputs: [{ kind: 'text', stream: 'stdout', content: 'newer result' }]
      });
      await pending[1].promise;
    });

    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('newer result'));
  });

  it('drops debounced and active callbacks when a reactive cell unmounts', async () => {
    const active = createDeferredResult();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandledRejection = vi.fn();
    let signal: AbortSignal | undefined;
    window.addEventListener('unhandledrejection', unhandledRejection);
    mocks.runInteractiveCell.mockImplementation((_cell, _values, _version, activeSignal: AbortSignal) => {
      signal = activeSignal;
      return active.promise;
    });
    setManifestCells([
      makeCell({
        run: 'reactive',
        inputs: [inputs.find((input) => input.name === 'label') as InputSpec]
      })
    ]);

    const rendered = render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledOnce());
    fireEvent.input(screen.getByLabelText('label'), { target: { value: 'discarded' } });
    rendered.unmount();

    expect(signal?.aborted).toBe(true);

    active.reject(new Error('failure after unmount'));
    await active.promise.catch(() => undefined);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));

    expect(mocks.runInteractiveCell).toHaveBeenCalledOnce();
    expect(unhandledRejection).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
    window.removeEventListener('unhandledrejection', unhandledRejection);
  });

  it('supports reactive cells without inputs and with hidden source', () => {
    setManifestCells([makeCell({ inputs: [], showSource: false, run: 'reactive' })]);

    render(<InteractiveCell cellId="cell-one" />);

    expect(screen.queryByText('println!("ok");')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('uses Japanese runtime labels when the document language is Japanese', () => {
    document.documentElement.lang = 'ja';
    setManifestCells([makeCell()]);

    render(<InteractiveCell cellId="cell-one" />);

    expect(screen.getByRole('button', { name: 'コードを隠す' })).toBeVisible();
    expect(screen.getByRole('button', { name: '実行' })).toBeVisible();
  });

  it('renders Python labeling and empty successful results', async () => {
    setManifestCells([makeCell({ language: 'python', inputs: [] })]);
    mocks.runInteractiveCell.mockResolvedValue({ stdout: '', stderr: '', value: '', plots: [] });

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByText('Python + Pyodide')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalled());
    expect(screen.queryByTestId('run-output')).not.toBeInTheDocument();
    expect(screen.queryByTestId('value-output')).not.toBeInTheDocument();
  });

  it('refreshes rendered cell data when the generated manifest changes without a runtime rebuild', async () => {
    setManifestCells([makeCell({ sourceHtml: '<pre class="shiki"><code>println!("old");</code></pre>' })]);

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByText('println!("old");')).toBeVisible();

    act(() => {
      setManifestCells([makeCell({ sourceHtml: '<pre class="shiki"><code>println!("new");</code></pre>' })]);
      mocks.manifestListeners[0]();
    });

    await waitFor(() => expect(screen.getByText('println!("new");')).toBeVisible());
  });

  it('requests shared manifest refreshes and unsubscribes each mounted consumer independently', () => {
    setManifestCells([makeCell()]);

    const first = render(<InteractiveCell cellId="cell-one" />);
    const second = render(<InteractiveCell cellId="cell-one" />);

    expect(mocks.scheduleGeneratedManifestRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.manifestListeners).toHaveLength(2);
    expect(mocks.manifestUnsubscribers).toHaveLength(2);

    first.unmount();
    expect(mocks.manifestUnsubscribers[0]).toHaveBeenCalledOnce();
    expect(mocks.manifestUnsubscribers[1]).not.toHaveBeenCalled();

    second.unmount();
    expect(mocks.manifestUnsubscribers[1]).toHaveBeenCalledOnce();
  });
});

describe('ArtifactErrorBoundary', () => {
  function TestArtifact({ fail }: { fail: boolean }) {
    if (fail) throw new Error();
    return <p>replacement artifact</p>;
  }

  it('renders empty-message failures and resets even a legacy empty error state', async () => {
    const firstResetKey = {};
    const secondResetKey = {};
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    let boundary: InstanceType<typeof ArtifactErrorBoundary> | undefined;

    try {
      const { rerender } = render(
        <ArtifactErrorBoundary
          ref={(instance) => {
            boundary = instance ?? undefined;
          }}
          index={0}
          labels={labelsForLanguage('en')}
          resetKey={firstResetKey}
        >
          <TestArtifact fail />
        </ArtifactErrorBoundary>
      );

      await waitFor(() =>
        expect(screen.getByRole('alert')).toHaveTextContent('Artifact 1 failed to render: Unknown error.')
      );
      rerender(
        <ArtifactErrorBoundary
          ref={(instance) => {
            boundary = instance ?? undefined;
          }}
          index={0}
          labels={labelsForLanguage('en')}
          resetKey={firstResetKey}
        >
          <TestArtifact fail={false} />
        </ArtifactErrorBoundary>
      );
      act(() => boundary?.setState({ error: '' }));
      expect(screen.getByRole('alert')).toHaveTextContent('Artifact 1 failed to render:');

      rerender(
        <ArtifactErrorBoundary index={0} labels={labelsForLanguage('en')} resetKey={secondResetKey}>
          <TestArtifact fail={false} />
        </ArtifactErrorBoundary>
      );
      await waitFor(() => expect(screen.getByText('replacement artifact')).toBeVisible());
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('MermaidDiagram', () => {
  it('falls back to the light Mermaid palette without a document', () => {
    vi.stubGlobal('document', undefined);

    expect(getMermaidColorScheme()).toBe('light');
  });

  it('renders Mermaid SVG and initializes Mermaid only once', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg role="img"><text>diagram</text></svg>',
      bindFunctions: vi.fn()
    });

    const { rerender } = render(<MermaidDiagram diagramId="one" source={'flowchart LR\nA-->B'} />);

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByText('diagram')).toBeVisible();
    const graphic = screen.getByRole('img', { name: 'Mermaid flowchart' });
    expect(graphic).toHaveAccessibleDescription('Diagram source: flowchart LR A-->B');
    expect(graphic.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(graphic.querySelector('svg')).toHaveAttribute('focusable', 'false');
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
    expect(mocks.mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          lineColor: '#0f766e',
          primaryTextColor: '#111827'
        })
      })
    );

    rerender(<MermaidDiagram diagramId="one" source={'flowchart LR\nA-->C'} />);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
  });

  it('localizes Mermaid semantics and identifies supported diagram kinds', async () => {
    document.documentElement.lang = 'ja-JP';
    mocks.mermaidRender.mockResolvedValue({ svg: '<svg><text>sequence</text></svg>' });

    render(<MermaidDiagram diagramId="sequence" source={'sequenceDiagram\nAlice->>Bob: Hello'} />);

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByRole('img', { name: 'Mermaid シーケンス図' })).toHaveAccessibleDescription(
      '図のソース: sequenceDiagram Alice->>Bob: Hello'
    );
    expect(mermaidDiagramKind('%% comment\nstateDiagram-v2')).toBe('state');
    expect(mermaidDiagramKind('classDiagram')).toBe('class');
    expect(mermaidDiagramKind('erDiagram')).toBe('entityRelationship');
    expect(mermaidDiagramKind('journey')).toBe('journey');
    expect(mermaidDiagramKind('timeline')).toBe('timeline');
    expect(mermaidDiagramKind('unknown')).toBe('diagram');
  });

  it('renders when theme observation is unavailable', async () => {
    vi.stubGlobal('MutationObserver', undefined);
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg><text>no observer diagram</text></svg>'
    });

    render(<MermaidDiagram diagramId="no-observer" source="flowchart LR\nA-->B" />);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.getByText('no observer diagram')).toBeVisible();
  });

  it('uses a readable dark Mermaid palette when Starlight is in dark mode', async () => {
    document.documentElement.dataset.theme = 'dark';
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg><text>dark diagram</text></svg>'
    });

    render(<MermaidDiagram diagramId="dark" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(screen.getByText('dark diagram')).toBeVisible());
    expect(mocks.mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          background: '#0f172a',
          lineColor: '#67e8f9',
          primaryTextColor: '#f8fafc'
        })
      })
    );
  });

  it('rerenders Mermaid SVG when Starlight theme changes', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg><text>theme diagram</text></svg>'
    });

    render(<MermaidDiagram diagramId="theme" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(1));
    expect(mocks.mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          primaryTextColor: '#111827'
        })
      })
    );

    act(() => {
      document.documentElement.dataset.theme = 'dark';
    });

    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));
    expect(mocks.mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          primaryTextColor: '#f8fafc'
        })
      })
    );
  });

  it('renders Mermaid SVG when no bind function is returned', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg><text>plain diagram</text></svg>'
    });

    render(<MermaidDiagram diagramId="plain" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(screen.getByText('plain diagram')).toBeVisible());
  });

  it('renders Mermaid errors from Error and non-Error values', async () => {
    mocks.mermaidRender
      .mockRejectedValueOnce(new Error('bad diagram'))
      .mockRejectedValueOnce('string diagram error')
      .mockRejectedValueOnce(new Error());

    const { rerender } = render(<MermaidDiagram diagramId="bad" source="bad" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bad diagram'));

    rerender(<MermaidDiagram diagramId="bad" source="still bad" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('string diagram error'));

    rerender(<MermaidDiagram diagramId="bad" source="empty error" />);
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Mermaid diagram could not be rendered: Unknown error.')
    );
  });

  it('ignores resolved or rejected Mermaid renders after unmount', async () => {
    let resolveRender: (value: { svg: string }) => void = () => undefined;
    mocks.mermaidRender.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      })
    );

    const { unmount } = render(<MermaidDiagram diagramId="late" source="flowchart LR\nA-->B" />);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(1));
    unmount();
    resolveRender({ svg: '<svg><text>late</text></svg>' });
    await Promise.resolve();

    let rejectRender: (reason: unknown) => void = () => undefined;
    mocks.mermaidRender.mockReturnValue(
      new Promise((_, reject) => {
        rejectRender = reject;
      })
    );

    const lateError = render(<MermaidDiagram diagramId="late-error" source="bad" />);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));
    lateError.unmount();
    rejectRender(new Error('late error'));
    await Promise.resolve();

    expect(screen.queryByText('late')).not.toBeInTheDocument();
    expect(screen.queryByText('late error')).not.toBeInTheDocument();
  });
});

describe('lazy chart renderer', () => {
  const spec = {
    kind: 'line' as const,
    series: [{ points: [[0, 1]] as const }]
  };

  it('shows loading UI until the chart module resolves', async () => {
    let resolveModule: (module: typeof chartOutputModule) => void = () => undefined;
    const moduleReady = new Promise<typeof chartOutputModule>((resolve) => {
      resolveModule = resolve;
    });

    render(<LazyChartOutput spec={spec} load={() => moduleReady} />);

    expect(screen.getByRole('status')).toHaveTextContent('Loading chart renderer...');
    resolveModule(chartOutputModule);

    await waitFor(() => expect(screen.getByTestId('doc-plot')).toBeVisible());
  });

  it('shows import failures and ignores completion after unmount', async () => {
    const failed = render(
      <LazyChartOutput spec={spec} load={() => Promise.reject(new Error('missing chart chunk'))} />
    );

    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('missing chart chunk'));
    failed.unmount();

    let resolveModule: (module: typeof chartOutputModule) => void = () => undefined;
    const moduleReady = new Promise<typeof chartOutputModule>((resolve) => {
      resolveModule = resolve;
    });
    const late = render(<LazyChartOutput spec={spec} load={() => moduleReady} />);
    late.unmount();
    resolveModule(chartOutputModule);
    await Promise.resolve();

    expect(screen.queryByTestId('doc-plot')).not.toBeInTheDocument();
  });

  it('normalizes an unstringifiable chart import failure', async () => {
    render(<LazyChartOutput spec={spec} load={() => Promise.reject(Object.create(null))} />);

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Chart renderer could not be loaded: Unknown error.')
    );
  });

  it('retries a transient chart-module load failure', async () => {
    const load = vi
      .fn<() => Promise<typeof chartOutputModule>>()
      .mockRejectedValueOnce(new Error('temporary chart failure'))
      .mockResolvedValue(chartOutputModule);

    render(<LazyChartOutput spec={spec} load={load} />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('temporary chart failure'));

    fireEvent.click(screen.getByRole('button', { name: 'Retry chart rendering' }));

    await waitFor(() => expect(screen.getByTestId('doc-plot')).toBeVisible());
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe('ChartOutput options', () => {
  it('maps supported chart specs to ECharts options', () => {
    expect(
      chartSpecToEChartsOptions({
        kind: 'line',
        xLabel: 'n',
        yLabel: 'x',
        series: [
          { name: 'a', points: [[0, 1]] },
          { name: 'b', points: [[0, 2]] }
        ]
      })
    ).toMatchObject({
      legend: { top: 8 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', name: 'n' },
      yAxis: { type: 'value', name: 'x' },
      series: [
        { type: 'line', showSymbol: false, data: [[0, 1]] },
        { type: 'line', showSymbol: false, data: [[0, 2]] }
      ]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'scatter',
        tooltip: true,
        series: [{ points: [[0, 1]] }]
      })
    ).toMatchObject({
      tooltip: { trigger: 'item' },
      series: [{ type: 'scatter', symbolSize: 7, data: [[0, 1]] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'scatter',
        legend: false,
        tooltip: false,
        series: [{ name: 'hidden', points: [[0, 1]] }]
      })
    ).toMatchObject({
      legend: undefined,
      tooltip: undefined
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'bar',
        categories: ['A', 'B'],
        series: [{ values: [1, null] }]
      })
    ).toMatchObject({
      xAxis: { type: 'category', data: ['A', 'B'] },
      series: [{ type: 'bar', data: [1, null] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'histogram',
        bins: [
          [0, 1, 2],
          [1, 2, 3]
        ]
      })
    ).toMatchObject({
      xAxis: { type: 'category', data: ['0-1', '1-2'] },
      series: [{ type: 'bar', barCategoryGap: '8%', data: [2, 3] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'area',
        dataZoom: false,
        series: [{ points: [[0, 1]] }]
      })
    ).toMatchObject({
      dataZoom: undefined,
      series: [{ type: 'line', areaStyle: { opacity: 0.14 }, data: [[0, 1]] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        title: 'Heat',
        xCategories: ['x'],
        yCategories: ['y'],
        data: [['x', 'y', 5]]
      })
    ).toMatchObject({
      title: { text: 'Heat' },
      xAxis: { type: 'category', data: ['x'] },
      yAxis: { type: 'category', data: ['y'] },
      dataZoom: undefined,
      visualMap: expect.objectContaining({ calculable: true, min: 5, max: 5 }),
      series: [{ type: 'heatmap', data: [['x', 'y', 5]] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'unsupported',
        series: []
      } as unknown as Parameters<typeof chartSpecToEChartsOptions>[0])
    ).toMatchObject({
      series: []
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'line',
        legend: true,
        series: [{ points: [[0, 1]] }]
      })
    ).toMatchObject({
      legend: { top: 8 }
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        data: [
          [0, 0, -8],
          [1, 0, -2]
        ]
      })
    ).toMatchObject({
      xAxis: { type: 'category', data: ['0', '1'] },
      yAxis: { type: 'category', data: ['0'] },
      visualMap: { min: -8, max: -2 },
      series: [
        {
          type: 'heatmap',
          data: [
            ['0', '0', -8],
            ['1', '0', -2]
          ]
        }
      ]
    });
    expect(chartSpecToEChartsOptions({ kind: 'heatmap', data: [] })).toMatchObject({
      xAxis: { type: 'category', data: [] },
      yAxis: { type: 'category', data: [] },
      visualMap: { min: 0, max: 1 },
      series: [{ type: 'heatmap', data: [] }]
    });
    expect(chartSpecToEChartsOptions({ kind: 'line', series: [] }, 'dark')).toMatchObject({
      textStyle: { color: '#f3f4f6' },
      xAxis: { axisLabel: { color: '#d1d5db' } },
      yAxis: { axisLabel: { color: '#d1d5db' } }
    });
  });

  it('normalizes explicit and inferred heatmap axes independently', () => {
    expect(
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        data: [
          [2, 'row-b', 3],
          [1, 'row-a', 4],
          ['2', 'row-b', 5]
        ]
      })
    ).toMatchObject({
      xAxis: { type: 'category', data: ['2', '1'] },
      yAxis: { type: 'category', data: ['row-b', 'row-a'] },
      visualMap: { min: 3, max: 5 },
      series: [
        {
          type: 'heatmap',
          data: [
            ['2', 'row-b', 3],
            ['1', 'row-a', 4],
            ['2', 'row-b', 5]
          ]
        }
      ]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        xCategories: ['first', 'second'],
        yCategories: ['top', 'bottom'],
        data: [[1, 0, 7]]
      })
    ).toMatchObject({
      xAxis: { data: ['first', 'second'] },
      yAxis: { data: ['top', 'bottom'] },
      series: [{ type: 'heatmap', data: [['second', 'top', 7]] }]
    });

    expect(
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        xCategories: ['first', 'second'],
        data: [
          [1, 2, 4],
          ['first', '2', 5]
        ]
      })
    ).toMatchObject({
      xAxis: { data: ['first', 'second'] },
      yAxis: { data: ['2'] },
      series: [
        {
          type: 'heatmap',
          data: [
            ['second', '2', 4],
            ['first', '2', 5]
          ]
        }
      ]
    });

    expect(() =>
      chartSpecToEChartsOptions({
        kind: 'heatmap',
        xCategories: ['only'],
        yCategories: ['row'],
        data: [[1, 0, 1]]
      })
    ).toThrow('Validated heatmap category index is out of range');
  });

  it('summarizes chart series and ranges in the selected locale', () => {
    const spec = {
      kind: 'line' as const,
      series: [
        { name: 'alpha', points: [[0, 2]] as const },
        {
          name: 'beta',
          points: [
            [1, -3],
            [2, 7]
          ] as const
        }
      ]
    };

    expect(chartDataSummary(spec, labelsForLanguage('en'))).toBe(
      'Series: 2 (alpha, beta). Data items: 3. X range: 0–2. Y range: -3–7.'
    );
    expect(chartDataSummary(spec, labelsForLanguage('ja'))).toBe(
      '系列数: 2（alpha, beta）。データ数: 3。X の範囲: 0–2。Y の範囲: -3–7。'
    );
    expect(chartDataSummary({ kind: 'bar', categories: [], series: [] }, labelsForLanguage('en'))).toBe(
      'The chart contains no data.'
    );
    expect(
      chartDataSummary(
        {
          kind: 'heatmap',
          data: [
            [-2, 10, -8],
            [4, 20, 6]
          ]
        },
        labelsForLanguage('en')
      )
    ).toBe('Series: 1. Data items: 2. X categories: 2. Y categories: 2. Heat value range: -8–6.');
    expect(
      chartDataSummary(
        {
          kind: 'heatmap',
          xCategories: ['x'],
          yCategories: ['y'],
          data: [['x', 'y', 3]]
        },
        labelsForLanguage('ja')
      )
    ).toBe('系列数: 1。データ数: 1。X カテゴリ数: 1。Y カテゴリ数: 1。ヒート値の範囲: 3。');

    const exactLimit = Array.from({ length: 100_000 }, (_, index) => [index, -index] as const);
    expect(chartDataSummary({ kind: 'line', series: [{ points: exactLimit }] }, labelsForLanguage('en'))).toContain(
      'Data items: 100000. X range: 0–99,999. Y range: -99,999–0.'
    );

    const exactHeatmapLimit = Array.from({ length: 100_000 }, (_, index) => [index, index % 2, index % 3] as const);
    expect(chartDataSummary({ kind: 'heatmap', data: exactHeatmapLimit }, labelsForLanguage('en'))).toBe(
      'Series: 1. Data items: 100000. X categories: 100000. Y categories: 2. Heat value range: 0–2.'
    );
    expect(chartDataSummary({ kind: 'heatmap', data: exactHeatmapLimit }, labelsForLanguage('ja'))).toBe(
      '系列数: 1。データ数: 100000。X カテゴリ数: 100000。Y カテゴリ数: 2。ヒート値の範囲: 0–2。'
    );
  });

  it('recreates charts with legible options when the Starlight theme changes', async () => {
    const ChartOutput = chartOutputModule.default;
    render(
      <ChartOutput
        artifact={{ kind: 'chart', spec: { kind: 'line', title: 'Theme chart', series: [] } }}
        idPrefix="theme-chart"
        labels={labelsForLanguage('en')}
      />
    );

    await waitFor(() => expect(mocks.echartsInit).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('doc-plot')).toHaveAttribute('data-chart-theme', 'light');
    expect(mocks.echartsInit.mock.calls[0]?.[1]).toMatchObject({ textStyle: { color: '#111827' } });

    document.documentElement.dataset.theme = 'dark';

    await waitFor(() => expect(mocks.echartsInit).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('doc-plot')).toHaveAttribute('data-chart-theme', 'dark');
    expect(mocks.echartsInit.mock.calls[1]?.[1]).toMatchObject({ textStyle: { color: '#f3f4f6' } });
    expect(mocks.chart.dispose).toHaveBeenCalled();
  });
});

describe('OutputRenderer', () => {
  it('renders sandboxed HTML, images, tables, and reports unsupported artifacts', () => {
    render(
      <OutputRenderer
        outputs={validateOutputArtifacts([
          { id: 'html-preview', kind: 'html', html: '<strong>safe</strong>', sandboxed: true, title: 'HTML preview' },
          { kind: 'html', html: '<em>default</em>', sandboxed: true },
          { kind: 'image', mime: 'image/png', data: pngBase64, alt: 'plot image' },
          {
            kind: 'table',
            columns: [{ key: 'name', label: 'Name', type: 'string' }],
            rows: [['Ada']]
          },
          { kind: 'unknown' }
        ])}
      />
    );

    const htmlOutputs = screen.getAllByTestId('html-output');
    expect(htmlOutputs[0]).toHaveAttribute('sandbox', '');
    expect(htmlOutputs[0]).toHaveAttribute('csp', htmlArtifactContentSecurityPolicy);
    expect(htmlOutputs[0]).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(htmlOutputs[0].getAttribute('srcdoc')).toContain('<strong>safe</strong>');
    expect(htmlOutputs[0].getAttribute('srcdoc')).toContain(htmlArtifactContentSecurityPolicy);
    expect(htmlOutputs[0]).toHaveAttribute('title', 'HTML preview');
    expect(htmlOutputs[1]).toHaveAttribute('title', 'HTML output');
    expect(screen.getByTestId('image-output')).toHaveAttribute('src', `data:image/png;base64,${pngBase64}`);
    expect(screen.getByTestId('image-output')).toHaveAttribute('alt', 'plot image');
    expect(screen.getByTestId('table-output')).toBeVisible();
    expect(screen.getAllByTestId('artifact-error')).toHaveLength(1);
    expect(screen.getByText(/Unsupported artifact kind/)).toBeVisible();
  });

  it('renders image fallback text and captions', () => {
    render(
      <OutputRenderer
        outputs={validateOutputArtifacts([
          { kind: 'image', mime: 'image/png', data: pngBase64, title: 'Figure one', caption: 'caption' },
          { kind: 'image', mime: 'image/png', data: pngBase64, caption: 'caption only' },
          { kind: 'image', mime: 'image/png', data: pngBase64 }
        ])}
      />
    );

    const images = screen.getAllByTestId('image-output');
    expect(images[0]).toHaveAttribute('alt', 'Figure one');
    expect(images[1]).toHaveAttribute('alt', 'Image output');
    expect(images[2]).toHaveAttribute('alt', 'Image output');
    expect(screen.getByText('Figure one')).toBeVisible();
    expect(screen.getByText('caption only')).toBeVisible();
  });

  it('builds data URLs for raw SVG and base64 image artifacts', () => {
    expect(
      imageArtifactSource(
        validatedImage({
          kind: 'image',
          mime: 'image/svg+xml',
          data: '<svg><text>plot</text></svg>'
        })
      )
    ).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Ctext%3Eplot%3C%2Ftext%3E%3C%2Fsvg%3E');
    expect(
      imageArtifactSource(
        validatedImage({
          kind: 'image',
          mime: 'image/jpeg',
          data: jpegBase64
        })
      )
    ).toBe(`data:image/jpeg;base64,${jpegBase64}`);
    expect(
      imageArtifactSource(
        validatedImage({
          kind: 'image',
          mime: 'image/png',
          data: `data:image/png;base64,${pngBase64}`
        })
      )
    ).toBe(`data:image/png;base64,${pngBase64}`);
  });

  it('places the restrictive HTML policy before author markup', () => {
    const srcdoc = htmlArtifactSrcdoc('<script>parent.document.body.dataset.compromised = "true"</script>');
    expect(srcdoc.indexOf('Content-Security-Policy')).toBeLessThan(srcdoc.indexOf('<script>'));
    expect(srcdoc).toContain("default-src 'none'");
    expect(srcdoc).toContain('img-src data: blob:');
    expect(srcdoc).toContain("form-action 'none'");
    expect(srcdoc).toContain('<meta name="referrer" content="no-referrer">');
  });

  it('isolates renderer failures and resets the boundary for replacement output', async () => {
    mocks.chart.setOption.mockImplementationOnce(() => {
      throw new Error('chart renderer failed');
    });
    const { rerender } = render(
      <OutputRenderer
        outputs={validateOutputArtifacts([
          { kind: 'text', stream: 'stdout', content: 'before' },
          { kind: 'chart', spec: { kind: 'line', series: [] } },
          { kind: 'text', stream: 'stdout', content: 'after' }
        ])}
      />
    );

    await waitFor(() => expect(screen.getByText(/chart renderer failed/)).toBeVisible());
    expect(screen.getByText('before')).toBeVisible();
    expect(screen.getByText('after')).toBeVisible();

    rerender(
      <OutputRenderer outputs={validateOutputArtifacts([{ kind: 'text', stream: 'stdout', content: 'replacement' }])} />
    );
    await waitFor(() => expect(screen.getByText('replacement')).toBeVisible());
    expect(screen.queryByText(/chart renderer failed/)).not.toBeInTheDocument();
  });

  it('shows truncation without hiding the validated artifact', () => {
    render(
      <OutputRenderer
        outputs={validateOutputArtifacts([
          {
            kind: 'text',
            stream: 'stdout',
            content: 'x'.repeat(1024 * 1024 + 1)
          }
        ])}
      />
    );

    expect(screen.getByTestId('run-output')).toBeVisible();
    expect(screen.getByTestId('artifact-truncated')).toHaveTextContent('Output truncated.');
  });

  it('renders a textual chart equivalent and hides the canvas surface from accessibility APIs', async () => {
    render(
      <OutputRenderer
        idPrefix="semantic-output"
        outputs={validateOutputArtifacts([
          {
            kind: 'chart',
            title: 'Response time',
            caption: 'Measured during the sample run.',
            spec: {
              kind: 'line',
              series: [
                {
                  name: 'milliseconds',
                  points: [
                    [0, 12],
                    [1, 18]
                  ]
                }
              ]
            }
          }
        ])}
      />
    );

    await waitFor(() => expect(screen.getByTestId('doc-plot')).toBeVisible());
    const figure = screen.getByRole('figure', { name: 'Response time' });
    expect(figure).toHaveAccessibleDescription(/Series: 1 \(milliseconds\)\. Data items: 2\./u);
    expect(screen.getByText('Measured during the sample run.')).toBeVisible();
    expect(screen.getByTestId('doc-plot')).toHaveAttribute('aria-hidden', 'true');
  });
});

describe('TableOutput', () => {
  it('renders table artifacts with sorting, pagination, and CSV copy', async () => {
    const writeText = vi.fn();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const rows = Array.from({ length: 12 }, (_, index) => [12 - index, `row ${index + 1}`, index % 2 === 0]);

    render(
      <TableOutput
        table={{
          kind: 'table',
          title: 'Scores',
          caption: 'Preview rows',
          columns: [
            { key: 'score', label: 'Score', type: 'integer' },
            { key: 'label', label: 'Label' },
            { key: 'enabled', label: 'Enabled', type: 'boolean' }
          ],
          rows,
          rowCount: 20,
          truncated: true
        }}
      />
    );

    expect(screen.getByTestId('table-output')).toBeVisible();
    expect(screen.getByText('Scores')).toBeVisible();
    expect(screen.getByText('Preview rows')).toBeVisible();
    expect(screen.getByText('Rows 1-10 of 20 (truncated)')).toBeVisible();
    expect(screen.getAllByRole('cell')[1]).toHaveAttribute('data-type', 'unknown');

    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(screen.getByRole('columnheader', { name: 'Score' })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getAllByRole('cell')[0]).toHaveTextContent('1');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(screen.getByRole('columnheader', { name: 'Score' })).toHaveAttribute('aria-sort', 'descending');
    expect(screen.getAllByRole('cell')[0]).toHaveTextContent('12');
    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    expect(screen.getByRole('columnheader', { name: 'Score' })).toHaveAttribute('aria-sort', 'ascending');
    expect(screen.getAllByRole('cell')[0]).toHaveTextContent('1');

    fireEvent.click(screen.getByTestId('table-next'));
    expect(screen.getByText('Rows 11-12 of 20 (truncated)')).toBeVisible();
    fireEvent.click(screen.getByTestId('table-prev'));
    expect(screen.getByText('Rows 1-10 of 20 (truncated)')).toBeVisible();

    fireEvent.input(screen.getByTestId('table-page-size'), { target: { value: '25' } });
    expect(screen.getByText('Rows 1-12 of 20 (truncated)')).toBeVisible();

    fireEvent.click(screen.getByTestId('table-copy-csv'));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('Score,Label,Enabled')));
    expect(screen.getByTestId('table-copy-status')).toHaveTextContent('Copied visible rows as CSV.');
    expect(rows[0]).toEqual([12, 'row 1', true]);
  });

  it('surfaces clipboard and CSV conversion failures', async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error('permission denied'))
      .mockRejectedValueOnce(Object.create(null));
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const { rerender } = render(
      <TableOutput
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: 'Value' }],
          rows: [['safe']]
        }}
      />
    );

    fireEvent.click(screen.getByTestId('table-copy-csv'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('permission denied'));

    fireEvent.click(screen.getByTestId('table-copy-csv'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Unable to copy CSV: Unknown error.'));

    rerender(
      <TableOutput
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: 'Value' }],
          rows: [[1, 2]]
        }}
      />
    );
    fireEvent.click(screen.getByTestId('table-copy-csv'));
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Row 1 has 2 cells; expected 1.'));

    Object.defineProperty(globalThis.navigator, 'clipboard', { configurable: true, value: undefined });
    rerender(
      <TableOutput
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: 'Value' }],
          rows: [['safe again']]
        }}
      />
    );
    fireEvent.click(screen.getByTestId('table-copy-csv'));
    expect(screen.getByRole('alert')).toHaveTextContent('Clipboard access is unavailable.');
  });

  it('keeps asynchronous copy state perceivable and preserves the copy button focus', async () => {
    let resolveCopy: () => void = () => undefined;
    const copy = new Promise<void>((resolve) => {
      resolveCopy = resolve;
    });
    const writeText = vi.fn(() => copy);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    render(
      <TableOutput
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: 'Value' }],
          rows: [['safe']]
        }}
      />
    );

    const copyButton = screen.getByTestId('table-copy-csv');
    copyButton.focus();
    fireEvent.click(copyButton);
    fireEvent.click(copyButton);

    expect(copyButton).toHaveAttribute('aria-busy', 'true');
    expect(copyButton).toHaveAttribute('aria-disabled', 'true');
    expect(copyButton).toHaveFocus();
    expect(screen.getByRole('status')).toHaveTextContent('Copying CSV…');
    expect(writeText).toHaveBeenCalledOnce();

    resolveCopy();
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Copied visible rows as CSV.'));
    expect(copyButton).toHaveFocus();
  });

  it('uses Japanese table controls, ranges, missing values, and copy feedback', async () => {
    const writeText = vi.fn();
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    render(
      <TableOutput
        labels={labelsForLanguage('ja')}
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: '値' }],
          rows: [[undefined]]
        }}
      />
    );

    expect(screen.getByRole('table', { name: 'データ表' })).toBeVisible();
    expect(screen.getByText('1 行中 1–1 行')).toBeVisible();
    expect(screen.getByText('値なし')).toBeVisible();
    expect(screen.getByLabelText('1ページあたりの行数')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '表示中の行を CSV としてコピー' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('表示中の行を CSV としてコピーしました。')
    );
  });

  it('renders empty tables with a stable row range', () => {
    render(
      <TableOutput
        table={{
          kind: 'table',
          columns: [{ key: 'value', label: 'Value' }],
          rows: []
        }}
      />
    );

    expect(screen.getByText('Rows 0-0 of 0')).toBeVisible();
    expect(screen.getByTestId('table-prev')).toBeDisabled();
    expect(screen.getByTestId('table-next')).toBeDisabled();
  });

  it('resets page, sort, and copy state at a new execution result boundary', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(globalThis.navigator, 'clipboard', {
      configurable: true,
      value: { writeText }
    });
    const firstResult = {};
    const secondResult = {};
    const rows = Array.from({ length: 30 }, (_, index) => [30 - index, `row ${index + 1}`]);
    const { rerender } = render(
      <TableOutput
        resultIdentity={firstResult}
        table={{
          kind: 'table',
          columns: [
            { key: 'score', label: 'Score' },
            { key: 'label', label: 'Label' }
          ],
          rows
        }}
      />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    fireEvent.click(screen.getByTestId('table-next'));
    fireEvent.click(screen.getByTestId('table-next'));
    fireEvent.click(screen.getByTestId('table-copy-csv'));
    await waitFor(() => expect(screen.getByTestId('table-copy-status')).toBeVisible());

    rerender(
      <TableOutput
        resultIdentity={secondResult}
        table={{
          kind: 'table',
          columns: [{ key: 'replacement', label: 'Replacement' }],
          rows: [['a'], ['b'], ['c']]
        }}
      />
    );

    expect(screen.getByText('Rows 1-3 of 3')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Replacement' })).toHaveAttribute('aria-sort', 'none');
    expect(screen.queryByTestId('table-copy-status')).not.toBeInTheDocument();
  });

  it('stores a clamped page and clears removed-column sort for an unchanged result identity', () => {
    const resultIdentity = {};
    const columns = [{ key: 'score', label: 'Score' }];
    const largeRows = Array.from({ length: 30 }, (_, index) => [index]);
    const { rerender } = render(
      <TableOutput resultIdentity={resultIdentity} table={{ kind: 'table', columns, rows: largeRows }} />
    );

    fireEvent.click(screen.getByRole('button', { name: 'Score' }));
    fireEvent.click(screen.getByTestId('table-next'));
    fireEvent.click(screen.getByTestId('table-next'));
    expect(screen.getByText('Rows 21-30 of 30')).toBeVisible();

    rerender(
      <TableOutput
        resultIdentity={resultIdentity}
        table={{ kind: 'table', columns: [{ key: 'other', label: 'Other' }], rows: [[1], [2], [3]] }}
      />
    );
    expect(screen.getByText('Rows 1-3 of 3')).toBeVisible();
    expect(screen.getByRole('columnheader', { name: 'Other' })).toHaveAttribute('aria-sort', 'none');

    rerender(
      <TableOutput
        resultIdentity={resultIdentity}
        table={{ kind: 'table', columns: [{ key: 'other', label: 'Other' }], rows: largeRows }}
      />
    );
    expect(screen.getByText('Rows 1-10 of 30')).toBeVisible();
  });

  it('sorts and formats table values without mutating rows', () => {
    const rows = [
      [2, 'b'],
      [null, 'z'],
      [1, 'a'],
      [undefined, 'y']
    ];

    expect(sortRows(rows, { columnIndex: 0, direction: 'asc' })).toEqual([
      [1, 'a'],
      [2, 'b'],
      [null, 'z'],
      [undefined, 'y']
    ]);
    expect(sortRows(rows, { columnIndex: 1, direction: 'desc' })).toEqual([
      [null, 'z'],
      [undefined, 'y'],
      [2, 'b'],
      [1, 'a']
    ]);
    expect(
      sortRows(
        [
          [1, 'first'],
          [1, 'second']
        ],
        { columnIndex: 0, direction: 'desc' }
      )
    ).toEqual([
      [1, 'first'],
      [1, 'second']
    ]);
    expect(sortRows([[true], [false]], { columnIndex: 0, direction: 'asc' })).toEqual([[false], [true]]);
    expect(visibleRows(rows, 1, 2)).toEqual([
      [1, 'a'],
      [undefined, 'y']
    ]);
    expect(rows[0]).toEqual([2, 'b']);
    expect(formatTableCell(1234.5678)).toBe('1,234.57');
    expect(formatTableCell(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatTableCell(null)).toBe('null');
    expect(formatTableCell(undefined)).toBe('missing');
    expect(() => formatTableCell({ nested: true })).toThrow('Unsupported validated table cell type');
  });

  it('copies visible table data as escaped CSV', () => {
    expect(
      tableToCsv(
        [
          { key: 'a', label: 'A' },
          { key: 'b', label: 'B' }
        ],
        [
          ['comma,value', 'quote "value"'],
          ['line\nbreak', null],
          [true, '{"nested":true}']
        ]
      )
    ).toEqual({
      ok: true,
      csv: 'A,B\n"comma,value","quote ""value"""\n"line\nbreak",\ntrue,"{""nested"":true}"'
    });
    expect(tableToCsv([{ key: 'a', label: 'A' }], [[1, 2]])).toEqual({
      ok: false,
      error: 'Row 1 has 2 cells; expected 1.'
    });
    expect(tableToCsv([{ key: 'a', label: 'A' }], [[1, 2]], labelsForLanguage('ja'))).toEqual({
      ok: false,
      error: '1 行目のセルは 2 個ですが、1 個である必要があります。'
    });
  });

  it('escapes spreadsheet formula prefixes in string headers and cells without changing negative numbers', () => {
    expect(
      tableToCsv(
        [
          { key: 'formula', label: '=Formula' },
          { key: 'number', label: 'Number' }
        ],
        [
          ['=SUM(A1:A2)', -42],
          ['  +1', '-42'],
          ['\t@command', true],
          ['\r-control', null]
        ]
      )
    ).toEqual({
      ok: true,
      csv: ["'=Formula,Number", "'=SUM(A1:A2),-42", "'  +1,'-42", "'\t@command,true", '"\'\r-control",'].join('\n')
    });
  });
});
