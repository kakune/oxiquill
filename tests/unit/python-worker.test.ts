import { describe, expect, it, vi } from 'vitest';
import {
  createPythonCellResult,
  createPythonRuntimeLoader,
  createPythonWorkerRequestHandler,
  createSerialRequestQueue,
  importPyodideModule,
  pythonIntegerConversionCode,
  pythonDisplaySupportCode,
  resolvePyodideUrls
} from '../../packages/oxiquill/src/lib/doc-runtime/python-worker';
import { toOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/python-cell-result';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from '../../packages/oxiquill/src/lib/doc-runtime/types';

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

describe('python input conversion', () => {
  it('converts validated integer bindings to Python ints without interpolating arbitrary names', () => {
    expect(pythonIntegerConversionCode('negative_offset')).toBe('negative_offset = int(negative_offset)');
    expect(() => pythonIntegerConversionCode('value; import os')).toThrow('Invalid integer input name');
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

  it('loads and initializes Pyodide once for repeated requests', async () => {
    const pyodide = { runPythonAsync: vi.fn(async () => undefined) };
    const loadPyodide = vi.fn(async () => pyodide);
    const importModule = vi.fn(async () => ({ loadPyodide: loadPyodide as never }));
    const loadRuntime = createPythonRuntimeLoader({
      importModule,
      indexUrl: '/runtime/',
      moduleUrl: '/runtime/pyodide.mjs'
    });

    await expect(loadRuntime()).resolves.toBe(pyodide);
    await expect(loadRuntime()).resolves.toBe(pyodide);
    expect(importModule).toHaveBeenCalledOnce();
    expect(importModule).toHaveBeenCalledWith('/runtime/pyodide.mjs');
    expect(loadPyodide).toHaveBeenCalledOnce();
    expect(loadPyodide).toHaveBeenCalledWith({ indexURL: '/runtime/' });
    expect(pyodide.runPythonAsync).toHaveBeenCalledOnce();
    expect(pyodide.runPythonAsync).toHaveBeenCalledWith(pythonDisplaySupportCode);
  });

  it('loads blob modules, reports HTTP failures, and always revokes temporary URLs', async () => {
    const unavailable = vi.fn(async () => ({ ok: false, status: 503, statusText: 'Unavailable' }) as Response);
    await expect(importPyodideModule('/runtime/pyodide.mjs', { fetchImplementation: unavailable })).rejects.toThrow(
      'Failed to load /runtime/pyodide.mjs: 503 Unavailable'
    );

    const revokeObjectUrl = vi.fn();
    const importModule = vi.fn(async () => {
      throw new Error('invalid module');
    });
    await expect(
      importPyodideModule('/runtime/pyodide.mjs', {
        createObjectUrl: () => 'blob:pyodide',
        fetchImplementation: vi.fn(
          async () => ({ ok: true, text: async () => 'export const loadPyodide = true;' }) as Response
        ),
        importModule,
        revokeObjectUrl
      })
    ).rejects.toThrow('invalid module');
    expect(importModule).toHaveBeenCalledWith('blob:pyodide');
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:pyodide');
  });
});

describe('python worker request handling', () => {
  it('loads packages, evaluates source, destroys proxies, and posts normalized output', async () => {
    const globals = { destroy: vi.fn() };
    const valueProxy = pythonProxy({ answer: 42 });
    const displayProxy = pythonProxy([{ kind: 'text', stream: 'display', content: 'displayed' }]);
    const matplotlibProxy = pythonProxy([{ kind: 'image', mime: 'image/svg+xml', data: '<svg />' }]);
    const pyodide = {
      loadPackage: vi.fn(async () => undefined),
      loadPackagesFromImports: vi.fn(async () => undefined),
      runPython: vi.fn((source: string) => {
        if (source === '__oxiquill_take_outputs()') return displayProxy;
        if (source === '__oxiquill_collect_matplotlib_outputs()') return matplotlibProxy;
        return undefined;
      }),
      runPythonAsync: vi.fn(async () => valueProxy),
      setStderr: vi.fn(({ batched }: { batched: (output: string) => void }) => batched('warning')),
      setStdout: vi.fn(({ batched }: { batched: (output: string) => void }) => batched('printed')),
      toPy: vi.fn(() => globals)
    };
    const responses: RuntimeWorkerResponse[] = [];
    const handleRequest = createPythonWorkerRequestHandler({
      ensurePyodide: async () => pyodide as never,
      postMessage: (response) => responses.push(response)
    });
    const request = pythonRequest();

    await handleRequest(request);

    expect(pyodide.loadPackage).toHaveBeenCalledWith(['numpy']);
    expect(pyodide.loadPackagesFromImports).toHaveBeenCalledWith(request.source);
    expect(pyodide.toPy).toHaveBeenCalledWith(request.inputs);
    expect(globals.destroy).toHaveBeenCalledOnce();
    expect(valueProxy.destroy).toHaveBeenCalledOnce();
    expect(displayProxy.destroy).toHaveBeenCalledOnce();
    expect(matplotlibProxy.destroy).toHaveBeenCalledOnce();
    expect(responses).toEqual([
      {
        requestId: 7,
        ok: true,
        result: {
          stdout: 'printed',
          stderr: 'warning',
          value: { answer: 42 },
          plots: [],
          outputs: [
            { kind: 'text', stream: 'stdout', content: 'printed' },
            { kind: 'text', stream: 'stderr', content: 'warning' },
            { kind: 'text', stream: 'display', content: 'displayed' },
            { kind: 'image', mime: 'image/svg+xml', data: '<svg />' },
            { kind: 'json', value: { answer: 42 } }
          ]
        }
      }
    ]);
  });

  it('posts startup and evaluation failures and still destroys Python globals', async () => {
    const startupResponses: RuntimeWorkerResponse[] = [];
    const startupHandler = createPythonWorkerRequestHandler({
      ensurePyodide: async () => {
        throw new Error('Pyodide startup failed');
      },
      postMessage: (response) => startupResponses.push(response)
    });
    await startupHandler(pythonRequest());
    expect(startupResponses).toEqual([{ requestId: 7, ok: false, error: 'Pyodide startup failed' }]);

    const globals = { destroy: vi.fn() };
    const evaluationResponses: RuntimeWorkerResponse[] = [];
    const evaluationHandler = createPythonWorkerRequestHandler({
      ensurePyodide: async () =>
        ({
          loadPackage: vi.fn(),
          loadPackagesFromImports: vi.fn(),
          runPython: vi.fn(),
          runPythonAsync: vi.fn(async () => {
            throw 'evaluation failed';
          }),
          setStderr: vi.fn(),
          setStdout: vi.fn(),
          toPy: () => globals
        }) as never,
      postMessage: (response) => evaluationResponses.push(response)
    });
    await evaluationHandler(pythonRequest({ packages: [] }));
    expect(globals.destroy).toHaveBeenCalledOnce();
    expect(evaluationResponses).toEqual([{ requestId: 7, ok: false, error: 'evaluation failed' }]);
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

function pythonRequest(overrides: Partial<RuntimeWorkerRequest> = {}): RuntimeWorkerRequest {
  return {
    requestId: 7,
    cellId: 'python-cell',
    inputs: { scale: 2 },
    packages: ['numpy'],
    source: 'print("ok")',
    ...overrides
  };
}

function pythonProxy(value: unknown) {
  return {
    destroy: vi.fn(),
    toJs: vi.fn(() => value)
  };
}
