import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { parseCellsFromMarkdown } from './cell-parser.mjs';
import { defaultFileSystem, listFiles } from './file-system.mjs';
import { normalizePath } from './path-utils.mjs';
import {
  resolvePythonSetups,
  throwInteractiveCellDiagnostics,
  validateCellDependencies
} from '../../lib/doc-runtime/cell-authoring.mjs';
import {
  assertUniqueCellIds,
  assertUniqueHaskellFunctionNames,
  assertUniqueHaskellInputBindings,
  assertUniqueRustFunctionNames,
  assertUniqueRustInputBindings
} from './validators.mjs';

export async function collectAuthoringCells({
  fileSystem = defaultFileSystem,
  helperCrates,
  paths,
  pythonOptions = {}
}) {
  const files = await listFiles(paths.docsDir, { fileSystem });
  const parsedPages = await Promise.all(
    files
      .filter((file) => file.endsWith('.mdx') || file.endsWith('.md'))
      .map(async (file) =>
        parseCellsFromMarkdown(
          await fileSystem.readFile(file, 'utf8'),
          normalizePath(path.relative(pathFromUrl(paths.workspaceRoot), file)),
          pythonOptions
        )
      )
  );
  const cells = parsedPages.flatMap((page) => page.cells);
  throwInteractiveCellDiagnostics([
    ...parsedPages.flatMap((page) => page.diagnostics),
    ...(helperCrates ? cells.flatMap((cell) => validateCellDependencies(cell, helperCrates)) : [])
  ]);
  assertUniqueCellIds(cells);
  const haskell = cells.filter((cell) => cell.language === 'haskell');
  const rust = cells.filter((cell) => cell.language === 'rust');
  assertUniqueHaskellFunctionNames(haskell);
  assertUniqueHaskellInputBindings(haskell);
  assertUniqueRustFunctionNames(rust);
  assertUniqueRustInputBindings(rust);
  return resolvePythonSetups(cells);
}
