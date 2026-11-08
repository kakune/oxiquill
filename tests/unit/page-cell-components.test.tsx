import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/preact';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CellManifest, PageCellManifest } from '../../packages/oxiquill/src/lib/doc-runtime/types';
import { normalizeCellExecutionResult } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifacts';
import { applyGeneratedSnapshot } from '../../packages/oxiquill/src/lib/doc-runtime/manifest';
import InteractiveCell, { PageCellData } from '../../packages/oxiquill/src/components/doc-runtime/InteractiveCell';

const mocks = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock('../../packages/oxiquill/src/lib/doc-runtime/runtime-client', () => ({
  runInteractiveCell: mocks.run,
  updateRustRuntimeRegistry: vi.fn(),
  resetInteractiveRuntime: vi.fn(),
  getPythonPreparationState: () => 'idle',
  subscribePythonPreparation: () => () => undefined
}));
const base: CellManifest = {
  id: 'producer',
  pagePath: 'data.mdx',
  language: 'rust',
  title: 'Producer',
  run: 'button',
  source: 'producer source',
  sourceHtml: '<pre>producer source</pre>',
  inputs: [{ name: 'seed', type: 'integer', label: 'Seed', value: 1, options: [], share: true }],
  crates: [],
  packages: [],
  showSource: true,
  editable: false,
  timeoutMs: 1000,
  exports: ['value'],
  cache: 'inputs',
  producerFingerprint: 'producer-code'
};
const consumer: CellManifest = {
  ...base,
  id: 'consumer',
  title: 'Consumer',
  source: 'consumer source',
  sourceHtml: '<pre>consumer source</pre>',
  inputs: [],
  exports: undefined,
  cache: undefined,
  dependsOn: { data: { cell: 'producer' } }
};
const page: PageCellManifest = {
  cells: [base, consumer],
  rust: {
    version: 1,
    modules: [
      {
        id: 'rust',
        fingerprint: 'module',
        glue: { url: '/glue' },
        wasm: { url: '/wasm', integrity: 'sha256-x', bytes: 1 },
        cells: ['producer', 'consumer']
      }
    ]
  }
};
const producerCalls = () => mocks.run.mock.calls.filter(([cell]) => cell.id === 'producer');
function mount(showProducer = false) {
  return render(
    <>
      <PageCellData page={page} />
      {showProducer ? <InteractiveCell cell={base} cellId={base.id} /> : null}
      <InteractiveCell cell={consumer} cellId={consumer.id} />
    </>
  );
}
beforeEach(() => {
  document.documentElement.lang = 'en';
  history.replaceState({}, '', '/');
  mocks.run
    .mockReset()
    .mockImplementation(async (cell, inputs, _v, _signal, _phase, _override, _module, dependencies) =>
      normalizeCellExecutionResult({
        outputs: [
          {
            kind: 'text',
            stream: 'stdout',
            content: cell.id === 'producer' ? `Seed ${inputs.seed}` : `Consumed ${dependencies.data.value}`
          }
        ],
        ...(cell.exports ? { exports: { value: Number(inputs.seed) + 776 } } : {})
      })
    );
  applyGeneratedSnapshot({ ...page, version: 'component-version' });
});
afterEach(() => {
  cleanup();
  globalThis.dispatchEvent(new Event('pagehide'));
  document.documentElement.lang = 'en';
  history.replaceState({}, '', '/');
});

describe('page cell controls', () => {
  it('computes an unhydrated producer and shows its existing result when it hydrates', async () => {
    mount();
    fireEvent.click(within(screen.getByTestId('cell-consumer')).getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    render(<InteractiveCell cell={base} cellId={base.id} />);
    await screen.findByText('Seed 1');
    expect(producerCalls()).toHaveLength(1);
    const producer = screen.getByTestId('cell-producer');
    expect(producer.querySelector('.doc-cell__outputs')).not.toHaveTextContent('777');
    expect(producer.querySelector('.doc-cell__outputs')).not.toHaveTextContent('value');
  });
  it('keeps independent cell inputs and results in the same page store', async () => {
    const independent = { ...base, id: 'independent', title: 'Independent', exports: undefined, cache: undefined };
    const expanded = { ...page, cells: [...page.cells, independent] };
    applyGeneratedSnapshot({ ...expanded, version: 'expanded' });
    mocks.run.mockImplementation(async (_cell, inputs) =>
      normalizeCellExecutionResult({
        outputs: [{ kind: 'text', stream: 'stdout', content: `Independent ${inputs.seed}` }]
      })
    );
    render(
      <>
        <PageCellData page={expanded} />
        <InteractiveCell cell={independent} cellId={independent.id} />
      </>
    );
    fireEvent.input(screen.getByRole('spinbutton', { name: 'Seed' }), { target: { value: '9' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Independent 9');
    const { getPageCellStore } = await import('../../packages/oxiquill/src/lib/doc-runtime/page-cell-store');
    expect(getPageCellStore(independent).get('independent')).toMatchObject({ values: { seed: 9 }, status: 'success' });
  });
  it('indicates reuse and forces a fresh result with Recompute', async () => {
    mount(true);
    const run = within(screen.getByTestId('cell-consumer')).getByRole('button', { name: 'Run', exact: true });
    fireEvent.click(run);
    await screen.findByText('Consumed 777');
    fireEvent.click(run);
    await screen.findByText('Reused result for these inputs');
    expect(producerCalls()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Recompute' }));
    await waitFor(() => expect(producerCalls()).toHaveLength(2));
    await waitFor(() => expect(screen.queryByText('Reused result for these inputs')).not.toBeInTheDocument());
    expect(screen.getByText('Upstream changed')).toBeInTheDocument();
  });
  it('links consumers to the failed producer diagnostic', async () => {
    mocks.run.mockRejectedValue(new Error('Generate failed: missing export value'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    const link = await screen.findByRole('link', { name: 'Upstream cell "Producer" failed' });
    expect(link).toHaveAttribute('href', '#doc-cell-producer-title');
    expect(screen.getByRole('alert')).toHaveTextContent('missing export value');
  });
  it('restores shared producer inputs before hydration and on history navigation', async () => {
    const url = (seed: number) =>
      `/?oxiquill-inputs=${encodeURIComponent(JSON.stringify({ v: 2, cells: { producer: { values: { seed } } } }))}`;
    history.replaceState({}, '', url(9));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 785');
    render(<InteractiveCell cell={base} cellId={base.id} />);
    history.pushState({}, '', url(3));
    globalThis.dispatchEvent(new PopStateEvent('popstate'));
    await screen.findByText('Seed 3');
    expect(screen.getByRole('spinbutton', { name: 'Seed' })).toHaveValue('3');
  });
  it('clears cached state on navigation', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    cleanup();
    document.dispatchEvent(new Event('astro:before-swap'));
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    expect(producerCalls()).toHaveLength(2);
  });
  it('reinitializes page state after a browser back-forward cache restoration', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    globalThis.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true }));
    globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await waitFor(() => expect(screen.queryByText('Consumed 777')).not.toBeInTheDocument());
    fireEvent.click(screen.getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    expect(producerCalls()).toHaveLength(2);
  });
  it('shares only current inputs and cases, never exports', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount(true);
    fireEvent.click(within(screen.getByTestId('cell-consumer')).getByRole('button', { name: 'Run', exact: true }));
    await screen.findByText('Consumed 777');
    fireEvent.click(screen.getByRole('button', { name: 'Copy input link' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledOnce());
    const shared = writeText.mock.calls[0][0] as string;
    expect(shared).not.toContain('777');
    expect(shared).not.toContain('exports');
    expect(shared).not.toContain('value');
  });
  it('localizes cache actions and escapes the page descriptor', async () => {
    document.documentElement.lang = 'ja';
    mount(true);
    expect(await screen.findByRole('button', { name: '再計算' })).toBeInTheDocument();
    const escaped = { ...page, cells: [{ ...base, source: '</script><img src=x>' }] };
    const { container } = render(<PageCellData page={escaped} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')?.textContent).toContain('\\u003c/script>');
  });
});
