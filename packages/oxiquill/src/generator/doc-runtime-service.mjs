import { readBuildFailures, recordRustBuildFailure, clearBuildFailures } from './doc-runtime/build-failures.mjs';
import { runProcess } from './doc-runtime/process-runner.mjs';
import { createRuntimeEvents } from './doc-runtime/runtime-events.mjs';
import { explainRuntimePlan, pageSourceFingerprints, sourceFingerprints } from './doc-runtime/plan-reasons.mjs';
import {
  analyzeRustGroups,
  applyRustGroupPlan,
  assertRustGroupInputs,
  prepareRustGroupSources,
  finalizeRustGroups
} from './doc-runtime/rust-group-service.mjs';
import path from 'node:path';
import { finalizeRustModule, validateRustModuleFiles } from './doc-runtime/rust-module-assets.mjs';
import { parseGeneratedCellManifest } from './doc-runtime/cell-manifest.mjs';
import { validateRustRegistry } from '../lib/doc-runtime/rust-registry.mjs';
import {
  artifactBuildFingerprint,
  getGeneratorIdentity,
  readRustBuildInputs,
  readRustBuildOptionDigests
} from './doc-runtime/build-inputs.mjs';
import { recordedOutputIsComplete, recordOutputIntegrity } from './doc-runtime/output-integrity.mjs';
import { createHighlighter } from 'shiki';
import { createOxiquillPaths, pathFromUrl, pathInUrl } from '../config/paths.mjs';
import {
  createCellManifest,
  generateCellsJson,
  generateCellsModule,
  generateHaskellMain,
  generateRustCargoToml,
  generateRustLib,
  sourceThemes
} from './doc-runtime-core.mjs';
import { defaultFileSystem, listFiles, writeIfChanged } from './doc-runtime/file-system.mjs';
import { collectAuthoringCells, collectAuthoringContent } from './doc-runtime/cell-collection.mjs';
import {
  assertGenerationSnapshot,
  createGenerationSnapshot,
  readHelperInputs
} from './doc-runtime/generation-snapshot.mjs';
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
import { generateHaskellOutput } from './doc-runtime/haskell-output-codegen.mjs';
import { createRuntimePlan } from './doc-runtime/runtime-plan.mjs';
import {
  createRuntimeOwnedOutputs,
  generateRuntimeOwnershipJson,
  readRuntimeOwnership
} from './doc-runtime/runtime-ownership.mjs';
import { createDirectoryStage, discardDirectoryStage, publishDirectoryStages } from './doc-runtime/atomic-output.mjs';
import { readRuntimeInputs as defaultReadRuntimeInputs } from './doc-runtime/runtime-inputs.mjs';
import { preflightRequiredToolchains as defaultPreflightToolchains } from './doc-runtime/toolchain-preflight.mjs';
import {
  buildHaskellWasm as defaultBuildHaskellWasm,
  buildRustWasm as defaultBuildRustWasm,
  buildRustGroups as defaultBuildRustGroups
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
  rustOptions = Object.freeze({ grouping: 'site' }),
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
    rustOptions,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests }),
    runtimeInputs: await readRuntimeInputs({ fileSystem, paths })
  };
}

export async function syncDocRuntime({
  buildHaskell = defaultBuildHaskellWasm,
  buildRust = defaultBuildRustWasm,
  buildGroups = defaultBuildRustGroups,
  explain = false,
  events = createRuntimeEvents(),
  format = 'human',
  runCommand = runProcess,
  rustOptions = Object.freeze({ grouping: 'site' }),
  environment = process.env,
  generatorIdentity = getGeneratorIdentity,
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
  tolerateHaskellBuildFailure = false,
  trackChild
}) {
  const snapshotOptions = { fileSystem, paths, pythonOptions };
  const [content, helpers] = await Promise.all([
    collectAuthoringContent({ ...snapshotOptions, helperCrates, events }),
    readHelperInputs(snapshotOptions)
  ]);
  const authoringCells = content.cells;
  const snapshot = createGenerationSnapshot(authoringCells, helpers, content.pages);
  const cells = await Promise.all(authoringCells.map((cell) => createCellManifest(cell, highlighter)));
  const haskellCells = cells.filter((cell) => cell.language === 'haskell');
  const pythonCells = cells.filter((cell) => cell.language === 'python');
  const rustCells = cells.filter((cell) => cell.language === 'rust');
  const summary = summarizeCells(cells);
  const requestedPythonPackages = summary.pythonPackages;
  const processOptions = { events, format, trackChild };
  const execute = (command, args, options) => runCommand(command, args, { ...processOptions, ...options });
  const toolchains = await preflightToolchains({
    explain,
    paths,
    grouping: rustOptions.grouping,
    runCommand: execute,
    cwd: paths.workspaceRoot,
    environment,
    fileSystem,
    haskellCellCount: haskellCells.length,
    mode,
    runtimeInputs,
    rustCellCount: rustCells.length,
    tolerateHaskellFailure: tolerateHaskellBuildFailure,
    ...(trackChild ? { trackChild } : {})
  }).catch((error) => {
    if (!explain) throw error;
    events.report({ type: 'diagnostic', message: `Toolchain unavailable while explaining: ${error.message}` });
    return {};
  });
  const pyodideRuntimeInputs =
    pythonCells.length > 0 || Object.keys(pythonOptions.additionalPackages ?? {}).length > 0
      ? await resolvePyodideInputs({ fileSystem, requestedPackages: requestedPythonPackages, paths, pythonOptions })
      : undefined;
  const generated = {
    cellsJson: generateCellsJson(cells, snapshot.generationId),
    cellsModule: generateCellsModule(cells, snapshot.generationId),
    haskellMain: generateHaskellMain(haskellCells),
    haskellOutput: generateHaskellOutput(),
    rustCargo: generateRustCargoToml(rustCells, helperCrates, runtimeInputs),
    rustLib: generateRustLib(rustCells)
  };
  const identity = await generatorIdentity();
  const rustBuildInputs =
    rustCells.length > 0 ? await readRustBuildInputs({ environment, fileSystem, paths }) : undefined;
  const buildOptions = rustCells.length > 0 ? await readRustBuildOptionDigests({ environment, fileSystem, paths }) : {};
  let desired = createDesiredRuntime({
    snapshot,
    generatorIdentity: identity,
    rustBuildInputs,
    generated,
    pythonCellCount: pythonCells.length,
    pyodideRuntimeInputs,
    runtimeInputs,
    summary,
    toolchains
  });
  const state = await readRuntimeOwnership({ fileSystem, paths });
  const failures = await readBuildFailures({ fileSystem, paths });
  const planningState =
    failures.includes('site') && state
      ? { ...state, languages: { ...state.languages, rust: { ...state.languages.rust, status: 'failed' } } }
      : state;
  const groupAnalysis =
    rustOptions.grouping === 'page'
      ? await events.phase('validation', { language: 'rust' }, () =>
          analyzeRustGroups({
            cells: rustCells,
            paths,
            helperCrates,
            runtimeInputs,
            fileSystem,
            state,
            mode,
            buildInputs: rustBuildInputs,
            buildOptions,
            toolchain: toolchains.rust,
            generatorIdentity: identity,
            force: forceRustBuild,
            failures
          })
        )
      : undefined;
  desired = {
    ...desired,
    ...Object.fromEntries(
      ['rust', 'haskell', 'python'].map((language) => [
        language,
        {
          ...desired[language],
          sources: sourceFingerprints(cells.filter((cell) => cell.language === language)),
          ...(language === 'rust' ? { buildOptions } : {})
        }
      ])
    )
  };
  if (groupAnalysis)
    desired.rust = {
      ...desired.rust,
      sourceFingerprint: hashText(
        stableFingerprint(groupAnalysis.groups.map((group) => [group.id, group.desired.sourceFingerprint]))
      ),
      buildFingerprint: stableFingerprint(
        groupAnalysis.groups.map((group) => [group.id, group.desired.buildFingerprint])
      )
    };
  for (const language of ['rust', 'python', 'haskell'])
    desired[language].pages = pageSourceFingerprints(desired[language].sources);
  const { outputComplete, outputPresent, outputMissing } = await runtimeOutputState({
    fileSystem,
    paths,
    state,
    pageGrouping: Boolean(groupAnalysis)
  });
  let plan = createRuntimePlan({
    desired,
    forceRustBuild,
    mode,
    outputComplete,
    outputPresent,
    state: planningState
  });

  if (groupAnalysis) plan = applyRustGroupPlan(plan, groupAnalysis, state, mode);
  const metadataUpgrade =
    state &&
    ['rust', 'python', 'haskell'].some(
      (language) =>
        desired[language].cellCount > 0 && (!state.languages[language]?.sources || !state.languages[language]?.pages)
    );
  if (metadataUpgrade) {
    plan = { ...plan, generated: 'write', hasChanges: true };
    events.report({ type: 'diagnostic', message: 'Stored page and cell source fingerprints need updating.' });
  }
  const reasons = explainRuntimePlan({
    plan,
    desired,
    state: planningState,
    mode,
    outputComplete,
    outputMissing,
    forceRustBuild
  });
  if (groupAnalysis)
    for (const target of ['source', 'public']) {
      const entries = groupAnalysis.groups.flatMap((group) => group.reasons[target]);
      if (entries.length)
        reasons.rust[target] = [...new Map(entries.map((reason) => [JSON.stringify(reason), reason])).values()];
    }
  plan = { ...plan, reasons };
  for (const [language, actions] of Object.entries(plan.languages)) {
    for (const [target, action] of Object.entries(actions))
      events.report({ type: 'plan', language, target, action, reasons: reasons[language][target] });
  }
  for (const group of plan.rustGroups ?? []) {
    for (const target of ['source', 'public'])
      events.report({
        type: 'plan',
        language: 'rust',
        module: group.id,
        page: group.page,
        target,
        action: group[target],
        reasons: group.reasons[target]
      });
  }
  for (const id of plan.removedRustGroups ?? [])
    events.report({
      type: 'plan',
      language: 'rust',
      module: id,
      action: 'remove',
      reasons: [
        {
          code: 'source-changed',
          changes: [{ page: state.languages.rust.groups[id].page }]
        }
      ]
    });
  const assertInputs = () =>
    events.phase('validation', {}, async () => {
      if (mode === 'build') await assertGenerationSnapshot(snapshot, snapshotOptions);
      if (groupAnalysis) await assertRustGroupInputs({ groups: groupAnalysis.groups, paths, helperCrates, fileSystem });
    });
  if (explain) {
    for (const phase of ['generation', 'compile', 'optimize', 'publish']) events.skipped(phase, { reason: 'explain' });
    return runtimeResult({ plan, snapshot, summary });
  }

  if (!plan.hasChanges) {
    for (const phase of ['generation', 'compile', 'optimize', 'publish']) events.skipped(phase, { cache: 'hit' });
    const licensesChanged = await syncLicenses({
      fileSystem,
      includeRustBuildFiles: false,
      paths,
      pythonOptions
    });
    if (mode === 'build' || groupAnalysis) await assertInputs();
    return runtimeResult({ licensesChanged, plan, snapshot, summary });
  }

  const stages = [];
  const installedRustFiles = [];
  let published = false;
  let haskellBuildResult = { ok: true };

  try {
    const stagedPaths = { ...paths };
    await events.phase('generation', {}, async () => {
      if (
        groupAnalysis &&
        (plan.languages.rust.source !== 'keep' || plan.languages.rust.public === 'build') &&
        rustCells.length > 0
      ) {
        await prepareRustGroupSources({ analysis: groupAnalysis, paths, fileSystem, syncRustSupport });
      }
      await stageLanguageOutputs({
        pageGrouping: Boolean(groupAnalysis),
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
    });

    if (plan.languages.rust.public === 'build') {
      try {
        if (groupAnalysis)
          await buildGroups({
            ...processOptions,
            environment,
            fileSystem,
            mode,
            paths: stagedPaths,
            groups: groupAnalysis.groups,
            wasmOpt: toolchains.rust?.wasmOpt,
            wasmBindgen: toolchains.rust?.wasmBindgen,
            runCommand: execute
          });
        else
          await buildRust({
            ...processOptions,
            runCommand: execute,
            environment,
            fileSystem,
            mode,
            paths: stagedPaths,
            wasmOpt: toolchains.rust?.wasmOpt,
            ...(trackChild ? { trackChild } : {})
          });
      } catch (error) {
        await recordRustBuildFailure({
          modules: groupAnalysis
            ? groupAnalysis.groups.filter((group) => group.public === 'build').map((group) => group.id)
            : ['site'],
          paths,
          fileSystem
        }).catch(() => {});
        throw error;
      }
    } else {
      events.skipped('compile', { language: 'rust', cache: 'hit' });
      events.skipped('optimize', { language: 'rust', reason: mode === 'build' ? 'cache-hit' : 'dev' });
    }
    if (plan.languages.haskell.public === 'build') {
      haskellBuildResult = await events.phase('compile', { language: 'haskell', module: 'site' }, () =>
        buildHaskell({
          ...processOptions,
          runCommand: execute,
          compilerVersion: toolchains.haskell?.version,
          environment,
          fileSystem,
          haskellFingerprint: summary.haskellFingerprint,
          mode,
          paths: stagedPaths,
          tolerateFailure: tolerateHaskellBuildFailure,
          ...(trackChild ? { trackChild } : {})
        })
      );
      if (!haskellBuildResult.ok && outputComplete.haskellPublic) {
        // A tolerated dev failure must not replace a previously verified runtime.
        const publicStage = stages.find((stage) => stage.targetPath === paths.haskellWasmPublicDir);
        publicStage.type = 'failed';
        stagedPaths.haskellWasmPublicDir = paths.haskellWasmPublicDir;
      }
    }

    const grouped =
      groupAnalysis && plan.languages.rust.public === 'build'
        ? await finalizeRustGroups({
            groups: groupAnalysis.groups,
            paths: stagedPaths,
            mode,
            publicPaths: paths,
            fileSystem
          })
        : undefined;
    const rust = grouped
      ? grouped.registry
      : plan.languages.rust.public === 'build'
        ? await finalizeRustModule({ cells: rustCells, paths: stagedPaths, publicPaths: paths, fileSystem })
        : plan.languages.rust.public === 'keep'
          ? state?.rust
          : undefined;
    if (rust)
      await validateRustModuleFiles({
        registry: rust,
        cells,
        assetDirectory: stagedPaths.rustWasmPublicDir,
        fileSystem
      });
    generated.cellsJson = generateCellsJson(
      cells,
      snapshot.generationId,
      rust ?? (rustCells.length === 0 ? { version: 1, modules: [] } : undefined)
    );
    generated.cellsModule = generateCellsModule(cells, snapshot.generationId, rust);
    const nextState = await createNextRuntimeState({
      desired,
      snapshot,
      fileSystem,
      haskellBuildResult,
      mode,
      paths,
      plan,
      stagedPaths,
      state
    });
    if (rust) nextState.rust = rust;
    if (groupAnalysis && nextState.languages.rust) {
      nextState.languages.rust.grouping = 'page';
      nextState.languages.rust.groups =
        grouped?.states ??
        Object.fromEntries(
          groupAnalysis.groups.map((group) => [
            group.id,
            group.public === 'keep' && group.previous
              ? group.previous
              : {
                  page: group.page,
                  sourceFingerprint: group.desired.sourceFingerprint,
                  sources: group.desired.sources,
                  buildOptions: group.desired.buildOptions
                }
          ])
        );
    }
    nextState.ownedOutputs = createRuntimeOwnedOutputs(paths, rust ?? { version: 1, modules: [] }).filter(
      (entry) => desired[entry.language].cellCount > 0
    );
    nextState.ready = nextState.ready && (rustCells.length === 0 || Boolean(rust));
    const generatedStage = await createDirectoryStage(paths.generatedDir, { fileSystem });
    stages.push({ stagePath: generatedStage, targetPath: paths.generatedDir, type: 'generated' });
    await writeGeneratedRuntime({
      fileSystem,
      generated,
      nextState,
      paths: { ...paths, generatedDir: generatedStage },
      ready: nextState.ready,
      summary
    });

    // License collection must see the next runtime, including removed languages,
    // while all published output remains untouched until the checkpoint passes.
    for (const [language, field] of [
      ['rust', 'rustWasmPublicDir'],
      ['python', 'pyodidePublicDir'],
      ['haskell', 'haskellWasmPublicDir']
    ]) {
      if (plan.languages[language].public === 'remove') {
        await addDirectoryStage(field, paths, stagedPaths, stages, { fileSystem, type: 'absent' });
      }
    }
    const licenseStage = await addDirectoryStage('licensesPublicDir', paths, stagedPaths, stages, { fileSystem });
    const licenseFiles = fileSystem.existsSync(paths.licensesPublicDir)
      ? await listFiles(paths.licensesPublicDir, { fileSystem })
      : [];
    await Promise.all(
      licenseFiles.map(async (file) => {
        const target = path.join(licenseStage, path.relative(paths.licensesPublicDir, file));
        await fileSystem.mkdir(path.dirname(target), { recursive: true });
        await fileSystem.copyFile(file, target);
      })
    );
    const licensesChanged = await syncLicenses({
      fileSystem,
      includeRustBuildFiles: false,
      paths: stagedPaths,
      pythonOptions
    });
    if (mode === 'build' || groupAnalysis) await assertInputs();
    // Install immutable assets first; keep the old registry's files reachable until publication succeeds.
    const rustStage = stages.find((stage) => stage.targetPath === paths.rustWasmPublicDir && stage.type === 'language');
    if (rustStage) {
      await fileSystem.mkdir(paths.rustWasmPublicDir, { recursive: true });
      for (const file of await listRelativeFiles(rustStage.stagePath, { fileSystem })) {
        const target = path.join(paths.rustWasmPublicDir, file);
        if (!fileSystem.existsSync(target)) installedRustFiles.push(target);
        await fileSystem.mkdir(path.dirname(target), { recursive: true });
        // Staging is on the same filesystem: never expose a partially copied module.
        await fileSystem.rename(path.join(rustStage.stagePath, file), target);
      }
    }
    await events.phase('publish', {}, () =>
      publishDirectoryStages(
        [
          ...stages.filter(({ type, targetPath }) => type === 'language' && targetPath !== paths.rustWasmPublicDir),
          ...staleLanguageStages(paths, plan),
          { stagePath: generatedStage, targetPath: paths.generatedDir }
        ],
        {
          fileSystem,
          onPublished: () => {
            published = true;
          }
        }
      )
    );
    await clearBuildFailures({ paths, fileSystem });
    if (groupAnalysis)
      for (const id of plan.removedRustGroups ?? []) {
        await fileSystem.rm(path.join(paths.rustCellsDir, 'pages', id), { recursive: true, force: true });
      }
    const retainedRustFiles = new Set(nextState.languages.rust?.publicFiles ?? []);
    const previousRustFiles = state?.rust
      ? state.rust.modules.flatMap((module) => [module.glue, module.wasm].map((asset) => path.basename(asset.url)))
      : ['doc_rust_cells.js', 'doc_rust_cells_bg.wasm'].filter((name) =>
          state?.languages?.rust?.publicFiles?.includes(name)
        );
    await Promise.all(
      previousRustFiles
        .filter((file) => !retainedRustFiles.has(file))
        .map((file) => fileSystem.rm(path.join(paths.rustWasmPublicDir, file), { force: true }))
    );

    return runtimeResult({ haskellBuildResult, licensesChanged, plan, snapshot, summary });
  } finally {
    if (!published) await Promise.all(installedRustFiles.map((file) => fileSystem.rm(file, { force: true })));
    await Promise.all(stages.map(({ stagePath }) => discardDirectoryStage(stagePath, { fileSystem })));
  }
}

function createDesiredRuntime({
  snapshot,
  generatorIdentity,
  rustBuildInputs,
  generated,
  pythonCellCount,
  pyodideRuntimeInputs,
  runtimeInputs,
  summary,
  toolchains
}) {
  const helperFingerprint = summary.rustCellCount > 0 ? stableFingerprint(snapshot.helpers) : stableFingerprint([]);
  const rustSourceFingerprint = hashText(
    stableFingerprint({
      cargo: generated.rustCargo,
      lib: generated.rustLib,
      lockSha256: runtimeInputs.rustLockSha256
    })
  );
  const haskellSourceFingerprint = hashText(stableFingerprint([generated.haskellMain, generated.haskellOutput]));
  const pythonAssetFingerprint = pythonCellCount > 0 ? pyodideRuntimeInputs.fingerprint : stableFingerprint([]);

  return Object.freeze({
    generationId: snapshot.generationId,
    referenceId: snapshot.referenceId,
    referenceSnapshotFingerprint: hashText(stableFingerprint(snapshot.pages)),
    manifestFingerprint: summary.manifestFingerprint,
    rust: Object.freeze({
      buildFingerprint: stableFingerprint({
        generatorIdentity,
        package: runtimeInputs.package,
        rustBuildInputs,
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
        generatorIdentity,
        packageIdentity: runtimeInputs.package,
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

async function runtimeOutputState({ fileSystem, paths, state, pageGrouping = false }) {
  const manifest = fileSystem.existsSync(paths.cellsJsonPath)
    ? parseGeneratedCellManifest(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'))
    : undefined;
  if (manifest?.rust) validateRustRegistry(manifest.rust, manifest.cells);
  const registryCurrent = !state?.rust || stableFingerprint(state.rust) === stableFingerprint(manifest?.rust);
  const outputPresent = {
    generated: fileSystem.existsSync(paths.generatedDir),
    rustSource: fileSystem.existsSync(paths.rustCellsDir),
    rustPublic:
      fileSystem.existsSync(paths.rustWasmPublicDir) && (!state || Boolean(state.languages?.rust?.publicFiles?.length)),
    pythonPublic: fileSystem.existsSync(paths.pyodidePublicDir),
    haskellSource: fileSystem.existsSync(paths.haskellCellsDir),
    haskellPublic: fileSystem.existsSync(paths.haskellWasmPublicDir)
  };
  return {
    outputPresent,
    outputMissing: Object.fromEntries(
      await Promise.all(
        ['rust', 'python', 'haskell'].flatMap((language) => {
          const directory =
            language === 'rust'
              ? paths.rustWasmPublicDir
              : language === 'python'
                ? paths.pyodidePublicDir
                : paths.haskellWasmPublicDir;
          const files = state?.languages?.[language]?.publicFiles;
          return [
            [`${language}Source`, !outputPresent[`${language}Source`]],
            [
              `${language}Public`,
              !files?.length || files.some((name) => !fileSystem.existsSync(path.join(directory, name)))
            ]
          ];
        })
      )
    ),
    outputComplete: {
      generated:
        Boolean(state) &&
        registryCurrent &&
        fileSystem.existsSync(paths.cellsModulePath) &&
        fileSystem.existsSync(paths.cellsJsonPath) &&
        fileSystem.existsSync(paths.runtimeOwnershipPath) &&
        (state.ready === false || fileSystem.existsSync(paths.runtimeVersionPath)),
      rustSource:
        outputPresent.rustSource &&
        ['Cargo.toml', 'Cargo.lock', 'LICENSE-MIT', 'LICENSE-APACHE', ...(pageGrouping ? [] : ['src/lib.rs'])].every(
          (fileName) => fileSystem.existsSync(pathInUrl(paths.rustCellsDir, fileName))
        ),
      rustPublic:
        Boolean(state?.rust) &&
        (await recordedOutputIsComplete(state?.languages?.rust, paths.rustWasmPublicDir, fileSystem)),
      pythonPublic: await recordedOutputIsComplete(state?.languages?.python, paths.pyodidePublicDir, fileSystem),
      haskellSource:
        outputPresent.haskellSource &&
        ['Main.hs', 'Oxiquill/Output.hs'].every((file) =>
          fileSystem.existsSync(pathInUrl(paths.haskellCellsDir, file))
        ),
      haskellPublic: await recordedOutputIsComplete(state?.languages?.haskell, paths.haskellWasmPublicDir, fileSystem)
    }
  };
}

async function stageLanguageOutputs({
  pageGrouping = false,
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
  if (!pageGrouping && (plan.languages.rust.source === 'write' || plan.languages.rust.public === 'build')) {
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
    await writeIfChanged(pathInUrl(stagePath, 'Oxiquill/Output.hs'), generated.haskellOutput, { fileSystem });
  }
  if (plan.languages.haskell.public === 'build') {
    await addDirectoryStage('haskellWasmPublicDir', paths, stagedPaths, stages, { fileSystem });
  }
}

async function addDirectoryStage(pathName, paths, stagedPaths, stages, { fileSystem, type = 'language' }) {
  const targetPath = paths[pathName];
  const stagePath = await createDirectoryStage(targetPath, { fileSystem });
  stagedPaths[pathName] = stagePath;
  stages.push({ stagePath, targetPath, type });
  return stagePath;
}

async function createNextRuntimeState({
  snapshot,
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
      publicFileIntegrity:
        plan.languages.rust.public === 'build'
          ? await recordOutputIntegrity(stagedPaths.rustWasmPublicDir, { fileSystem })
          : undefined,
      publicFiles:
        plan.languages.rust.public === 'build'
          ? await listRelativeFiles(stagedPaths.rustWasmPublicDir, { fileSystem })
          : undefined,
      sourceFingerprint: desired.rust.sourceFingerprint,
      status: 'ready'
    });
    languages.rust.sources = desired.rust.sources;
    languages.rust.pages = desired.rust.pages;
    languages.rust.buildOptions = desired.rust.buildOptions;
  }
  if (desired.python.cellCount > 0) {
    languages.python = {
      assetFingerprint: desired.python.assetFingerprint,
      sources: desired.python.sources,
      pages: desired.python.pages,
      publicFileIntegrity:
        plan.languages.python.public === 'copy'
          ? await recordOutputIntegrity(stagedPaths.pyodidePublicDir, { fileSystem })
          : state?.languages?.python?.publicFileIntegrity,
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
      publicFileIntegrity:
        plan.languages.haskell.public === 'build'
          ? await recordOutputIntegrity(stagedPaths.haskellWasmPublicDir, { fileSystem })
          : undefined,
      publicFiles:
        plan.languages.haskell.public === 'build'
          ? await listRelativeFiles(stagedPaths.haskellWasmPublicDir, { fileSystem })
          : undefined,
      sourceFingerprint: desired.haskell.sourceFingerprint,
      status: haskellBuildResult.ok ? 'ready' : 'unavailable'
    });
    languages.haskell.sources = desired.haskell.sources;
    languages.haskell.pages = desired.haskell.pages;
  }

  return {
    schemaVersion: 1,
    generationId: snapshot.generationId,
    snapshot,
    manifestFingerprint: desired.manifestFingerprint,
    ready: haskellBuildResult.ok,
    languages,
    ownedOutputs: createRuntimeOwnedOutputs(paths).filter((entry) => desired[entry.language].cellCount > 0)
  };
}

function languageState({
  buildFingerprint,
  mode,
  previous,
  publicAction,
  publicFiles,
  publicFileIntegrity,
  sourceFingerprint,
  status
}) {
  const next = { sourceFingerprint };
  if (publicAction === 'build') {
    return {
      ...next,
      buildFingerprint: artifactBuildFingerprint(buildFingerprint, mode),
      mode,
      publicFiles,
      publicFileIntegrity,
      status
    };
  }
  if (publicAction === 'keep' && previous?.publicFiles?.length > 0) {
    return {
      ...next,
      buildFingerprint: previous.buildFingerprint,
      mode: previous.mode,
      publicFiles: previous.publicFiles,
      publicFileIntegrity: previous.publicFileIntegrity,
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
            generateRuntimeVersionModule(createRuntimeVersion(summary, nextState.generationId)),
            { fileSystem }
          )
        ]
      : [])
  ]);
}

function staleLanguageStages(paths, plan) {
  const targets = [
    [plan.languages.rust.source, paths.rustCellsDir],
    [plan.languages.python.public, paths.pyodidePublicDir],
    [plan.languages.haskell.source, paths.haskellCellsDir],
    [plan.languages.haskell.public, paths.haskellWasmPublicDir]
  ];
  return targets.filter(([action]) => action === 'remove').map(([, targetPath]) => ({ targetPath }));
}

function runtimeResult({ haskellBuildResult, licensesChanged, plan, snapshot, summary }) {
  return {
    ...summary,
    generationId: snapshot.generationId,
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

export async function collectCells(options) {
  const cells = await collectAuthoringCells({ ...options, helperCrates: options.helperCrates ?? new Map() });
  return Promise.all(cells.map((cell) => createCellManifest(cell, options.highlighter)));
}

export async function markRuntimeReady({
  fileSystem = defaultFileSystem,
  paths,
  summary,
  version = createRuntimeVersion(summary)
}) {
  return writeIfChanged(pathFromUrl(paths.runtimeVersionPath), generateRuntimeVersionModule(version), { fileSystem });
}
