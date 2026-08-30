import path from 'node:path';
import { createHighlighter } from 'shiki';
import { createOxiquillPaths, pathFromUrl, pathInUrl } from '../config/paths.mjs';
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
import { throwInteractiveCellDiagnostics, validateCellDependencies } from '../lib/doc-runtime/cell-authoring.mjs';
import { defaultFileSystem, listFiles, writeIfChanged } from './doc-runtime/file-system.mjs';
import { listHelperCrates } from './doc-runtime/helper-crate-service.mjs';
import { normalizePath } from './doc-runtime/path-utils.mjs';
import {
  copyPyodideAssets as defaultCopyPyodideAssets,
  resolvePyodideRuntimeInputs as defaultResolvePyodideRuntimeInputs
} from './doc-runtime/pyodide-assets.mjs';
import { syncLicenseArtifacts as defaultSyncLicenseArtifacts, syncRustBuildSupportFiles } from './license-notices.mjs';
import {
  createHaskellBuildFingerprint,
  createRuntimeVersion,
  generateRuntimeVersionModule,
  summarizeCells
} from './doc-runtime/runtime-summary.mjs';
import { hashText, stableFingerprint } from './doc-runtime/hashing.mjs';
import { createRuntimePlan } from './doc-runtime/runtime-plan.mjs';
import {
  createRuntimeOwnedOutputs,
  generateRuntimeOwnershipJson,
  readRuntimeOwnership
} from './doc-runtime/runtime-ownership.mjs';
import { createDirectoryStage, discardDirectoryStage, replaceDirectory } from './doc-runtime/atomic-output.mjs';
import { readRuntimeInputs as defaultReadRuntimeInputs } from './doc-runtime/runtime-inputs.mjs';
import { preflightRequiredToolchains as defaultPreflightToolchains } from './doc-runtime/toolchain-preflight.mjs';
import {
  buildHaskellWasm as defaultBuildHaskellWasm,
  buildRustWasm as defaultBuildRustWasm
} from './doc-runtime/wasm-build.mjs';

export { copyFileIfChanged, listFiles, writeIfChanged } from './doc-runtime/file-system.mjs';
export { listHelperCrates, readHelperManifests } from './doc-runtime/helper-crate-service.mjs';
export { hashBytes, hashText, stableFingerprint } from './doc-runtime/hashing.mjs';
export {
  copyPyodideAssets,
  copyVendoredPyodidePackages,
  fetchPyodidePackage,
  PYODIDE_DOWNLOAD_ATTEMPTS,
  PYODIDE_DOWNLOAD_CONCURRENCY,
  PYODIDE_REQUEST_TIMEOUT_MS,
  requiredPyodideFiles,
  resolvePyodideRuntimeInputs,
  resolveVendoredPyodidePackages
} from './doc-runtime/pyodide-assets.mjs';
export {
  createHaskellBuildFingerprint,
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
export { createRuntimePlan } from './doc-runtime/runtime-plan.mjs';
export {
  createRuntimeOwnedOutputs,
  generateRuntimeOwnershipJson,
  readRuntimeOwnership,
  validateRuntimeOwnership
} from './doc-runtime/runtime-ownership.mjs';
export { normalizeRepository, normalizeRuntimeInputs, readRuntimeInputs } from './doc-runtime/runtime-inputs.mjs';
export {
  preflightHaskellToolchain,
  preflightRequiredToolchains,
  preflightRustToolchain
} from './doc-runtime/toolchain-preflight.mjs';

export function createDocRuntimePaths(rootOrOptions = process.cwd()) {
  const options =
    typeof rootOrOptions === 'object' && !(rootOrOptions instanceof URL)
      ? rootOrOptions
      : { workspaceRoot: rootOrOptions };

  return createOxiquillPaths(options);
}

export async function createDocRuntimeContext({
  fileSystem = defaultFileSystem,
  highlighter,
  paths: providedPaths,
  pathOptions,
  pythonOptions = Object.freeze({ offline: false }),
  readManifests,
  readRuntimeInputs = defaultReadRuntimeInputs,
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
    pythonOptions,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests }),
    runtimeInputs: await readRuntimeInputs({ fileSystem, paths })
  };
}

export async function syncDocRuntime({
  buildHaskell = defaultBuildHaskellWasm,
  buildRust = defaultBuildRustWasm,
  fileSystem = defaultFileSystem,
  forceRustBuild = false,
  highlighter,
  helperCrates,
  mode = undefined,
  paths,
  preflightToolchains = defaultPreflightToolchains,
  pythonOptions = Object.freeze({ offline: false }),
  resolvePyodideInputs = defaultResolvePyodideRuntimeInputs,
  runtimeInputs,
  syncLicenses = defaultSyncLicenseArtifacts,
  syncPyodide = defaultCopyPyodideAssets,
  syncRustSupport = syncRustBuildSupportFiles,
  tolerateHaskellBuildFailure = false
}) {
  const cells = await collectCells({
    fileSystem,
    helperCrates,
    highlighter,
    paths
  });
  const haskellCells = cells.filter((cell) => cell.language === 'haskell');
  const pythonCells = cells.filter((cell) => cell.language === 'python');
  const rustCells = cells.filter((cell) => cell.language === 'rust');
  const requestedPythonPackages = Array.from(new Set(pythonCells.flatMap((cell) => cell.packages))).sort();
  const summary = summarizeCells(cells);
  const toolchains = await preflightToolchains({
    fileSystem,
    haskellCellCount: haskellCells.length,
    mode,
    runtimeInputs,
    rustCellCount: rustCells.length,
    tolerateHaskellFailure: tolerateHaskellBuildFailure
  });
  const pyodideRuntimeInputs =
    pythonCells.length > 0
      ? await resolvePyodideInputs({ fileSystem, requestedPackages: requestedPythonPackages })
      : undefined;
  const generated = {
    cellsJson: generateCellsJson(cells),
    cellsModule: generateCellsModule(cells),
    haskellMain: generateHaskellMain(haskellCells),
    rustCargo: generateRustCargoToml(rustCells, helperCrates, runtimeInputs),
    rustLib: generateRustLib(rustCells)
  };
  const desired = await createDesiredRuntime({
    fileSystem,
    generated,
    paths,
    pythonCellCount: pythonCells.length,
    pyodideRuntimeInputs,
    runtimeInputs,
    summary,
    toolchains
  });
  const state = await readRuntimeOwnership({ fileSystem, paths });
  const { outputComplete, outputPresent } = runtimeOutputState({ fileSystem, paths, state });
  const plan = createRuntimePlan({
    desired,
    forceRustBuild,
    mode,
    outputComplete,
    outputPresent,
    state
  });

  if (!plan.hasChanges) {
    const licensesChanged = await syncLicenses({
      fileSystem,
      includeRustBuildFiles: false,
      paths
    });
    return runtimeResult({ licensesChanged, plan, summary });
  }

  await fileSystem.rm(paths.runtimeVersionPath, { force: true });
  const stages = [];
  let haskellBuildResult = { ok: true };

  try {
    const stagedPaths = { ...paths };
    await stageLanguageOutputs({
      fileSystem,
      generated,
      paths,
      plan,
      pyodideRuntimeInputs,
      pythonOptions,
      requestedPythonPackages,
      stagedPaths,
      stages,
      syncPyodide,
      syncRustSupport
    });

    if (plan.languages.rust.public === 'build') {
      await buildRust({ mode, paths: stagedPaths });
    }
    if (plan.languages.haskell.public === 'build') {
      haskellBuildResult = await buildHaskell({
        fileSystem,
        haskellFingerprint: summary.haskellFingerprint,
        mode,
        paths: stagedPaths,
        tolerateFailure: tolerateHaskellBuildFailure
      });
    }

    const nextState = await createNextRuntimeState({
      desired,
      fileSystem,
      haskellBuildResult,
      mode,
      paths,
      plan,
      stagedPaths,
      state
    });
    const generatedStage = await createDirectoryStage(paths.generatedDir, { fileSystem });
    stages.push({ stagePath: generatedStage, targetPath: paths.generatedDir, type: 'generated' });
    await writeGeneratedRuntime({
      fileSystem,
      generated,
      nextState,
      paths: { ...paths, generatedDir: generatedStage },
      ready: haskellBuildResult.ok,
      summary
    });

    await promoteLanguageStages(stages, { fileSystem });
    await removeStaleLanguageOutputs({ fileSystem, paths, plan });
    const licensesChanged = await syncLicenses({
      fileSystem,
      includeRustBuildFiles: false,
      paths
    });
    await replaceDirectory(generatedStage, paths.generatedDir, { fileSystem });

    return runtimeResult({ haskellBuildResult, licensesChanged, plan, summary });
  } finally {
    await Promise.all(stages.map(({ stagePath }) => discardDirectoryStage(stagePath, { fileSystem })));
  }
}

async function createDesiredRuntime({
  fileSystem,
  generated,
  paths,
  pythonCellCount,
  pyodideRuntimeInputs,
  runtimeInputs,
  summary,
  toolchains
}) {
  const helperFingerprint =
    summary.rustCellCount > 0 ? await fingerprintHelperSources({ fileSystem, paths }) : stableFingerprint([]);
  const rustSourceFingerprint = hashText(
    stableFingerprint({
      cargo: generated.rustCargo,
      lib: generated.rustLib,
      lockSha256: runtimeInputs.rustLockSha256
    })
  );
  const haskellSourceFingerprint = hashText(generated.haskellMain);
  const pythonAssetFingerprint = pythonCellCount > 0 ? pyodideRuntimeInputs.fingerprint : stableFingerprint([]);

  return Object.freeze({
    manifestFingerprint: summary.manifestFingerprint,
    rust: Object.freeze({
      buildFingerprint: stableFingerprint({
        helpers: helperFingerprint,
        source: rustSourceFingerprint,
        toolchain: toolchains.rust ?? runtimeInputs.rust
      }),
      cellCount: summary.rustCellCount,
      sourceFingerprint: rustSourceFingerprint
    }),
    python: Object.freeze({ assetFingerprint: pythonAssetFingerprint, cellCount: pythonCellCount }),
    haskell: Object.freeze({
      buildFingerprint: createHaskellBuildFingerprint({
        cells: summary.haskellFingerprint,
        runtimeInputs: runtimeInputs.haskell,
        source: haskellSourceFingerprint,
        toolchain: toolchains.haskell
      }),
      cellCount: summary.haskellCellCount,
      sourceFingerprint: haskellSourceFingerprint
    })
  });
}

function runtimeOutputState({ fileSystem, paths, state }) {
  const outputPresent = {
    generated: fileSystem.existsSync(paths.generatedDir),
    rustSource: fileSystem.existsSync(paths.rustCellsDir),
    rustPublic: fileSystem.existsSync(paths.rustWasmPublicDir),
    pythonPublic: fileSystem.existsSync(paths.pyodidePublicDir),
    haskellSource: fileSystem.existsSync(paths.haskellCellsDir),
    haskellPublic: fileSystem.existsSync(paths.haskellWasmPublicDir)
  };
  return {
    outputPresent,
    outputComplete: {
      generated:
        Boolean(state) &&
        fileSystem.existsSync(paths.cellsModulePath) &&
        fileSystem.existsSync(paths.cellsJsonPath) &&
        fileSystem.existsSync(paths.runtimeOwnershipPath) &&
        (state.ready === false || fileSystem.existsSync(paths.runtimeVersionPath)),
      rustSource:
        outputPresent.rustSource &&
        ['Cargo.toml', 'Cargo.lock', 'LICENSE-MIT', 'LICENSE-APACHE', 'src/lib.rs'].every((fileName) =>
          fileSystem.existsSync(pathInUrl(paths.rustCellsDir, fileName))
        ),
      rustPublic: recordedFilesExist(state?.languages?.rust?.publicFiles, paths.rustWasmPublicDir, fileSystem),
      pythonPublic: recordedFilesExist(state?.languages?.python?.publicFiles, paths.pyodidePublicDir, fileSystem),
      haskellSource: outputPresent.haskellSource && fileSystem.existsSync(pathInUrl(paths.haskellCellsDir, 'Main.hs')),
      haskellPublic: recordedFilesExist(state?.languages?.haskell?.publicFiles, paths.haskellWasmPublicDir, fileSystem)
    }
  };
}

async function stageLanguageOutputs({
  fileSystem,
  generated,
  paths,
  plan,
  pyodideRuntimeInputs,
  pythonOptions,
  requestedPythonPackages,
  stagedPaths,
  stages,
  syncPyodide,
  syncRustSupport
}) {
  if (plan.languages.rust.source === 'write' || plan.languages.rust.public === 'build') {
    const stagePath = await addDirectoryStage('rustCellsDir', paths, stagedPaths, stages, { fileSystem });
    await Promise.all([
      writeIfChanged(pathInUrl(stagePath, 'Cargo.toml'), generated.rustCargo, { fileSystem }),
      writeIfChanged(pathInUrl(stagePath, 'src/lib.rs'), generated.rustLib, { fileSystem }),
      syncRustSupport({ fileSystem, paths: stagedPaths })
    ]);
  }
  if (plan.languages.rust.public === 'build') {
    await addDirectoryStage('rustWasmPublicDir', paths, stagedPaths, stages, { fileSystem });
  }
  if (plan.languages.python.public === 'copy') {
    await addDirectoryStage('pyodidePublicDir', paths, stagedPaths, stages, { fileSystem });
    await syncPyodide({
      fileSystem,
      paths: stagedPaths,
      pythonOptions,
      requestedPackages: requestedPythonPackages,
      runtimeInputs: pyodideRuntimeInputs
    });
  }
  if (plan.languages.haskell.source === 'write' || plan.languages.haskell.public === 'build') {
    const stagePath = await addDirectoryStage('haskellCellsDir', paths, stagedPaths, stages, { fileSystem });
    await writeIfChanged(pathInUrl(stagePath, 'Main.hs'), generated.haskellMain, { fileSystem });
  }
  if (plan.languages.haskell.public === 'build') {
    await addDirectoryStage('haskellWasmPublicDir', paths, stagedPaths, stages, { fileSystem });
  }
}

async function addDirectoryStage(pathName, paths, stagedPaths, stages, { fileSystem }) {
  const targetPath = paths[pathName];
  const stagePath = await createDirectoryStage(targetPath, { fileSystem });
  stagedPaths[pathName] = stagePath;
  stages.push({ stagePath, targetPath, type: 'language' });
  return stagePath;
}

async function createNextRuntimeState({
  desired,
  fileSystem,
  haskellBuildResult,
  mode,
  paths,
  plan,
  stagedPaths,
  state
}) {
  const languages = {};
  if (desired.rust.cellCount > 0) {
    languages.rust = languageState({
      buildFingerprint: desired.rust.buildFingerprint,
      mode,
      previous: state?.languages?.rust,
      publicAction: plan.languages.rust.public,
      publicFiles:
        plan.languages.rust.public === 'build'
          ? await listRelativeFiles(stagedPaths.rustWasmPublicDir, { fileSystem })
          : undefined,
      sourceFingerprint: desired.rust.sourceFingerprint,
      status: 'ready'
    });
  }
  if (desired.python.cellCount > 0) {
    languages.python = {
      assetFingerprint: desired.python.assetFingerprint,
      publicFiles:
        plan.languages.python.public === 'copy'
          ? await listRelativeFiles(stagedPaths.pyodidePublicDir, { fileSystem })
          : (state?.languages?.python?.publicFiles ?? [])
    };
  }
  if (desired.haskell.cellCount > 0) {
    languages.haskell = languageState({
      buildFingerprint: desired.haskell.buildFingerprint,
      mode,
      previous: state?.languages?.haskell,
      publicAction: plan.languages.haskell.public,
      publicFiles:
        plan.languages.haskell.public === 'build'
          ? await listRelativeFiles(stagedPaths.haskellWasmPublicDir, { fileSystem })
          : undefined,
      sourceFingerprint: desired.haskell.sourceFingerprint,
      status: haskellBuildResult.ok ? 'ready' : 'unavailable'
    });
  }

  return {
    schemaVersion: 1,
    manifestFingerprint: desired.manifestFingerprint,
    ready: haskellBuildResult.ok,
    languages,
    ownedOutputs: createRuntimeOwnedOutputs(paths).filter((entry) => desired[entry.language].cellCount > 0)
  };
}

function languageState({ buildFingerprint, mode, previous, publicAction, publicFiles, sourceFingerprint, status }) {
  const next = { sourceFingerprint };
  if (publicAction === 'build') {
    return { ...next, buildFingerprint, mode, publicFiles, status };
  }
  if (publicAction === 'keep' && previous?.publicFiles?.length > 0) {
    return {
      ...next,
      buildFingerprint: previous.buildFingerprint,
      mode: previous.mode,
      publicFiles: previous.publicFiles,
      status: previous.status
    };
  }
  return next;
}

async function writeGeneratedRuntime({ fileSystem, generated, nextState, paths, ready, summary }) {
  await Promise.all([
    writeIfChanged(pathInUrl(paths.generatedDir, 'cells.ts'), generated.cellsModule, { fileSystem }),
    writeIfChanged(pathInUrl(paths.generatedDir, 'cells.json'), generated.cellsJson, { fileSystem }),
    writeIfChanged(pathInUrl(paths.generatedDir, 'runtime-ownership.json'), generateRuntimeOwnershipJson(nextState), {
      fileSystem
    }),
    ...(ready
      ? [
          writeIfChanged(
            pathInUrl(paths.generatedDir, 'runtime-version.ts'),
            generateRuntimeVersionModule(createRuntimeVersion(summary)),
            { fileSystem }
          )
        ]
      : [])
  ]);
}

async function promoteLanguageStages(stages, { fileSystem }) {
  for (const stage of stages.filter(({ type }) => type === 'language')) {
    await replaceDirectory(stage.stagePath, stage.targetPath, { fileSystem });
  }
}

async function removeStaleLanguageOutputs({ fileSystem, paths, plan }) {
  const targets = [
    [plan.languages.rust.source, paths.rustCellsDir],
    [plan.languages.rust.public, paths.rustWasmPublicDir],
    [plan.languages.python.public, paths.pyodidePublicDir],
    [plan.languages.haskell.source, paths.haskellCellsDir],
    [plan.languages.haskell.public, paths.haskellWasmPublicDir]
  ];
  await Promise.all(
    targets
      .filter(([action]) => action === 'remove')
      .map(([, targetPath]) => fileSystem.rm(targetPath, { force: true, recursive: true }))
  );
}

function runtimeResult({ haskellBuildResult, licensesChanged, plan, summary }) {
  return {
    ...summary,
    cellsChanged: plan.generated === 'write',
    haskellChanged: plan.languages.haskell.source !== 'keep',
    haskellBuildResult,
    licensesChanged,
    plan,
    pyodideChanged: plan.languages.python.public === 'copy',
    rustChanged: plan.languages.rust.source !== 'keep'
  };
}

async function listRelativeFiles(directory, { fileSystem }) {
  const files = await listFiles(directory, { fileSystem });
  return files.map((filePath) => normalizePath(path.relative(directory, filePath))).sort();
}

function recordedFilesExist(files, directory, fileSystem) {
  return (
    Array.isArray(files) &&
    files.length > 0 &&
    files.every(
      (fileName) =>
        typeof fileName === 'string' &&
        fileName !== '' &&
        !path.isAbsolute(fileName) &&
        !normalizePath(fileName).split('/').includes('..') &&
        fileSystem.existsSync(pathInUrl(directory, fileName))
    )
  );
}

async function fingerprintHelperSources({ fileSystem, paths }) {
  const files = await listSelectedFiles(paths.cratesDir, { fileSystem });
  const entries = await Promise.all(
    files.map(async (filePath) => ({
      content: await fileSystem.readFile(filePath, 'utf8'),
      path: normalizePath(path.relative(paths.cratesDir, filePath))
    }))
  );
  return stableFingerprint(entries);
}

async function listSelectedFiles(directory, { fileSystem }) {
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const nested = await Promise.all(
    entries
      .filter((entry) => entry.name !== 'target' && entry.name !== '.git')
      .map(async (entry) => {
        const entryPath = path.join(directory, entry.name);
        if (entry.isDirectory()) return listSelectedFiles(entryPath, { fileSystem });
        return entry.isFile() && /(?:\.rs|\.toml|Cargo\.lock)$/u.test(entry.name) ? [entryPath] : [];
      })
  );
  return nested.flat().sort();
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
