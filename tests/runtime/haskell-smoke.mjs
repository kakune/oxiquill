import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import {
  executeGeneratedHaskellCell,
  testGeneratedHaskellCells
} from '../../packages/oxiquill/dist/generator/doc-runtime/haskell-runtime-test.mjs';

const workspaceRoot = fileURLToPath(new URL('../../examples/docs-site/', import.meta.url));
const result = await testGeneratedHaskellCells({
  paths: createOxiquillPaths({ workspaceRoot }),
  executeCell: async (options) => {
    const result = await executeGeneratedHaskellCell(options);
    if (options.cell.id.endsWith('__haskell-structured-output')) {
      assert.deepEqual(
        result.outputs.map((output) => output.kind),
        ['text', 'json', 'table', 'chart', 'text']
      );
      assert.deepEqual(result.outputs[1].value, {
        message: 'Unicode: \u65e5\u672c \ud83c\udf0d\nquoted: "value"',
        ready: true
      });
      assert.deepEqual(result.outputs[2].rows, [
        [1, 1],
        [2, 4],
        [3, 9],
        [4, 16]
      ]);
    }
  }
});

console.log(`Generated Haskell/WASI all-cell test passed (${result.cellCount} cells).`);
