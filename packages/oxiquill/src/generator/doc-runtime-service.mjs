import path from 'node:path';
import { createHighlighter } from 'shiki';
import {
  createOxiquillPaths,
  pathFromUrl,
  pathInUrl
} from '../config/paths.mjs';
import {
  assertUniqueCellIds,
  assertUniqueHaskellFunctionNames,
  assertUniqueHaskellInputBindings,
  assertUniqueRustFunctionNames,
  assertUniqueRustInputBindings,
  createCellManifest,
  generateCellsJson,
  generateCellsModule,
  generateHaskellMain,
  generateRustCargoToml,
  generateRustLib,
  parseCellsFromMarkdown,
  sourceThemes
} from './doc-runtime-core.mjs';
import {
  throwInteractiveCellDiagnostics,
  validateCellDependencies
} from '../lib/doc-runtime/cell-authoring.mjs';
import {
  defaultFileSystem,
  listFiles,
  writeIfChanged
} from './doc-runtime/file-system.mjs';
import { listHelperCrates } from './doc-runtime/helper-crate-service.mjs';
import { normalizePath } from './doc-runtime/path-utils.mjs';
import { copyPyodideAssets } from './doc-runtime/pyodide-assets.mjs';
import { syncLicenseArtifacts } from './license-notices.mjs';
import {
  createRuntimeVersion,
  generateRuntimeVersionModule,
  summarizeCells
} from './doc-runtime/runtime-summary.mjs';

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
  shouldBuildHaskellWasm,
  shouldBuildWasm,
  summarizeCells
} from './doc-runtime/runtime-summary.mjs';
export {
  buildHaskellWasm,
  buildRustWasm,
  createHaskellRuntimeStatus,
  generateHaskellRuntimeStatusJson,
  HASKELL_RUNTIME_STATUS_FILE,
  HASKELL_WASI_COMPILER,
  HASKELL_WASI_COMPILER_ENV,
  HASKELL_WASM_FILE,
  HaskellWasmBuildError,
  MissingHaskellWasiCompilerError,
  resolveHaskellWasiCompiler
} from './doc-runtime/wasm-build.mjs';
export {
  collectBundledPackageNotices,
  collectBundleModuleIds,
  collectRuntimeArtifactNotices,
  createBundledModuleCollector,
  generateThirdPartyLicenseReport,
  packageRootFromModuleId,
  syncLicenseArtifacts
} from './license-notices.mjs';

export function createDocRuntimePaths(rootOrOptions = process.cwd()) {
  const options = typeof rootOrOptions === 'object' && !(rootOrOptions instanceof URL)
    ? rootOrOptions
    : { workspaceRoot: rootOrOptions };

  return createOxiquillPaths(options);
}

export async function createDocRuntimeContext({
  fileSystem = defaultFileSystem,
  highlighter,
  paths: providedPaths,
  pathOptions,
  readManifests,
  root = process.cwd()
} = {}) {
  const paths = providedPaths ?? createDocRuntimePaths({ workspaceRoot: root, ...pathOptions });
  return {
    highlighter:
      highlighter ??
      (await createHighlighter({
        langs: ['rust', 'python', 'haskell'],
        themes: Object.values(sourceThemes)
      })),
    paths,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests })
  };
}

export async function syncDocRuntime({
  fileSystem = defaultFileSystem,
  highlighter,
  helperCrates,
  paths,
  syncLicenses = syncLicenseArtifacts
}) {
  const cells = await collectCells({
    fileSystem,
    helperCrates,
    highlighter,
    paths
  });
  const haskellCells = cells.filter((cell) => cell.language === 'haskell');
  const rustCells = cells.filter((cell) => cell.language === 'rust');

  const writes = await Promise.all([
    writeIfChanged(pathFromUrl(paths.cellsModulePath), generateCellsModule(cells), { fileSystem }),
    writeIfChanged(pathFromUrl(paths.cellsJsonPath), generateCellsJson(cells), { fileSystem }),
    writeIfChanged(pathInUrl(paths.haskellCellsDir, 'Main.hs'), generateHaskellMain(haskellCells), { fileSystem }),
    writeIfChanged(pathInUrl(paths.rustCellsDir, 'Cargo.toml'), generateRustCargoToml(rustCells, helperCrates), {
      fileSystem
    }),
    writeIfChanged(pathInUrl(paths.rustCellsDir, 'src/lib.rs'), generateRustLib(rustCells), { fileSystem })
  ]);
  const pyodideChanged = await copyPyodideAssets({ fileSystem, paths });
  const licensesChanged = await syncLicenses({ fileSystem, paths });
  const summary = summarizeCells(cells);

  return {
    ...summary,
    cellsChanged: writes[0] || writes[1],
    haskellChanged: writes[2],
    licensesChanged,
    pyodideChanged,
    rustChanged: writes[3] || writes[4]
  };
}

export async function collectCells({ fileSystem = defaultFileSystem, helperCrates, highlighter, paths }) {
  const docsDir = pathFromUrl(paths.docsDir);
  const workspaceRoot = pathFromUrl(paths.workspaceRoot);
  const files = await listFiles(docsDir, { fileSystem });
  const markdownFiles = files.filter((filePath) => filePath.endsWith('.mdx') || filePath.endsWith('.md'));
  const parsedPages = await Promise.all(
    markdownFiles.map(async (filePath) => {
      const pagePath = normalizePath(path.relative(workspaceRoot, filePath));
      const source = await fileSystem.readFile(filePath, 'utf8');
      return parseCellsFromMarkdown(source, pagePath);
    })
  );
  const authoringCells = parsedPages.flatMap((page) => page.cells);
  const diagnostics = [
    ...parsedPages.flatMap((page) => page.diagnostics),
    ...authoringCells.flatMap((cell) => validateCellDependencies(cell, helperCrates))
  ];
  throwInteractiveCellDiagnostics(diagnostics);

  const haskellCells = authoringCells.filter((cell) => cell.language === 'haskell');
  const rustCells = authoringCells.filter((cell) => cell.language === 'rust');
  assertUniqueCellIds(authoringCells);
  assertUniqueHaskellFunctionNames(haskellCells);
  assertUniqueHaskellInputBindings(haskellCells);
  assertUniqueRustFunctionNames(rustCells);
  assertUniqueRustInputBindings(rustCells);

  return Promise.all(authoringCells.map((cell) => createCellManifest(cell, highlighter)));
}

export async function markRuntimeReady({
  fileSystem = defaultFileSystem,
  paths,
  summary,
  version = createRuntimeVersion(summary)
}) {
  return writeIfChanged(pathFromUrl(paths.runtimeVersionPath), generateRuntimeVersionModule(version), { fileSystem });
}
