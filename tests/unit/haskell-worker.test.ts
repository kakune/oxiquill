import { describe, expect, it, vi } from 'vitest';
import {
  assertReadyHaskellRuntimeStatus,
  createHaskellCellResult,
  createHaskellModuleLoader,
  createHaskellWorkerRequestHandler,
  createOutputCapture,
  fetchHaskellModule,
  fetchHaskellRuntimeStatus,
  parseHaskellRuntimeStatus,
  resolveHaskellRuntimeStatusUrl,
  resolveHaskellWasmUrl
} from '../../packages/oxiquill/src/lib/doc-runtime/haskell-worker';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from '../../packages/oxiquill/src/lib/doc-runtime/types';

describe('haskell worker helpers', () => {
  it('resolves generated Haskell Wasm under the configured site base', () => {
    expect(resolveHaskellWasmUrl('/')).toBe('/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes/')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellRuntimeStatusUrl('/notes')).toBe('/notes/oxiquill/haskell-wasm/status.json');
    expect(resolveHaskellWasmUrl('/notes', 'runtime%20assets/haskell/')).toBe(
      '/notes/runtime%20assets/haskell/doc_haskell_cells.wasm'
    );
  });

  it('maps captured stdout and stderr to text artifacts', () => {
    expect(
      createHaskellCellResult({
        stdout: 'value = 42',
        stderr: 'warning'
      })
    ).toEqual({
      stdout: 'value = 42',
      stderr: 'warning',
      plots: [],
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'value = 42' },
        { kind: 'text', stream: 'stderr', content: 'warning' }
      ]
    });
  });

  it('handles successful requests and reports runtime failures', async () => {
    const module = {} as WebAssembly.Module;
    const request: RuntimeWorkerRequest = {
      requestId: 4,
      cellId: 'haskell-cell',
      haskellFingerprintHash: 'hash-one',
      inputArgs: ['sample'],
      inputs: {}
    };
    const responses: RuntimeWorkerResponse[] = [];
    const runCell = vi.fn(async () => createHaskellCellResult({ stdout: 'sample: ok', stderr: '' }));
    const handleRequest = createHaskellWorkerRequestHandler({
      loadModule: vi.fn(async () => module),
      postMessage: (response) => responses.push(response),
      runCell
    });

    await handleRequest(request);
    expect(runCell).toHaveBeenCalledWith(module, request);
    expect(responses).toEqual([
      {
        requestId: 4,
        ok: true,
        result: {
          stdout: 'sample: ok',
          plots: [],
          outputs: [{ kind: 'text', stream: 'stdout', content: 'sample: ok' }]
        }
      }
    ]);

    const failureResponses: RuntimeWorkerResponse[] = [];
    const failingHandler = createHaskellWorkerRequestHandler({
      loadModule: async () => {
        throw 'runtime unavailable';
      },
      postMessage: (response) => failureResponses.push(response)
    });
    await failingHandler(request);
    expect(failureResponses).toEqual([{ requestId: 4, ok: false, error: 'runtime unavailable' }]);
  });

  it('caches modules by expected fingerprint and rejects stale status before loading wasm', async () => {
    const module = {} as WebAssembly.Module;
    const fetchStatus = vi.fn(async () => ({
      status: 'ready' as const,
      haskellFingerprintHash: 'hash-one',
      message: ''
    }));
    const fetchModule = vi.fn(async () => module);
    const loadModule = createHaskellModuleLoader({
      fetchModule,
      fetchStatus,
      statusUrl: '/status.json',
      wasmUrl: '/runtime.wasm'
    });

    await expect(loadModule('hash-one')).resolves.toBe(module);
    await expect(loadModule('hash-one')).resolves.toBe(module);
    expect(fetchStatus).toHaveBeenCalledOnce();
    expect(fetchModule).toHaveBeenCalledOnce();
    await expect(loadModule('hash-two')).rejects.toThrow('generated runtime is stale');
    expect(fetchStatus).toHaveBeenCalledTimes(2);
    expect(fetchModule).toHaveBeenCalledOnce();
  });

  it('bounds WASI bytes while callbacks run and flushes a split UTF-8 sequence safely', () => {
    const exact = createOutputCapture(6);
    exact.file.fd_write(new TextEncoder().encode('日本'));
    expect(exact.take()).toEqual({ value: '日本', truncated: false });

    const oversized = createOutputCapture(6);
    oversized.file.fd_write(new TextEncoder().encode('日本語'));
    expect(oversized.take()).toEqual({ value: '日本', truncated: true });

    const splitSequence = createOutputCapture(4);
    splitSequence.file.fd_write(new TextEncoder().encode('日本'));
    expect(splitSequence.take()).toEqual({ value: '…', truncated: true });
  });

  it('marks bounded Haskell stream artifacts as truncated', () => {
    expect(
      createHaskellCellResult({
        stdout: 'bounded stdout',
        stdoutTruncated: true,
        stderr: 'bounded stderr',
        stderrTruncated: true
      }).outputs
    ).toEqual([
      { kind: 'text', stream: 'stdout', content: 'bounded stdout', truncated: true },
      { kind: 'text', stream: 'stderr', content: 'bounded stderr', truncated: true }
    ]);
  });

  it('parses and validates generated Haskell runtime status', () => {
    const ready = parseHaskellRuntimeStatus({
      status: 'ready',
      haskellFingerprintHash: 'hash-one',
      message: ''
    });

    expect(() => assertReadyHaskellRuntimeStatus(ready, 'hash-one')).not.toThrow();
    expect(() => assertReadyHaskellRuntimeStatus(ready, 'hash-two')).toThrow(
      'Haskell WASI runtime is not available: generated runtime is stale; rerun pnpm wasm:dev.'
    );
    expect(() =>
      assertReadyHaskellRuntimeStatus(
        {
          status: 'unavailable',
          haskellFingerprintHash: 'hash-one',
          message: 'install wasm32-wasi-ghc and rerun pnpm wasm:dev.'
        },
        'hash-one'
      )
    ).toThrow('Haskell WASI runtime is not available: install wasm32-wasi-ghc and rerun pnpm wasm:dev.');
    expect(() => parseHaskellRuntimeStatus({ status: 'ready' })).toThrow(
      'Haskell WASI runtime is not available: generated runtime status is invalid.'
    );
  });

  it('fetches Haskell runtime status with no-store caching and clear missing-status errors', async () => {
    const requests: Array<[string, RequestInit | undefined]> = [];
    const fetchImpl = async (url: string, init?: RequestInit) => {
      requests.push([url, init]);
      return {
        ok: true,
        json: async () => ({
          status: 'ready',
          haskellFingerprintHash: 'hash-one',
          message: ''
        })
      } as Response;
    };

    await expect(fetchHaskellRuntimeStatus('/status.json', fetchImpl as typeof fetch)).resolves.toMatchObject({
      status: 'ready',
      haskellFingerprintHash: 'hash-one'
    });
    expect(requests).toEqual([['/status.json', { cache: 'no-store' }]]);

    const missing = async () =>
      ({
        ok: false,
        json: async () => ({})
      }) as Response;
    await expect(fetchHaskellRuntimeStatus('/missing.json', missing as typeof fetch)).rejects.toThrow(
      'Haskell WASI runtime is not available: generated runtime status is missing; rerun pnpm wasm:dev.'
    );

    const malformed = async () => ({ ok: true, json: async () => null }) as Response;
    await expect(fetchHaskellRuntimeStatus('/malformed.json', malformed as typeof fetch)).rejects.toThrow(
      'generated runtime status is invalid'
    );
  });

  it('reports missing Haskell wasm responses', async () => {
    const missing = async () => ({ ok: false, status: 404, statusText: 'Not Found' }) as Response;
    await expect(fetchHaskellModule('/missing.wasm', missing as typeof fetch)).rejects.toThrow(
      'Failed to load /missing.wasm: 404 Not Found'
    );
  });

  it('uses a cloned wasm response when streaming compile falls back', async () => {
    const cloneBuffer = new ArrayBuffer(8);
    const module = {} as WebAssembly.Module;
    const cloned = {
      arrayBuffer: vi.fn(async () => cloneBuffer)
    };
    const response = {
      ok: true,
      status: 200,
      statusText: 'OK',
      arrayBuffer: vi.fn(async () => {
        throw new Error('original response body was consumed');
      }),
      clone: vi.fn(() => cloned)
    };
    const compileStreaming = vi
      .spyOn(WebAssembly, 'compileStreaming')
      .mockRejectedValue(new TypeError('unsupported content type'));
    const compile = vi.spyOn(WebAssembly, 'compile').mockResolvedValue(module);

    try {
      await expect(
        fetchHaskellModule('/doc_haskell_cells.wasm', (async () => response as unknown as Response) as typeof fetch)
      ).resolves.toBe(module);

      const [[streamingInput]] = compileStreaming.mock.calls;
      await expect(streamingInput).resolves.toBe(response);
      expect(response.clone).toHaveBeenCalledTimes(1);
      expect(response.arrayBuffer).not.toHaveBeenCalled();
      expect(cloned.arrayBuffer).toHaveBeenCalledTimes(1);
      expect(compile).toHaveBeenCalledWith(cloneBuffer);
    } finally {
      vi.restoreAllMocks();
    }
  });
});
