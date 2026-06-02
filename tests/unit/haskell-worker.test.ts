import { describe, expect, it } from 'vitest';
import {
  assertReadyHaskellRuntimeStatus,
  createHaskellCellResult,
  fetchHaskellRuntimeStatus,
  parseHaskellRuntimeStatus,
  resolveHaskellRuntimeStatusUrl,
  resolveHaskellWasmUrl
} from '../../packages/oxiquill/src/lib/doc-runtime/haskell-worker';

describe('haskell worker helpers', () => {
  it('resolves generated Haskell Wasm under the configured site base', () => {
    expect(resolveHaskellWasmUrl('/')).toBe('/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes/')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellRuntimeStatusUrl('/notes')).toBe('/notes/oxiquill/haskell-wasm/status.json');
  });

  it('maps captured stdout and stderr to text artifacts', () => {
    expect(createHaskellCellResult({
      stdout: 'value = 42',
      stderr: 'warning'
    })).toEqual({
      stdout: 'value = 42',
      stderr: 'warning',
      plots: [],
      outputs: [
        { kind: 'text', stream: 'stdout', content: 'value = 42' },
        { kind: 'text', stream: 'stderr', content: 'warning' }
      ]
    });
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
      assertReadyHaskellRuntimeStatus({
        status: 'unavailable',
        haskellFingerprintHash: 'hash-one',
        message: 'install wasm32-wasi-ghc and rerun pnpm wasm:dev.'
      }, 'hash-one')
    ).toThrow(
      'Haskell WASI runtime is not available: install wasm32-wasi-ghc and rerun pnpm wasm:dev.'
    );
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

    const missing = async () => ({
      ok: false,
      json: async () => ({})
    }) as Response;
    await expect(fetchHaskellRuntimeStatus('/missing.json', missing as typeof fetch)).rejects.toThrow(
      'Haskell WASI runtime is not available: generated runtime status is missing; rerun pnpm wasm:dev.'
    );
  });
});
