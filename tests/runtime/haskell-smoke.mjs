import { fileURLToPath } from 'node:url';
import { createOxiquillPaths } from '../../packages/oxiquill/dist/config/paths.mjs';
import { testGeneratedHaskellCells } from '../../packages/oxiquill/dist/generator/doc-runtime/haskell-runtime-test.mjs';

const workspaceRoot = fileURLToPath(new URL('../../examples/docs-site/', import.meta.url));
const result = await testGeneratedHaskellCells({ paths: createOxiquillPaths({ workspaceRoot }) });

console.log(`Generated Haskell/WASI all-cell test passed (${result.cellCount} cells).`);
