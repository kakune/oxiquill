import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { createHaskellOutputCapture } from '../../packages/oxiquill/dist/lib/doc-runtime/haskell-output.js';
import { validateOutputArtifacts } from '../../packages/oxiquill/dist/lib/doc-runtime/output-artifact-validation.js';
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
    const capture = createHaskellOutputCapture();
    capture.writeStdout(Buffer.from(result.stdout));
    capture.writeStderr(Buffer.from(result.stderr));
    const { outputs } = capture.take();
    assert.deepEqual(
      validateOutputArtifacts(outputs).filter((artifact) => artifact.status === 'error'),
      []
    );
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
