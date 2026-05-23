import path from 'node:path';
import { createHighlighter } from 'shiki';
import {
  assertUniqueCellIds,
  assertUniqueRustInputBindings,
  extractCellsFromMarkdown,
  generateCellsJson,
  generateCellsModule,
  generateRustCargoToml,
  generateRustLib,
  sourceThemes
} from './doc-runtime-core.mjs';
import {
  copyFileIfChanged,
  defaultFileSystem,
  listFiles,
  writeIfChanged
} from './doc-runtime/file-system.mjs';
import {
  listHelperCrates,
  readHelperManifests
} from './doc-runtime/helper-crate-service.mjs';
import {
  hashBytes,
  hashText,
  stableFingerprint
} from './doc-runtime/hashing.mjs';
import { normalizePath } from './doc-runtime/path-utils.mjs';
import {
  copyPyodideAssets,
  copyVendoredPyodidePackages,
  resolveVendoredPyodidePackages
} from './doc-runtime/pyodide-assets.mjs';
import {
  createRuntimeVersion,
  generateRuntimeVersionModule,
  shouldBuildWasm,
  summarizeCells
} from './doc-runtime/runtime-summary.mjs';
import { buildRustWasm } from './doc-runtime/wasm-build.mjs';

export {
  copyFileIfChanged,
  listFiles,
  writeIfChanged
} from './doc-runtime/file-system.mjs';
export {
  listHelperCrates,
  readHelperManifests
} from './doc-runtime/helper-crate-service.mjs';
export {
  hashBytes,
  hashText,
  stableFingerprint
} from './doc-runtime/hashing.mjs';
export {
  copyPyodideAssets,
  copyVendoredPyodidePackages,
  resolveVendoredPyodidePackages
} from './doc-runtime/pyodide-assets.mjs';
export {
  createRuntimeVersion,
  generateRuntimeVersionModule,
  shouldBuildWasm,
  summarizeCells
} from './doc-runtime/runtime-summary.mjs';
export { buildRustWasm } from './doc-runtime/wasm-build.mjs';

export function createDocRuntimePaths(root) {
  const generatedDir = path.join(root, 'src/generated/doc-runtime');

  return {
    docsDir: path.join(root, 'src/content/docs'),
    generatedDir,
    pyodidePublicDir: path.join(root, 'public/pyodide'),
    rustCrateDir: path.join(generatedDir, 'rust-cells'),
    runtimeVersionPath: path.join(generatedDir, 'runtime-version.ts')
  };
}

export async function createDocRuntimeContext({
  fileSystem = defaultFileSystem,
  highlighter,
  readManifests,
  root
} = {}) {
  const paths = createDocRuntimePaths(root);
  return {
    highlighter:
      highlighter ??
      (await createHighlighter({
        langs: ['rust', 'python'],
        themes: Object.values(sourceThemes)
      })),
    paths,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests, root })
  };
}

export async function syncDocRuntime({
  fileSystem = defaultFileSystem,
  highlighter,
  helperCrates,
  paths,
  root
}) {
  const cells = await collectCells({
    fileSystem,
    helperCrates,
    highlighter,
    paths,
    root
  });
  const rustCells = cells.filter((cell) => cell.language === 'rust');

  assertUniqueCellIds(cells);
  assertUniqueRustInputBindings(rustCells);

  const writes = await Promise.all([
    writeIfChanged(path.join(paths.generatedDir, 'cells.ts'), generateCellsModule(cells), { fileSystem }),
    writeIfChanged(path.join(paths.generatedDir, 'cells.json'), generateCellsJson(cells), { fileSystem }),
    writeIfChanged(path.join(paths.rustCrateDir, 'Cargo.toml'), generateRustCargoToml(rustCells, helperCrates), {
      fileSystem
    }),
    writeIfChanged(path.join(paths.rustCrateDir, 'src/lib.rs'), generateRustLib(rustCells), { fileSystem })
  ]);
  const pyodideChanged = await copyPyodideAssets({ fileSystem, paths, root });
  const summary = summarizeCells(cells);

  return {
    ...summary,
    cellsChanged: writes[0] || writes[1],
    pyodideChanged,
    rustChanged: writes[2] || writes[3]
  };
}

export async function collectCells({ fileSystem = defaultFileSystem, helperCrates, highlighter, paths, root }) {
  const files = await listFiles(paths.docsDir, { fileSystem });
  const markdownFiles = files.filter((filePath) => filePath.endsWith('.mdx') || filePath.endsWith('.md'));
  const nestedCells = await Promise.all(
    markdownFiles.map(async (filePath) => {
      const pagePath = normalizePath(path.relative(root, filePath));
      const source = await fileSystem.readFile(filePath, 'utf8');
      return extractCellsFromMarkdown(source, pagePath, { helperCrates, highlighter });
    })
  );

  return nestedCells.flat();
}

export async function markRuntimeReady({
  fileSystem = defaultFileSystem,
  paths,
  summary,
  version = createRuntimeVersion(summary)
}) {
  return writeIfChanged(paths.runtimeVersionPath, generateRuntimeVersionModule(version), { fileSystem });
}
