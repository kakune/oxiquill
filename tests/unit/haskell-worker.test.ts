import { describe, expect, it } from 'vitest';
import {
  createHaskellCellResult,
  resolveHaskellWasmUrl
} from '../../packages/oxiquill/src/lib/doc-runtime/haskell-worker';

describe('haskell worker helpers', () => {
  it('resolves generated Haskell Wasm under the configured site base', () => {
    expect(resolveHaskellWasmUrl('/')).toBe('/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes/')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
    expect(resolveHaskellWasmUrl('/notes')).toBe('/notes/oxiquill/haskell-wasm/doc_haskell_cells.wasm');
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
});
