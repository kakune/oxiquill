import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellExecutionResult, CellManifest, InputSpec } from '../../src/lib/doc-runtime/types';

const mocks = vi.hoisted(() => {
  const chart = {
    dispose: vi.fn(),
    resize: vi.fn(),
    setOption: vi.fn()
  };

  return {
    chart,
    echartsInit: vi.fn(() => chart),
    echartsUse: vi.fn(),
    getCell: vi.fn(),
    getManifestSnapshot: vi.fn(() => ({ cells: [], version: 'v1' })),
    manifestListeners: [] as Array<() => void>,
    mermaidInitialize: vi.fn(),
    mermaidRender: vi.fn(),
    runInteractiveCell: vi.fn()
  };
});

vi.mock('echarts/charts', () => ({ LineChart: {} }));
vi.mock('echarts/components', () => ({
  DataZoomComponent: {},
  GridComponent: {},
  TooltipComponent: {}
}));
vi.mock('echarts/renderers', () => ({ CanvasRenderer: {} }));
vi.mock('echarts/core', () => ({
  init: mocks.echartsInit,
  use: mocks.echartsUse
}));
vi.mock('mermaid', () => ({
  default: {
    initialize: mocks.mermaidInitialize,
    render: mocks.mermaidRender
  }
}));
vi.mock('../../src/lib/doc-runtime/manifest', () => ({
  getCell: mocks.getCell,
  getManifestSnapshot: mocks.getManifestSnapshot,
  subscribeManifest: vi.fn((listener: () => void) => {
    mocks.manifestListeners.push(listener);
    return vi.fn();
  })
}));
vi.mock('../../src/lib/doc-runtime/runtime-client', () => ({
  runInteractiveCell: mocks.runInteractiveCell
}));

const { default: InteractiveCell } = await import('../../src/components/doc-runtime/InteractiveCell');
const { default: MermaidDiagram } = await import('../../src/components/doc-runtime/MermaidDiagram');
const { default: OutputRenderer } = await import('../../src/components/doc-runtime/OutputRenderer');
const { default: PlotOutput } = await import('../../src/components/doc-runtime/PlotOutput');

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
  mocks.manifestListeners = [];
  TestResizeObserver.instances = [];
  document.documentElement.lang = 'en';
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
});

describe('InteractiveCell', () => {
  it('renders an error for unknown cells', () => {
    mocks.getCell.mockReturnValue(undefined);

    render(<InteractiveCell cellId="missing" />);

    expect(screen.getByText('Unknown interactive cell: missing')).toBeVisible();
  });

  it('renders controls, toggles source, runs button cells, and displays all output types', async () => {
    mocks.getCell.mockReturnValue(makeCell());
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
          xAxis: { type: 'value', name: 'x' },
          yAxis: { type: 'value', name: 'y' }
        }),
        true
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
      })
    );
  });

  it('scopes input ids and radio groups per cell', () => {
    const radioOnly = inputs.filter((input) => input.name === 'style');
    mocks.getCell.mockImplementation((cellId: string) =>
      makeCell({ id: cellId, title: cellId, inputs: radioOnly })
    );

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

  it('shows running and error states', async () => {
    mocks.getCell.mockReturnValue(makeCell());
    mocks.runInteractiveCell.mockRejectedValue(new Error('failed'));

    render(<InteractiveCell cellId="cell-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    expect(screen.getByText('Running cell...')).toBeVisible();
    await waitFor(() => expect(screen.getByText('failed')).toBeVisible());
  });

  it('coerces non-Error failures to strings', async () => {
    mocks.getCell.mockReturnValue(makeCell());
    mocks.runInteractiveCell.mockRejectedValue('string failure');

    render(<InteractiveCell cellId="cell-one" />);
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));

    await waitFor(() => expect(screen.getByText('string failure')).toBeVisible());
  });

  it('runs autorun and reactive cells automatically', async () => {
    mocks.runInteractiveCell.mockResolvedValue({ stdout: 'auto', plots: [] });
    mocks.getCell.mockReturnValue(makeCell({ run: 'autorun' }));

    const { rerender } = render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('button', { name: 'Run' })).toBeVisible();

    mocks.getCell.mockReturnValue(makeCell({ id: 'cell-two', run: 'reactive' }));
    rerender(<InteractiveCell cellId="cell-two" />);
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(2));

    fireEvent.input(screen.getByRole('slider', { name: 'ratio' }), { target: { value: '3' } });
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalledTimes(3));
  });

  it('ignores stale async results from superseded reactive runs', async () => {
    const pending: Array<ReturnType<typeof createDeferredResult>> = [];
    mocks.runInteractiveCell.mockImplementation(() => {
      const deferred = createDeferredResult();
      pending.push(deferred);
      return deferred.promise;
    });
    mocks.getCell.mockReturnValue(makeCell({
      run: 'reactive',
      inputs: [inputs.find((input) => input.name === 'label') as InputSpec]
    }));

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.input(screen.getByLabelText('label'), { target: { value: 'newer input' } });
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[1].resolve({ stdout: 'newer result', stderr: '', value: null, plots: [], outputs: [] });
      await pending[1].promise;
    });
    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('newer result'));

    await act(async () => {
      pending[0].resolve({ stdout: 'older result', stderr: '', value: null, plots: [], outputs: [] });
      await pending[0].promise;
    });

    expect(screen.getByTestId('run-output')).toHaveTextContent('newer result');
  });

  it('ignores stale async errors from superseded reactive runs', async () => {
    const pending: Array<ReturnType<typeof createDeferredResult>> = [];
    mocks.runInteractiveCell.mockImplementation(() => {
      const deferred = createDeferredResult();
      pending.push(deferred);
      return deferred.promise;
    });
    mocks.getCell.mockReturnValue(makeCell({
      run: 'reactive',
      inputs: [inputs.find((input) => input.name === 'label') as InputSpec]
    }));

    render(<InteractiveCell cellId="cell-one" />);
    await waitFor(() => expect(pending).toHaveLength(1));

    fireEvent.input(screen.getByLabelText('label'), { target: { value: 'newer input' } });
    await waitFor(() => expect(pending).toHaveLength(2));

    await act(async () => {
      pending[1].resolve({ stdout: 'newer result', stderr: '', value: null, plots: [], outputs: [] });
      await pending[1].promise;
    });
    await waitFor(() => expect(screen.getByTestId('run-output')).toHaveTextContent('newer result'));

    await act(async () => {
      pending[0].reject(new Error('older failure'));
      await pending[0].promise.catch(() => undefined);
    });

    expect(screen.queryByText('older failure')).not.toBeInTheDocument();
    expect(screen.getByTestId('run-output')).toHaveTextContent('newer result');
  });

  it('supports cells without inputs and hidden source', () => {
    mocks.getCell.mockReturnValue(makeCell({ inputs: [], showSource: false, run: 'hidden' }));

    render(<InteractiveCell cellId="cell-one" />);

    expect(screen.queryByText('println!("ok");')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run' })).not.toBeInTheDocument();
  });

  it('uses Japanese runtime labels when the document language is Japanese', () => {
    document.documentElement.lang = 'ja';
    mocks.getCell.mockReturnValue(makeCell());

    render(<InteractiveCell cellId="cell-one" />);

    expect(screen.getByRole('button', { name: 'コードを隠す' })).toBeVisible();
    expect(screen.getByRole('button', { name: '実行' })).toBeVisible();
  });

  it('renders Python labeling and empty successful results', async () => {
    mocks.getCell.mockReturnValue(makeCell({ language: 'python', inputs: [] }));
    mocks.runInteractiveCell.mockResolvedValue({ stdout: '', stderr: '', value: '', plots: [] });

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByText('Python + Pyodide')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(mocks.runInteractiveCell).toHaveBeenCalled());
    expect(screen.queryByTestId('run-output')).not.toBeInTheDocument();
    expect(screen.queryByTestId('value-output')).not.toBeInTheDocument();
  });

  it('refreshes rendered cell data when the generated manifest version changes', async () => {
    mocks.getCell
      .mockReturnValueOnce(makeCell({ sourceHtml: '<pre class="shiki"><code>println!("old");</code></pre>' }))
      .mockReturnValue(makeCell({ sourceHtml: '<pre class="shiki"><code>println!("new");</code></pre>' }));
    mocks.getManifestSnapshot
      .mockReturnValueOnce({ cells: [], version: 'v1' })
      .mockReturnValue({ cells: [], version: 'v2' });

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByText('println!("old");')).toBeVisible();

    act(() => {
      mocks.manifestListeners[0]();
    });

    await waitFor(() => expect(screen.getByText('println!("new");')).toBeVisible());
  });
});

describe('MermaidDiagram', () => {
  it('renders Mermaid SVG and initializes Mermaid only once', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg role="img"><text>diagram</text></svg>',
      bindFunctions: vi.fn()
    });

    const { rerender } = render(<MermaidDiagram diagramId="one" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByText('diagram')).toBeVisible();
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);

    rerender(<MermaidDiagram diagramId="one" source="flowchart LR\nA-->C" />);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
  });

  it('renders Mermaid SVG when no bind function is returned', async () => {
    mocks.mermaidRender.mockResolvedValue({
      svg: '<svg><text>plain diagram</text></svg>'
    });

    render(<MermaidDiagram diagramId="plain" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(screen.getByText('plain diagram')).toBeVisible());
  });

  it('renders Mermaid errors from Error and non-Error values', async () => {
    mocks.mermaidRender.mockRejectedValueOnce(new Error('bad diagram')).mockRejectedValueOnce('string diagram error');

    const { rerender } = render(<MermaidDiagram diagramId="bad" source="bad" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('bad diagram'));

    rerender(<MermaidDiagram diagramId="bad" source="still bad" />);
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('string diagram error'));
  });

  it('ignores resolved or rejected Mermaid renders after unmount', async () => {
    let resolveRender: (value: { svg: string }) => void = () => undefined;
    mocks.mermaidRender.mockReturnValue(
      new Promise((resolve) => {
        resolveRender = resolve;
      })
    );

    const { unmount } = render(<MermaidDiagram diagramId="late" source="flowchart LR\nA-->B" />);
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
    lateError.unmount();
    rejectRender(new Error('late error'));
    await Promise.resolve();

    expect(screen.queryByText('late')).not.toBeInTheDocument();
    expect(screen.queryByText('late error')).not.toBeInTheDocument();
  });
});

describe('PlotOutput', () => {
  it('initializes, updates, and disposes an ECharts line plot', () => {
    const { unmount } = render(
      <PlotOutput plot={{ kind: 'line', x_label: 'n', y_label: 'x', points: [[0, 0.2]] }} />
    );

    expect(mocks.echartsInit).toHaveBeenCalled();
    TestResizeObserver.instances[0].callback(
      [],
      TestResizeObserver.instances[0] as unknown as ResizeObserver
    );
    expect(mocks.chart.resize).toHaveBeenCalled();
    expect(mocks.chart.setOption).toHaveBeenCalledWith(
      expect.objectContaining({
        color: ['#0f766e'],
        series: [expect.objectContaining({ type: 'line', data: [[0, 0.2]] })]
      }),
      true
    );

    unmount();
    expect(mocks.chart.dispose).toHaveBeenCalled();
  });
});

describe('OutputRenderer', () => {
  it('renders sandboxed HTML and reports unsupported artifacts', () => {
    render(
      <OutputRenderer
        outputs={[
          { kind: 'html', html: '<strong>safe</strong>', sandboxed: true, title: 'HTML preview' },
          { kind: 'table', columns: [{ key: 'x', label: 'x' }], rows: [[1]] },
          { kind: 'unknown' }
        ]}
      />
    );

    expect(screen.getByTestId('html-output')).toHaveAttribute('sandbox', '');
    expect(screen.getByTestId('html-output')).toHaveAttribute('srcdoc', '<strong>safe</strong>');
    expect(screen.getByTestId('html-output')).toHaveAttribute('title', 'HTML preview');
    expect(screen.getAllByTestId('artifact-error')).toHaveLength(2);
    expect(screen.getByText('Unsupported table output artifact.')).toBeVisible();
    expect(screen.getByText('Unsupported output artifact.')).toBeVisible();
  });
});
