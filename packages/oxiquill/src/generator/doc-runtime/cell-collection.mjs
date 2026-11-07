import { createRuntimeEvents } from './runtime-events.mjs';
import { resolveRustDefinitions, isDefinitionsBlock } from '../../lib/doc-runtime/rust-definitions.mjs';
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

export async function collectAuthoringContent({
  fileSystem = defaultFileSystem,
  helperCrates,
  paths,
  events = createRuntimeEvents(),
  pythonOptions = {}
}) {
  const parsedPages = await events.phase('discovery', {}, async () => {
    const files = await listFiles(paths.docsDir, { fileSystem });
    return Promise.all(
      files
        .filter((file) => file.endsWith('.mdx') || file.endsWith('.md'))
        .map(async (file) => {
          const parsed = parseCellsFromMarkdown(
            await fileSystem.readFile(file, 'utf8'),
            normalizePath(path.relative(pathFromUrl(paths.workspaceRoot), file)),
            pythonOptions
          );
          return {
            ...parsed,
            page: { ...parsed.page, entryPath: normalizePath(path.relative(pathFromUrl(paths.docsDir), file)) }
          };
        })
    );
  });
  return events.phase('validation', {}, async () => {
    const cells = parsedPages.flatMap((page) => page.cells);
    throwInteractiveCellDiagnostics([
      ...parsedPages.flatMap((page) => page.diagnostics),
      ...(helperCrates ? cells.flatMap((cell) => validateCellDependencies(cell, helperCrates)) : [])
    ]);
    assertUniqueCellIds(cells);
    const haskell = cells.filter((cell) => cell.language === 'haskell');
    const rust = cells.filter((cell) => cell.language === 'rust' && !isDefinitionsBlock(cell));
    assertUniqueHaskellFunctionNames(haskell);
    assertUniqueHaskellInputBindings(haskell);
    assertUniqueRustFunctionNames(rust);
    assertUniqueRustInputBindings(rust);
    return { cells: resolveRustDefinitions(resolvePythonSetups(cells)), pages: parsedPages.map(({ page }) => page) };
  });
}

export async function collectAuthoringCells(options) {
  return (await collectAuthoringContent(options)).cells;
}
