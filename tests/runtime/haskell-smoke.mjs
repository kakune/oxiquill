import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHaskellOutputCapture } from '../../packages/oxiquill/dist/lib/doc-runtime/haskell-output.js';
import { validateOutputArtifacts } from '../../packages/oxiquill/dist/lib/doc-runtime/output-artifact-validation.js';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import {
  executeGeneratedHaskellCell,
  testGeneratedHaskellCells
} from '../../packages/oxiquill/dist/generator/doc-runtime/haskell-runtime-test.mjs';
import { listFiles } from '../../packages/oxiquill/dist/generator/doc-runtime/file-system.mjs';
import { buildHaskellWasm, HASKELL_WASM_FILE } from '../../packages/oxiquill/dist/generator/doc-runtime/wasm-build.mjs';

const workspaceRoot = fileURLToPath(new URL('../../examples/docs-site/', import.meta.url));
const result = await testGeneratedHaskellCells({
  paths: createOxiquillPaths({ workspaceRoot }),
  executeCell: async (options) => {
    const result = await executeGeneratedHaskellCell(options);
    const capture = createHaskellOutputCapture();
    capture.writeStdout(Buffer.from(result.stdout));
    capture.writeStderr(Buffer.from(result.stderr));
    const { outputs } = capture.take();
    assert.deepEqual(
      validateOutputArtifacts(outputs).filter((artifact) => artifact.status === 'error'),
      []
    );
    if (options.cell.id.endsWith('__haskell-scene3d')) {
      assert.equal(outputs[0].kind, 'scene3d');
      assert.deepEqual(
        outputs[0].points.map((point) => point.id),
        ['a', 'b']
      );
      assert.deepEqual(outputs[0].edges, [{ from: 'a', to: 'b' }]);
    }
    if (options.cell.id.endsWith('__satisfied-outcome')) {
      assert.deepEqual(
        outputs.map((output) => output.kind),
        ['table', 'outcome']
      );
      assert.deepEqual(outputs[0].columns[0].format, { fractionDigits: 2, unit: 's' });
      assert.equal(outputs[0].columns[0].nullText, 'Not measured');
      assert.equal(outputs[1].state, 'satisfied');
      assert.deepEqual(outputs[1].diagnostics, [{ name: 'residual', value: 0.00001 }]);
    }
    if (options.cell.id.endsWith('__haskell-mixed-xy')) {
      assert.deepEqual(outputs[0].spec, { kind: 'xy', layers: [{ id: 'samples', kind: 'scatter', points: [[0, 1]] }] });
    }
    if (options.cell.id.endsWith('__haskell-grid-field')) {
      assert.equal(outputs.length, 1);
      assert.deepEqual(outputs[0].spec, { kind: 'field', xEdges: [-2, 0, 3], yEdges: [-1, 1], values: [[2, null]] });
    }
    if (options.cell.id.endsWith('__haskell-structured-output')) {
      assert.deepEqual(
        outputs.map((output) => output.kind),
        ['text', 'json', 'table', 'chart', 'text']
      );
      assert.deepEqual(outputs[1].value, {
        message: 'Unicode: \u65e5\u672c \ud83c\udf0d\nquoted: "value"',
        ready: true
      });
      assert.deepEqual(outputs[2].rows, [
        [1, 1],
        [2, 4],
        [3, 9],
        [4, 16]
      ]);
    }
  }
});

console.log(`Generated Haskell/WASI all-cell test passed (${result.cellCount} cells).`);

// Call-stack source locations must not embed the generator's random staging path.
const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'oxiquill-haskell-determinism-'));
try {
  const outputs = [];
  for (const directory of ['first staging root', 'second staging root']) {
    const paths = createOxiquillPaths({ workspaceRoot: path.join(temporaryRoot, directory) });
    await mkdir(paths.haskellCellsDir, { recursive: true });
    await writeFile(
      path.join(paths.haskellCellsDir, 'Main.hs'),
      [
        'module Main where',
        'import GHC.Stack (HasCallStack, callStack, prettyCallStack)',
        'location :: HasCallStack => IO ()',
        'location = putStrLn (prettyCallStack callStack)',
        'main :: IO ()',
        'main = location',
        ''
      ].join('\n')
    );
    await buildHaskellWasm({ mode: 'build', paths });
    outputs.push(await readFile(path.join(paths.haskellWasmPublicDir, HASKELL_WASM_FILE)));
    if (directory === 'first staging root') {
      const mainFile = path.join(paths.haskellCellsDir, 'Main.hs');
      await mkdir(path.join(paths.haskellCellsDir, 'Oxiquill'), { recursive: true });
      await writeFile(
        path.join(paths.haskellCellsDir, 'Oxiquill/Helper.hs'),
        'module Oxiquill.Helper where\nmessage :: String\nmessage = "cached"\n'
      );
      await writeFile(mainFile, 'module Main where\nimport Oxiquill.Helper\nmain :: IO ()\nmain = putStrLn message\n');
      await buildHaskellWasm({ mode: 'build', paths });
      const objects = (await listFiles(paths.haskellBuildCacheDir)).filter((file) =>
        file.endsWith(`${path.sep}Helper.o`)
      );
      assert.equal(objects.length, 1);
      const before = (await stat(objects[0])).mtimeMs;
      await writeFile(
        mainFile,
        'module Main where\nimport Oxiquill.Helper\nmain :: IO ()\nmain = putStrLn (message ++ " edited")\n'
      );
      await buildHaskellWasm({ mode: 'build', paths });
      assert.equal((await stat(objects[0])).mtimeMs, before, 'unchanged Haskell module objects must be reused');
      console.log('Haskell/WASI incremental module reuse passed.');
    }
  }
  assert.deepEqual(outputs[0], outputs[1], 'Haskell Wasm must be identical across staging directories');
  console.log('Haskell/WASI builds are byte-identical across staging directories.');
} finally {
  await rm(temporaryRoot, { force: true, recursive: true });
}
