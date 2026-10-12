// @vitest-environment node

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { hashText } from '../../packages/oxiquill/src/generator/doc-runtime/hashing.mjs';
import {
  executeGeneratedHaskellCell,
  testGeneratedHaskellCells
} from '../../packages/oxiquill/src/generator/doc-runtime/haskell-runtime-test.mjs';

const paths = {
  cellsJsonPath: '/repo/.oxiquill/generated/cells.json',
  haskellWasmPublicDir: '/repo/public/oxiquill/haskell-wasm'
};
const statusPath = path.join(paths.haskellWasmPublicDir, 'status.json');
const wasmPath = path.join(paths.haskellWasmPublicDir, 'doc_haskell_cells.wasm');

describe('generated Haskell runtime tests', () => {
  it('compiles once and executes every Haskell manifest cell with defaults', async () => {
    const cells = [
      cell('first', [input('scale', 3), input('label', 'sample')]),
      { ...cell('python', []), language: 'python' },
      cell('second', [input('enabled', true)])
    ];
    const expectedFingerprint = 'haskell fingerprint';
    const fileSystem = memoryFileSystem({
      [paths.cellsJsonPath]: JSON.stringify(cells),
      [statusPath]: JSON.stringify({
        haskellFingerprintHash: hashText(expectedFingerprint),
        message: '',
        status: 'ready'
      }),
      [wasmPath]: Buffer.from('wasm')
    });
    const module = {};
    const compile = vi.fn(async () => module);
    const executed = [];
    const executeCell = vi.fn(async ({ cell: manifestCell, module: compiledModule }) => {
      executed.push([manifestCell.id, manifestCell.inputs.map(({ value }) => value), compiledModule]);
    });

    await expect(
      testGeneratedHaskellCells({ compile, executeCell, expectedFingerprint, fileSystem, paths })
    ).resolves.toEqual({ cellCount: 2 });
    expect(compile).toHaveBeenCalledOnce();
    expect(executed).toEqual([
      ['first', [3, 'sample'], module],
      ['second', [true], module]
    ]);
  });

  it('identifies a failing cell and rejects stale or unavailable runtime state', async () => {
    const expectedFingerprint = 'current';
    const readyFiles = {
      [paths.cellsJsonPath]: JSON.stringify([cell('first', []), cell('failing-cell', [])]),
      [statusPath]: JSON.stringify({
        haskellFingerprintHash: hashText(expectedFingerprint),
        message: '',
        status: 'ready'
      }),
      [wasmPath]: Buffer.from('wasm')
    };
    await expect(
      testGeneratedHaskellCells({
        compile: async () => ({}),
        executeCell: async ({ cell: manifestCell }) => {
          if (manifestCell.id === 'failing-cell') throw new Error('exit 1');
        },
        expectedFingerprint,
        fileSystem: memoryFileSystem(readyFiles),
        paths
      })
    ).rejects.toThrow('Generated Haskell cell "failing-cell" failed with default inputs: exit 1');

    await expect(
      testGeneratedHaskellCells({
        expectedFingerprint: 'different',
        fileSystem: memoryFileSystem(readyFiles),
        paths
      })
    ).rejects.toThrow('Generated Haskell runtime is stale');

    await expect(
      testGeneratedHaskellCells({
        fileSystem: memoryFileSystem({
          ...readyFiles,
          [statusPath]: JSON.stringify({
            haskellFingerprintHash: hashText(expectedFingerprint),
            message: 'compiler unavailable',
            status: 'unavailable'
          })
        }),
        paths
      })
    ).rejects.toThrow('compiler unavailable');
  });

  it('passes scalar default inputs to a fresh WASI instance and reports nonzero exits', async () => {
    const module = {};
    const instance = {};
    const instantiate = vi.fn(async () => instance);
    const invocations = [];
    const createWasi = vi.fn(({ args, stdout }) => {
      invocations.push(args);
      stdout(Buffer.from('standard output'));
      return {
        start: (receivedInstance) => {
          expect(receivedInstance).toBe(instance);
          return 0;
        },
        wasiImport: { fixture: true }
      };
    });

    await expect(
      executeGeneratedHaskellCell({
        cell: cell('defaults', [input('number', 2.5), input('enabled', false), input('label', 'hello')]),
        createWasi,
        instantiate,
        module
      })
    ).resolves.toEqual({ stderr: '', stdout: 'standard output' });
    expect(invocations).toEqual([['doc_haskell_cells', 'defaults', '2.5', 'false', 'hello']]);
    expect(instantiate).toHaveBeenCalledWith(module, { wasi_snapshot_preview1: { fixture: true } });

    await expect(
      executeGeneratedHaskellCell({
        cell: cell('failure', []),
        createWasi: ({ stderr }) => {
          stderr(Buffer.from('runtime failure'));
          return { start: () => 1, wasiImport: {} };
        },
        instantiate: async () => ({}),
        module
      })
    ).rejects.toThrow('runtime failure');
  });
});

function cell(id, inputs) {
  return { id, inputs, language: 'haskell' };
}

function input(name, value) {
  return { name, value };
}

function memoryFileSystem(files) {
  return {
    readFile: async (filePath, encoding) => {
      if (!Object.hasOwn(files, filePath)) {
        const error = new Error(`missing ${filePath}`);
        error.code = 'ENOENT';
        throw error;
      }
      const content = Buffer.isBuffer(files[filePath]) ? files[filePath] : Buffer.from(files[filePath]);
      return encoding ? content.toString(encoding) : content;
    }
  };
}
