import { describe, expect, it } from 'vitest';
import {
  createPythonCellResult,
  createSerialRequestQueue,
  pythonDisplaySupportCode,
  resolvePyodideUrls
} from '../../packages/oxiquill/src/lib/doc-runtime/python-worker';
import { toOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/python-cell-result';

function createDeferred() {
  let reject!: (reason: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('python worker request queue', () => {
  it('processes queued requests one at a time', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    expect(events).toEqual(['start:first']);

    first.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
  });

  it('continues draining after a request rejects', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    first.reject(new Error('failed'));
    await first.promise.catch(() => undefined);
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second', 'finish:second']);
  });
});

describe('python worker asset URLs', () => {
  it('resolves Pyodide files under the configured site base', () => {
    expect(resolvePyodideUrls('/')).toEqual({
      indexUrl: '/oxiquill/pyodide/',
      moduleUrl: '/oxiquill/pyodide/pyodide.mjs'
    });
    expect(resolvePyodideUrls('/oxiquill/')).toEqual({
      indexUrl: '/oxiquill/oxiquill/pyodide/',
      moduleUrl: '/oxiquill/oxiquill/pyodide/pyodide.mjs'
    });
    expect(resolvePyodideUrls('/oxiquill')).toEqual({
      indexUrl: '/oxiquill/oxiquill/pyodide/',
      moduleUrl: '/oxiquill/oxiquill/pyodide/pyodide.mjs'
    });
    expect(resolvePyodideUrls('/notes', 'runtime%20assets/python/')).toEqual({
      indexUrl: '/notes/runtime%20assets/python/',
      moduleUrl: '/notes/runtime%20assets/python/pyodide.mjs'
    });
  });
});

describe('python rich display support', () => {
  it('exposes display helpers in the injected support module', () => {
    expect(pythonDisplaySupportCode).toContain('builtins.display = display');
    expect(pythonDisplaySupportCode).toContain('def display_table');
    expect(pythonDisplaySupportCode).toContain('_repr_html_');
    expect(pythonDisplaySupportCode).toContain('_repr_png_');
  });

  it('configures matplotlib and captures figures as image artifacts', () => {
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_collect_matplotlib_outputs');
    expect(pythonDisplaySupportCode).toContain('matplotlib.use("Agg", force=True)');
    expect(pythonDisplaySupportCode).toContain('fig.savefig(buffer, format="svg"');
    expect(pythonDisplaySupportCode).toContain('plt.close("all")');
    expect(pythonDisplaySupportCode).toContain('__oxiquill_displayed_figures.add(id(fig))');
  });

  it('converts pandas dataframes and series to table artifacts', () => {
    expect(pythonDisplaySupportCode).toContain('__oxiquill_table_limit = 10000');
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_is_pandas_dataframe');
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_is_pandas_series');
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_pandas_dataframe_artifact');
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_pandas_series_artifact');
    expect(pythonDisplaySupportCode).toContain('module == "pandas" or module.startswith("pandas.")');
    expect(pythonDisplaySupportCode).toContain('"rowCount": row_count');
    expect(pythonDisplaySupportCode).toContain('"truncated": truncated_rows or truncated_columns');
    expect(pythonDisplaySupportCode).toContain('Failed to convert dataframe output');
  });

  it('supports standard Python rich MIME repr methods', () => {
    expect(pythonDisplaySupportCode).toContain('def __oxiquill_mimebundle_artifact');
    expect(pythonDisplaySupportCode).toContain('_repr_mimebundle_');
    expect(pythonDisplaySupportCode).toContain('_repr_json_');
    expect(pythonDisplaySupportCode).toContain('_repr_markdown_');
    expect(pythonDisplaySupportCode).toContain('text/html');
    expect(pythonDisplaySupportCode).toContain('sandboxed": True');
    expect(pythonDisplaySupportCode).toContain('application/vnd.vegalite.');
    expect(pythonDisplaySupportCode).toContain('Unsupported MIME bundle');
  });

  it('combines stream output, rich display artifacts, and final values deterministically', () => {
    expect(
      createPythonCellResult({
        stdout: 'printed',
        stderr: 'warned',
        value: { ok: true },
        plots: [],
        displayOutputs: [
          { kind: 'html', html: '<strong>display</strong>', sandboxed: true },
          { kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' },
          { kind: 'text', stream: 'display', content: 'fallback' }
        ]
      })
    ).toEqual({
      stdout: 'printed',
      stderr: 'warned',
      value: { ok: true },
      plots: [],
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'printed' },
        { kind: 'text', stream: 'stderr', content: 'warned' },
        { kind: 'html', html: '<strong>display</strong>', sandboxed: true },
        { kind: 'image', mime: 'image/svg+xml', data: '<svg />', alt: 'plot' },
        { kind: 'text', stream: 'display', content: 'fallback' },
        { kind: 'json', value: { ok: true } }
      ]
    });
  });

  it('preserves Python display values for validation at the runtime boundary', () => {
    const artifact = { kind: 'text' as const, stream: 'display' as const, content: 'ok' };

    expect(toOutputArtifacts([artifact, { kind: 'unknown' }, null])).toEqual([artifact, { kind: 'unknown' }, null]);
    expect(toOutputArtifacts({ kind: 'text', stream: 'display', content: 'ok' })).toEqual([]);
  });
});
