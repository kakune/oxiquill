import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellExecutionResult, CellManifest, InputSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import {
  chart,
  echartsInit,
  echartsUse,
  mermaidInitialize,
  mermaidRender
} from './mocks/external-runtime';

const runtimeMocks = vi.hoisted(() => ({
    getCell: vi.fn(),
    getManifestSnapshot: vi.fn(() => ({ cells: [], version: 'v1' })),
    manifestListeners: [] as Array<() => void>,
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
  subscribeManifest: vi.fn((listener: () => void) => {
    runtimeMocks.manifestListeners.push(listener);
    return vi.fn();
  })
}));
vi.mock('../../packages/oxiquill/src/lib/doc-runtime/runtime-client', () => ({
  runInteractiveCell: runtimeMocks.runInteractiveCell
}));

const { default: InteractiveCell } = await import('../../packages/oxiquill/src/components/doc-runtime/InteractiveCell');
const {
  default: MermaidDiagram,
  getMermaidColorScheme
} = await import('../../packages/oxiquill/src/components/doc-runtime/MermaidDiagram');
const { default: OutputRenderer, imageArtifactSource } = await import('../../packages/oxiquill/src/components/doc-runtime/OutputRenderer');
const { default: PlotOutput } = await import('../../packages/oxiquill/src/components/doc-runtime/PlotOutput');
const { chartSpecToEChartsOptions } = await import('../../packages/oxiquill/src/components/doc-runtime/ChartOutput');
const {
  default: TableOutput,
  formatTableCell,
  sortRows,
  tableToCsv,
  visibleRows
} = await import('../../packages/oxiquill/src/components/doc-runtime/TableOutput');

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
  runtimeMocks.manifestListeners = [];
  mocks.manifestListeners = runtimeMocks.manifestListeners;
  TestResizeObserver.instances = [];
  document.documentElement.lang = 'en';
  document.documentElement.removeAttribute('data-theme');
  globalThis.ResizeObserver = TestResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
          xAxis: expect.objectContaining({ type: 'value', name: 'x' }),
          yAxis: expect.objectContaining({ type: 'value', name: 'y' })
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

  it('refreshes rendered cell data when the generated manifest changes without a runtime rebuild', async () => {
    mocks.getCell
      .mockReturnValueOnce(makeCell({ sourceHtml: '<pre class="shiki"><code>println!("old");</code></pre>' }))
      .mockReturnValue(makeCell({ sourceHtml: '<pre class="shiki"><code>println!("new");</code></pre>' }));
    mocks.getManifestSnapshot
      .mockReturnValueOnce({ cells: [], version: 'v1' })
      .mockReturnValue({ cells: [], version: 'v1' });

    render(<InteractiveCell cellId="cell-one" />);
    expect(screen.getByText('println!("old");')).toBeVisible();

    act(() => {
      mocks.manifestListeners[0]();
    });

    await waitFor(() => expect(screen.getByText('println!("new");')).toBeVisible());
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

    const { rerender } = render(<MermaidDiagram diagramId="one" source="flowchart LR\nA-->B" />);

    await waitFor(() => expect(screen.getByTestId('mermaid-diagram')).toHaveAttribute('data-state', 'ready'));
    expect(screen.getByText('diagram')).toBeVisible();
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
    expect(mocks.mermaidInitialize).toHaveBeenCalledWith(
      expect.objectContaining({
        themeVariables: expect.objectContaining({
          lineColor: '#0f766e',
          primaryTextColor: '#111827'
        })
      })
    );

    rerender(<MermaidDiagram diagramId="one" source="flowchart LR\nA-->C" />);
    await waitFor(() => expect(mocks.mermaidRender).toHaveBeenCalledTimes(2));
    expect(mocks.mermaidInitialize).toHaveBeenCalledTimes(1);
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
        color: expect.arrayContaining(['#0f766e']),
        series: [expect.objectContaining({ type: 'line', data: [[0, 0.2]] })]
      }),
      true
    );

    unmount();
    expect(mocks.chart.dispose).toHaveBeenCalled();
  });
});

describe('ChartOutput options', () => {
  it('maps supported chart specs to ECharts options', () => {
    expect(chartSpecToEChartsOptions({
      kind: 'line',
      xLabel: 'n',
      yLabel: 'x',
      series: [{ name: 'a', points: [[0, 1]] }, { name: 'b', points: [[0, 2]] }]
    })).toMatchObject({
      legend: { top: 4 },
      tooltip: { trigger: 'axis' },
      xAxis: { type: 'value', name: 'n' },
      yAxis: { type: 'value', name: 'x' },
      series: [
        { type: 'line', showSymbol: false, data: [[0, 1]] },
        { type: 'line', showSymbol: false, data: [[0, 2]] }
      ]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'scatter',
      tooltip: true,
      series: [{ points: [[0, 1]] }]
    })).toMatchObject({
      tooltip: { trigger: 'item' },
      series: [{ type: 'scatter', symbolSize: 6, data: [[0, 1]] }]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'scatter',
      legend: false,
      tooltip: false,
      series: [{ name: 'hidden', points: [[0, 1]] }]
    })).toMatchObject({
      legend: undefined,
      tooltip: undefined
    });

    expect(chartSpecToEChartsOptions({
      kind: 'bar',
      categories: ['A', 'B'],
      series: [{ values: [1, null] }]
    })).toMatchObject({
      xAxis: { type: 'category', data: ['A', 'B'] },
      series: [{ type: 'bar', data: [1, null] }]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'histogram',
      bins: [[0, 1, 2], [1, 2, 3]]
    })).toMatchObject({
      xAxis: { type: 'category', data: ['0-1', '1-2'] },
      series: [{ type: 'bar', barCategoryGap: '8%', data: [2, 3] }]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'area',
      dataZoom: false,
      series: [{ points: [[0, 1]] }]
    })).toMatchObject({
      dataZoom: undefined,
      series: [{ type: 'line', areaStyle: { opacity: 0.18 }, data: [[0, 1]] }]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'heatmap',
      title: 'Heat',
      xCategories: ['x'],
      yCategories: ['y'],
      data: [['x', 'y', 5]]
    })).toMatchObject({
      title: { text: 'Heat' },
      xAxis: { type: 'category', data: ['x'] },
      yAxis: { type: 'category', data: ['y'] },
      dataZoom: undefined,
      visualMap: expect.objectContaining({ calculable: true }),
      series: [{ type: 'heatmap', data: [['x', 'y', 5]] }]
    });

    expect(chartSpecToEChartsOptions({
      kind: 'unsupported',
      series: []
    } as unknown as Parameters<typeof chartSpecToEChartsOptions>[0])).toMatchObject({
      series: []
    });

    expect(chartSpecToEChartsOptions({
      kind: 'line',
      legend: true,
      series: [{ points: [[0, 1]] }]
    })).toMatchObject({
      legend: { top: 4 }
    });
  });
});

describe('OutputRenderer', () => {
  it('renders sandboxed HTML, images, tables, and reports unsupported artifacts', () => {
    render(
      <OutputRenderer
        outputs={[
          { id: 'html-preview', kind: 'html', html: '<strong>safe</strong>', sandboxed: true, title: 'HTML preview' },
          { kind: 'html', html: '<em>default</em>', sandboxed: true },
          { kind: 'image', mime: 'image/png', data: 'abc', alt: 'plot image' },
          {
            kind: 'table',
            columns: [{ key: 'name', label: 'Name', type: 'string' }],
            rows: [['Ada']]
          },
          { kind: 'unknown' }
        ]}
      />
    );

    const htmlOutputs = screen.getAllByTestId('html-output');
    expect(htmlOutputs[0]).toHaveAttribute('sandbox', '');
    expect(htmlOutputs[0]).toHaveAttribute('srcdoc', '<strong>safe</strong>');
    expect(htmlOutputs[0]).toHaveAttribute('title', 'HTML preview');
    expect(htmlOutputs[1]).toHaveAttribute('title', 'HTML output');
    expect(screen.getByTestId('image-output')).toHaveAttribute('src', 'data:image/png;base64,abc');
    expect(screen.getByTestId('image-output')).toHaveAttribute('alt', 'plot image');
    expect(screen.getByTestId('table-output')).toBeVisible();
    expect(screen.getAllByTestId('artifact-error')).toHaveLength(1);
    expect(screen.getByText('Unsupported output artifact.')).toBeVisible();
  });

  it('renders image fallback text and captions', () => {
    render(
      <OutputRenderer
        outputs={[
          { kind: 'image', mime: 'image/png', data: 'abc', title: 'Figure one', caption: 'caption' },
          { kind: 'image', mime: 'image/png', data: 'def', caption: 'caption only' },
          { kind: 'image', mime: 'image/png', data: 'ghi' }
        ]}
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
    expect(imageArtifactSource({
      kind: 'image',
      mime: 'image/svg+xml',
      data: '<svg><text>plot</text></svg>'
    })).toBe('data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Ctext%3Eplot%3C%2Ftext%3E%3C%2Fsvg%3E');
    expect(imageArtifactSource({
      kind: 'image',
      mime: 'image/jpeg',
      data: 'abc'
    })).toBe('data:image/jpeg;base64,abc');
    expect(imageArtifactSource({
      kind: 'image',
      mime: 'image/png',
      data: 'data:image/png;base64,existing'
    })).toBe('data:image/png;base64,existing');
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
    expect(rows[0]).toEqual([12, 'row 1', true]);
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

  it('sorts and formats table values without mutating rows', () => {
    const rows = [[2, 'b'], [null, 'z'], [1, 'a'], [undefined, 'y']];

    expect(sortRows(rows, { columnIndex: 0, direction: 'asc' })).toEqual([[1, 'a'], [2, 'b'], [null, 'z'], [undefined, 'y']]);
    expect(sortRows(rows, { columnIndex: 1, direction: 'desc' })).toEqual([[null, 'z'], [undefined, 'y'], [2, 'b'], [1, 'a']]);
    expect(sortRows([[1, 'first'], [1, 'second']], { columnIndex: 0, direction: 'desc' })).toEqual([[1, 'first'], [1, 'second']]);
    expect(sortRows([[true], [false]], { columnIndex: 0, direction: 'asc' })).toEqual([[false], [true]]);
    expect(visibleRows(rows, 1, 2)).toEqual([[1, 'a'], [undefined, 'y']]);
    expect(rows[0]).toEqual([2, 'b']);
    expect(formatTableCell(1234.5678)).toBe('1,234.57');
    expect(formatTableCell(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(formatTableCell(null)).toBe('null');
    expect(formatTableCell(undefined)).toBe('missing');
    expect(formatTableCell({ nested: true })).toBe('{"nested":true}');
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
          [true, { nested: true }]
        ]
      )
    ).toBe('A,B\n"comma,value","quote ""value"""\n"line\nbreak",\ntrue,"{""nested"":true}"');
  });
});
