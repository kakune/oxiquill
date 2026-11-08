import path from 'node:path';
import { createHighlighter } from 'shiki';
import { writeDevDiagnostics } from './doc-runtime/dev-diagnostics.mjs';
import { isDefinitionsBlock } from '../lib/doc-runtime/rust-definitions.mjs';
import { runProcess } from './doc-runtime/process-runner.mjs';
import { createRuntimeEvents } from './doc-runtime/runtime-events.mjs';
import { explainRuntimePlan, pageSourceFingerprints, sourceFingerprints } from './doc-runtime/plan-reasons.mjs';
import { parseGeneratedCellManifest } from './doc-runtime/cell-manifest.mjs';
import { validateRustRegistry } from '../lib/doc-runtime/rust-registry.mjs';
import {
  artifactBuildFingerprint,
  getGeneratorIdentity,
  readRustBuildInputs,
  readRustBuildOptionDigests
} from './doc-runtime/build-inputs.mjs';
import { recordedOutputIsComplete, recordOutputIntegrity } from './doc-runtime/output-integrity.mjs';
import { createOxiquillPaths, pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { defaultRustOptions } from '../config/metadata.mjs';
import {
  createCellManifest,
  generateCellsJson,
  generateCellsModule,
  generateHaskellMain,
  parseCellsFromMarkdown,
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
import { hashBytes, hashText, stableFingerprint } from './doc-runtime/hashing.mjs';
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
import { buildHaskellWasm as defaultBuildHaskellWasm } from './doc-runtime/wasm-build.mjs';
import { buildRustModules as defaultBuildRustModules } from './doc-runtime/rust-module-build.mjs';
import { resolveWorkspaceLock } from './doc-runtime/rust-lock.mjs';
import { createFileDigests } from './doc-runtime/file-digests.mjs';
import { rustPlanActions } from './doc-runtime/rust-module-plan.mjs';
import {
  assertRustHelperInputs,
  describeRustFailures,
  explainRustPlan,
  memoizedRustFailures,
  nextRustFailureMemo,
  planRustRuntime,
  prepareRustWorkspace,
  refreshRustSourceRecords,
  rustBuildFailures,
  rustBuildSelection,
  rustFailureError,
  rustLanguageState,
  writeRustFailures
} from './doc-runtime/rust-module-service.mjs';
import { composeRustManifest, failedRustBlocks } from './doc-runtime/rust-manifest-compose.mjs';
import {
  collectRustModuleGarbage,
  installRustModuleFiles,
  referencedRustFiles
} from './doc-runtime/rust-module-publish.mjs';
import { finalizeRustModuleOutput, rustModulePublicPath } from './doc-runtime/rust-module-assets.mjs';
import { toolchainProbeKey } from './doc-runtime/runtime-session.mjs';
import { reusePreviousHighlights, sourceHighlightFingerprint } from './doc-runtime/source-highlights.mjs';

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
export { buildRustModules } from './doc-runtime/rust-module-build.mjs';
export { createRuntimeSession } from './doc-runtime/runtime-session.mjs';
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
  rustOptions = defaultRustOptions,
  readManifests,
  readRuntimeInputs = defaultReadRuntimeInputs,
  root = process.cwd(),
  session
} = {}) {
  const paths = providedPaths ?? createDocRuntimePaths({ workspaceRoot: root, ...pathOptions });
  const resolvedHighlighter =
    highlighter ??
    (await createHighlighter({
      langs: ['rust', 'python', 'haskell'],
      themes: Object.values(sourceThemes)
    }));
  return {
    highlighter: session ? session.highlighter(resolvedHighlighter) : resolvedHighlighter,
    paths,
    pythonOptions,
    rustOptions,
    helperCrates: await listHelperCrates({ fileSystem, paths, readManifests }),
    runtimeInputs: await readRuntimeInputs({ fileSystem, paths }),
    ...(session ? { session } : {})
  };
}

async function toolchainFiles({ fileSystem, paths }) {
  return Promise.all(
    ['rust-toolchain', 'rust-toolchain.toml'].map(async (name) => {
      try {
        return [name, hashBytes(await fileSystem.readFile(pathInUrl(paths.workspaceRoot, name)))];
      } catch (error) {
        if (error?.code === 'ENOENT') return [name, null];
        throw error;
      }
    })
  );
}

export async function syncDocRuntime({
  buildHaskell = defaultBuildHaskellWasm,
  buildRust = defaultBuildRustModules,
  resolveRustLock = resolveWorkspaceLock,
  explain = false,
  events = createRuntimeEvents(),
  format = 'human',
  runCommand = runProcess,
  rustOptions = defaultRustOptions,
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
  session,
  syncLicenses = defaultSyncLicenseArtifacts,
  syncPyodide = defaultCopyPyodideAssets,
  syncRustSupport = syncRustBuildSupportFiles,
  tolerateHaskellBuildFailure = false,
  tolerateRustModuleFailures = false,
  trackChild
}) {
  session?.beginSync();
  try {
    return await syncRuntime();
  } finally {
    session?.endSync();
  }

  async function syncRuntime() {
    const digests = createFileDigests({ fileSystem, mode });
    const snapshotOptions = {
      fileSystem,
      paths,
      pythonOptions,
      ...(session ? { parsePage: session.parsePage(parseCellsFromMarkdown) } : {})
    };
    const [content, helpers] = await Promise.all([
      collectAuthoringContent({ ...snapshotOptions, helperCrates, events }),
      readHelperInputs({ ...snapshotOptions, digest: digests.digest })
    ]);
    const authoringCells = content.cells;
    const snapshot = createGenerationSnapshot(authoringCells, helpers, content.pages);
    const [identity, state, previousManifest] = await Promise.all([
      generatorIdentity(),
      readRuntimeOwnership({ fileSystem, paths }),
      readGeneratedManifest({ fileSystem, paths })
    ]);
    const highlightFingerprint = await sourceHighlightFingerprint({ generatorIdentity: identity });
    const blockHighlighter = reusePreviousHighlights({
      highlighter,
      previousManifest,
      reusable: state?.highlightFingerprint === highlightFingerprint
    });
    const allBlocks = await Promise.all(authoringCells.map((cell) => createCellManifest(cell, blockHighlighter)));
    const definitions = allBlocks.filter(isDefinitionsBlock);
    const cells = allBlocks.filter((cell) => !isDefinitionsBlock(cell));
    const haskellCells = cells.filter((cell) => cell.language === 'haskell');
    const pythonCells = cells.filter((cell) => cell.language === 'python');
    const rustCells = authoringCells.filter((cell) => cell.language === 'rust' && !isDefinitionsBlock(cell));
    const summary = summarizeCells(allBlocks);
    const requestedPythonPackages = summary.pythonPackages;
    const processOptions = { events, format, trackChild };
    const execute = (command, args, options) => runCommand(command, args, { ...processOptions, ...options });
    const preflightOptions = {
      explain,
      paths,
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
    };
    const probe = () => preflightToolchains(preflightOptions);
    const toolchains = await (
      session && mode !== undefined && !explain
        ? session.toolchain(
            toolchainProbeKey({
              environment,
              toolchainFiles: await toolchainFiles({ fileSystem, paths }),
              flags: {
                mode,
                rust: rustCells.length > 0,
                haskell: haskellCells.length > 0,
                tolerateHaskellBuildFailure
              }
            }),
            probe
          )
        : probe()
    ).catch((error) => {
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
      haskellOutput: generateHaskellOutput()
    };
    const rustBuildInputs =
      rustCells.length > 0 ? await readRustBuildInputs({ environment, fileSystem, paths }) : undefined;
    const buildOptions =
      rustCells.length > 0 ? await readRustBuildOptionDigests({ environment, fileSystem, paths }) : {};
    let rustPlan =
      rustCells.length > 0
        ? await events.phase('validation', { language: 'rust' }, () =>
            planRustRuntime({
              cells: rustCells,
              grouping: rustOptions.grouping,
              paths,
              helperCrates,
              runtimeInputs,
              state,
              mode,
              force: forceRustBuild,
              fileSystem,
              digests,
              generatorIdentity: identity,
              buildInputs: rustBuildInputs,
              buildOptions,
              toolchain: toolchains.rust,
              tolerateFailures: tolerateRustModuleFailures
            })
          )
        : undefined;
    let desired = createDesiredRuntime({
      snapshot,
      generatorIdentity: identity,
      generated,
      pythonCellCount: pythonCells.length,
      pyodideRuntimeInputs,
      runtimeInputs,
      summary,
      toolchains
    });
    desired = {
      ...desired,
      ...Object.fromEntries(
        ['rust', 'haskell', 'python'].map((language) => [
          language,
          {
            ...desired[language],
            sources: sourceFingerprints(
              language === 'rust' ? rustCells : cells.filter((cell) => cell.language === language)
            ),
            ...(language === 'rust' ? { buildOptions } : {})
          }
        ])
      )
    };
    for (const language of ['rust', 'python', 'haskell'])
      desired[language].pages = pageSourceFingerprints(desired[language].sources);
    const { outputComplete, outputPresent, outputMissing } = await runtimeOutputState({
      fileSystem,
      mode,
      paths,
      state,
      manifest: previousManifest
    });
    const planOptions = { desired, forceRustBuild, mode, outputComplete, outputPresent, state };
    const languagePlan = (rust) => createRuntimePlan({ ...planOptions, rust: rust && rustPlanActions(rust) });
    if (explain && rustPlan) rustPlan = await explainRustPlan(rustPlan, { digests, paths });
    let plan = languagePlan(rustPlan);
    const metadataUpgrade =
      state &&
      ['python', 'haskell'].some(
        (language) =>
          desired[language].cellCount > 0 && (!state.languages[language]?.sources || !state.languages[language]?.pages)
      );
    if (metadataUpgrade) {
      plan = { ...plan, generated: 'write', hasChanges: true };
      events.report({ type: 'diagnostic', message: 'Stored page and cell source fingerprints need updating.' });
    } else if (state && state.highlightFingerprint !== highlightFingerprint) {
      // Records the highlighter identity so later runs can reuse unchanged sources.
      plan = { ...plan, generated: 'write', hasChanges: true };
    }
    const reportPlan = () => {
      const reasons = explainRuntimePlan({
        plan,
        desired,
        state,
        mode,
        outputComplete,
        outputMissing,
        forceRustBuild
      });
      if (rustPlan && !rustPlan.pending)
        for (const target of ['source', 'public']) {
          const entries = rustPlan.groups.flatMap((group) => group.reasons[target]);
          if (entries.length)
            reasons.rust[target] = [...new Map(entries.map((reason) => [JSON.stringify(reason), reason])).values()];
        }
      plan = {
        ...plan,
        reasons,
        rustGroups: rustPlan?.groups ?? [],
        removedRustGroups: rustPlan?.removed ?? []
      };
      for (const [language, actions] of Object.entries(plan.languages)) {
        for (const [target, action] of Object.entries(actions))
          events.report({ type: 'plan', language, target, action, reasons: reasons[language][target] });
      }
      for (const group of rustPlan?.pending ? [] : (rustPlan?.groups ?? [])) {
        for (const target of ['source', 'public'])
          events.report({
            type: 'plan',
            language: 'rust',
            module: group.id,
            key: group.key,
            pages: group.pages,
            target,
            action: group[target] === 'failed' ? 'keep' : group[target],
            reasons: group.reasons[target]
          });
      }
      for (const id of rustPlan?.removed ?? [])
        events.report({
          type: 'plan',
          language: 'rust',
          module: id,
          pages: state.languages.rust.groups[id]?.pages ?? [],
          action: 'remove',
          reasons: [{ code: 'source-changed', changes: [] }]
        });
    };
    const assertInputs = () =>
      events.phase('validation', {}, async () => {
        if (mode === 'build') await assertGenerationSnapshot(snapshot, snapshotOptions);
        if (rustPlan) await assertRustHelperInputs({ plan: rustPlan, paths, helperCrates, fileSystem, mode });
      });
    if (explain) {
      reportPlan();
      for (const phase of ['generation', 'compile', 'optimize', 'publish'])
        events.skipped(phase, { reason: 'explain' });
      return runtimeResult({ plan, snapshot, summary });
    }

    if (!plan.hasChanges) {
      reportPlan();
      if (rustPlan) await refreshRustSourceRecords({ plan: rustPlan, paths, fileSystem, digests });
      // A memoized development failure keeps its diagnostics until its inputs change.
      if (mode === 'dev' && !rustPlan?.groups.some((group) => group.public === 'failed'))
        await writeDevDiagnostics({ paths, fileSystem });
      for (const phase of ['generation', 'compile', 'optimize', 'publish']) events.skipped(phase, { cache: 'hit' });
      const licensesChanged = await syncLicenses({
        fileSystem,
        includeRustBuildFiles: false,
        paths,
        pythonOptions
      });
      if (mode === 'build' || rustPlan) await assertInputs();
      return runtimeResult({ licensesChanged, plan, snapshot, summary });
    }

    const stages = [];
    let haskellBuildResult = { ok: true };
    let installedRustFiles = [];
    let published = false;

    try {
      const stagedPaths = { ...paths };
      await events.phase('generation', {}, async () => {
        if (rustPlan && (plan.languages.rust.source !== 'keep' || plan.languages.rust.public !== 'keep')) {
          rustPlan = await prepareRustWorkspace({
            plan: rustPlan,
            paths,
            fileSystem,
            digests,
            syncRustSupport,
            resolveLock: resolveRustLock,
            runCommand: execute,
            environment,
            events,
            resolve: mode !== undefined
          });
          plan = languagePlan(rustPlan);
        }
        await stageLanguageOutputs({
          fileSystem,
          paths,
          plan,
          pyodideRuntimeInputs,
          pythonOptions,
          requestedPythonPackages,
          stagedPaths,
          stages,
          syncPyodide,
          generated
        });
      });
      reportPlan();

      let rustStage;
      let rustResult;
      if (rustPlan && !rustPlan.pending && plan.languages.rust.public === 'build') {
        const selection = rustBuildSelection(rustPlan);
        if (selection.stale.length) {
          rustStage = await createDirectoryStage(paths.rustWasmPublicDir, { fileSystem });
          stages.push({ stagePath: rustStage, targetPath: paths.rustWasmPublicDir, type: 'rust-assets' });
          const publicPath = rustModulePublicPath(paths);
          rustResult = await buildRust({
            groups: selection.stale,
            members: rustPlan.groups,
            representatives: selection.representatives,
            exclude: selection.exclude,
            paths,
            stageDir: path.join(rustStage, '.bindgen'),
            mode,
            toolchain: toolchains.rust,
            finalize: (group, directory) =>
              finalizeRustModuleOutput({
                id: group.id,
                cells: group.cells,
                directory,
                outputDirectory: rustStage,
                publicPath,
                fileSystem
              }),
            environment,
            fileSystem,
            runCommand: execute,
            events,
            format
          });
        } else {
          events.skipped('compile', { language: 'rust', cache: 'hit' });
          events.skipped('optimize', { language: 'rust', cache: 'hit' });
        }
      } else if (rustPlan) {
        events.skipped('compile', { language: 'rust', cache: 'hit' });
        events.skipped('optimize', { language: 'rust', reason: mode === 'build' ? 'cache-hit' : 'dev' });
      }
      const rustFailures = rustPlan
        ? await describeRustFailures({
            failures: [...(rustResult ? rustBuildFailures(rustResult) : []), ...memoizedRustFailures(rustPlan)],
            paths,
            fileSystem
          })
        : [];
      const tolerated = tolerateRustModuleFailures && mode === 'dev';
      if (rustFailures.length && mode === 'dev')
        await writeDevDiagnostics({
          paths,
          fileSystem,
          diagnostics: rustFailures.flatMap((failure) => failure.diagnostics),
          blocks: failedRustBlocks(
            allBlocks,
            rustFailures.map((failure) => ({ ...failure.group, status: 'failed' }))
          )
        }).catch(() => {});
      if (tolerated && rustPlan)
        await writeRustFailures({
          paths,
          fileSystem,
          failures: nextRustFailureMemo({ plan: rustPlan, failures: rustFailures, mode })
        });
      if (rustFailures.length && !tolerated) throw rustFailureError(rustFailures);

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

      const composed = rustPlan ? await composeRust({ rustPlan, rustResult, rustFailures }) : undefined;
      const rust = composed?.registry;
      const publishedCells = composed?.cells ?? cells;
      const publishedDefinitions = composed?.definitions ?? definitions;
      if (rust) validateRustRegistry(rust, publishedCells);
      generated.cellsJson = generateCellsJson(
        publishedCells,
        snapshot.generationId,
        rust ?? (rustCells.length === 0 ? { version: 1, modules: [] } : undefined),
        publishedDefinitions
      );
      generated.cellsModule = generateCellsModule(publishedCells, snapshot.generationId, rust, publishedDefinitions);
      const nextState = await createNextRuntimeState({
        highlightFingerprint,
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
      if (composed?.languageState) nextState.languages.rust = composed.languageState;
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
      const installRust = rustStage && composed?.installFiles && plan.languages.rust.public !== 'remove';
      const licensesChanged = await syncLicenses({
        fileSystem,
        includeRustBuildFiles: false,
        // New modules are still staged; kept modules are already published.
        paths: installRust ? { ...stagedPaths, rustWasmPublicDir: rustStage } : stagedPaths,
        pythonOptions
      });
      await assertInputs();
      // Immutable, content-addressed assets are installed before the registry that
      // references them; files of the previous registry stay until publication.
      if (installRust)
        installedRustFiles = await installRustModuleFiles({
          stageDir: rustStage,
          targetDir: paths.rustWasmPublicDir,
          files: composed.installFiles,
          digests,
          fileSystem
        });
      await events.phase('publish', {}, () =>
        publishDirectoryStages(
          [
            ...stages.filter(({ type, targetPath }) => type === 'language' && targetPath !== paths.rustWasmPublicDir),
            ...staleLanguageStages(paths, plan),
            { stagePath: generatedStage, targetPath: paths.generatedDir }
          ],
          { fileSystem, onPublished: () => (published = true) }
        )
      );
      if (mode === 'dev' && !rustFailures.length) await writeDevDiagnostics({ paths, fileSystem });
      if (rustPlan && plan.languages.rust.public !== 'remove')
        await collectRustModuleGarbage({
          targetDir: paths.rustWasmPublicDir,
          referenced: referencedRustFiles(rust),
          fileSystem,
          events
        });
      return runtimeResult({
        haskellBuildResult,
        licensesChanged,
        plan,
        snapshot,
        summary,
        ...(rustFailures.length ? { rustBuildResult: { ok: false, error: rustFailureError(rustFailures) } } : {})
      });
    } finally {
      // Files installed for a registry that was never published are not referenced.
      if (!published) await Promise.all(installedRustFiles.map((file) => fileSystem.rm(file, { force: true })));
      await Promise.all(stages.map(({ stagePath }) => discardDirectoryStage(stagePath, { fileSystem })));
    }

    async function composeRust({ rustPlan: rustModules, rustResult: result, rustFailures: failures }) {
      if (plan.languages.rust.public === 'remove' || rustModules.pending) return undefined;
      const built = new Map(
        (result?.results ?? []).filter((entry) => entry.ok).map((entry) => [entry.group.id, entry.value])
      );
      const failed = new Set(failures.map((failure) => failure.group.id));
      // A failing group keeps its last working module only while that module's files exist.
      const intact = new Set(rustModules.groups.filter((group) => group.previousComplete).map((group) => group.id));
      const previousModules = new Map(
        (state?.rust?.modules ?? []).filter((module) => intact.has(module.id)).map((module) => [module.id, module])
      );
      const groups = rustModules.groups.map((group) => {
        if (built.has(group.id)) return { ...group, status: 'built', module: built.get(group.id).module };
        if (failed.has(group.id)) return { ...group, status: 'failed' };
        return { ...group, status: 'kept', module: group.descriptor };
      });
      const composition = composeRustManifest({
        cells,
        definitions,
        groups,
        previousManifest,
        previousModules
      });
      const outcomes = new Map(
        groups.map((group) => [
          group.id,
          group.status === 'built'
            ? { status: 'built', files: built.get(group.id).files }
            : group.status === 'kept'
              ? { status: 'kept' }
              : { status: composition.retained.includes(group.id) ? 'retained' : 'failed' }
        ])
      );
      return {
        ...composition,
        installFiles: Object.assign({}, ...[...built.values()].map((value) => value.files)),
        languageState: rustLanguageState({
          plan: rustModules,
          outcomes,
          mode,
          sources: desired.rust.sources,
          pages: desired.rust.pages,
          buildOptions
        })
      };
    }
  }
}

async function readGeneratedManifest({ fileSystem, paths }) {
  try {
    return parseGeneratedCellManifest(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }
}

function createDesiredRuntime({
  snapshot,
  generatorIdentity,
  generated,
  pythonCellCount,
  pyodideRuntimeInputs,
  runtimeInputs,
  summary,
  toolchains
}) {
  const haskellSourceFingerprint = hashText(stableFingerprint([generated.haskellMain, generated.haskellOutput]));
  const pythonAssetFingerprint = pythonCellCount > 0 ? pyodideRuntimeInputs.fingerprint : stableFingerprint([]);

  return Object.freeze({
    generationId: snapshot.generationId,
    referenceId: snapshot.referenceId,
    referenceSnapshotFingerprint: hashText(stableFingerprint(snapshot.pages)),
    manifestFingerprint: summary.manifestFingerprint,
    rust: Object.freeze({ cellCount: summary.rustCellCount }),
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

async function runtimeOutputState({ fileSystem, mode, paths, state, manifest }) {
  if (manifest?.rust) validateRustRegistry(manifest.rust, manifest.cells);
  const registryCurrent = !state?.rust || stableFingerprint(state.rust) === stableFingerprint(manifest?.rust);
  const outputPresent = {
    generated: fileSystem.existsSync(paths.generatedDir),
    rustSource: fileSystem.existsSync(paths.rustCellsDir),
    rustPublic:
      fileSystem.existsSync(paths.rustWasmPublicDir) &&
      (!state || Boolean(state.rust?.modules?.length || state.languages?.rust?.publicFiles?.length)),
    pythonPublic: fileSystem.existsSync(paths.pyodidePublicDir),
    haskellSource: fileSystem.existsSync(paths.haskellCellsDir),
    haskellPublic: fileSystem.existsSync(paths.haskellWasmPublicDir)
  };
  return {
    outputPresent,
    outputMissing: Object.fromEntries(
      ['python', 'haskell'].flatMap((language) => {
        const directory = language === 'python' ? paths.pyodidePublicDir : paths.haskellWasmPublicDir;
        const files = state?.languages?.[language]?.publicFiles;
        return [
          [`${language}Source`, !outputPresent[`${language}Source`]],
          [
            `${language}Public`,
            !files?.length || files.some((name) => !fileSystem.existsSync(path.join(directory, name)))
          ]
        ];
      })
    ),
    outputComplete: {
      generated:
        Boolean(state) &&
        registryCurrent &&
        fileSystem.existsSync(paths.cellsModulePath) &&
        fileSystem.existsSync(paths.cellsJsonPath) &&
        fileSystem.existsSync(paths.runtimeOwnershipPath) &&
        (state.ready === false || fileSystem.existsSync(paths.runtimeVersionPath)),
      pythonPublic: await recordedOutputIsComplete(state?.languages?.python, paths.pyodidePublicDir, fileSystem, {
        mode
      }),
      haskellSource:
        outputPresent.haskellSource &&
        ['Main.hs', 'Oxiquill/Output.hs'].every((file) =>
          fileSystem.existsSync(pathInUrl(paths.haskellCellsDir, file))
        ),
      haskellPublic: await recordedOutputIsComplete(state?.languages?.haskell, paths.haskellWasmPublicDir, fileSystem, {
        mode
      })
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
  syncPyodide
}) {
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
  highlightFingerprint,
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
    highlightFingerprint,
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
    [plan.languages.rust.public, paths.rustWasmPublicDir],
    [plan.languages.python.public, paths.pyodidePublicDir],
    [plan.languages.haskell.source, paths.haskellCellsDir],
    [plan.languages.haskell.public, paths.haskellWasmPublicDir]
  ];
  return targets.filter(([action]) => action === 'remove').map(([, targetPath]) => ({ targetPath }));
}

function runtimeResult({ haskellBuildResult, licensesChanged, plan, rustBuildResult, snapshot, summary }) {
  return {
    ...summary,
    generationId: snapshot.generationId,
    cellsChanged: plan.generated === 'write',
    haskellChanged: plan.languages.haskell.source !== 'keep',
    haskellBuildResult,
    ...(rustBuildResult ? { rustBuildResult } : {}),
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
