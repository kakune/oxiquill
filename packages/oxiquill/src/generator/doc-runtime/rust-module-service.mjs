import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { retryFileOperation } from './atomic-output.mjs';
import { artifactBuildFingerprint } from './build-inputs.mjs';
import { createFileDigests } from './file-digests.mjs';
import { writeIfChanged } from './file-system.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';
import {
  legacyRustCacheFiles,
  readRustFailures,
  readRustWorkspaceRecords,
  writeRustFailures,
  writeRustWorkspaceRecords
} from './rust-build-records.mjs';
import { formatRustFailure, mapRustCompilerMessages } from './rust-diagnostics.mjs';
import { assignRustGroups, describeRustGroup, rustGroupMode } from './rust-grouping.mjs';
import { createHelperClosureReader } from './rust-helper-closure.mjs';
import { seedWorkspaceLock } from './rust-lock.mjs';
import {
  RUST_SOURCE_FILES,
  RUST_STATE_LAYOUT,
  finalizeRustModulePlan,
  lockClosuresFromLock,
  planRustModules,
  predictRustLockClosures,
  rustBuildRepresentatives,
  seedPreviousPackages
} from './rust-module-plan.mjs';

export async function planRustRuntime({
  cells,
  grouping,
  paths,
  helperCrates,
  runtimeInputs,
  state,
  mode,
  force,
  fileSystem,
  digests,
  generatorIdentity,
  buildInputs,
  buildOptions,
  toolchain,
  tolerateFailures
}) {
  const [records, failures] = await Promise.all([
    readRustWorkspaceRecords({ paths, fileSystem }),
    tolerateFailures && mode === 'dev' ? readRustFailures({ paths, fileSystem }) : {}
  ]);
  const plan = await planRustModules({
    groups: assignRustGroups({ cells, paths, grouping }),
    paths,
    helperCrates,
    runtimeInputs,
    state,
    records,
    failures,
    mode,
    force,
    digests,
    helperReader: createHelperClosureReader({ paths, helperCrates, fileSystem, digest: digests.digest }),
    generatorIdentity,
    buildInputs,
    buildOptions,
    toolchain
  });
  return { ...plan, records, failures, grouping: rustGroupMode(grouping) };
}

export function explainRustPlan(plan, { digests, paths }) {
  return plan.pending
    ? finalizeRustModulePlan(plan, { closures: predictRustLockClosures(plan), digests, paths })
    : plan;
}

// Writes changed module sources, the workspace manifest, and (when its inputs
// changed) a seeded lock that Cargo resolves once. Records are saved as soon as
// files change, so a later build failure never forces regeneration.
export async function prepareRustWorkspace({
  plan,
  paths,
  fileSystem,
  digests,
  syncRustSupport,
  resolveLock,
  runCommand,
  environment,
  events,
  resolve = true
}) {
  const rustCellsDir = pathFromUrl(paths.rustCellsDir);
  const records = { lock: plan.records.lock, modules: { ...plan.records.modules } };
  await fileSystem.mkdir(rustCellsDir, { recursive: true });
  await Promise.all([
    ...['src', 'pages'].map((name) => fileSystem.rm(path.join(rustCellsDir, name), { recursive: true, force: true })),
    ...legacyRustCacheFiles(paths).map((file) => fileSystem.rm(file, { force: true })),
    syncRustSupport({ fileSystem, paths })
  ]);
  for (const id of plan.staleSources) {
    await retryFileOperation(() =>
      fileSystem.rm(path.join(rustCellsDir, 'modules', id), { recursive: true, force: true })
    );
    delete records.modules[id];
  }
  for (const group of plan.groups) {
    if (group.source === 'write') {
      const files = {};
      for (const name of RUST_SOURCE_FILES) {
        const file = path.join(group.sourceDir, name);
        await writeIfChanged(file, group.generated.files[name], { fileSystem });
        files[name] = digests.describe(file, Buffer.from(group.generated.files[name]));
      }
      records.modules[group.id] = {
        inputFingerprint: group.inputFingerprint,
        sourceFingerprint: group.sourceFingerprint,
        files
      };
    } else if (group.generated) await refreshSourceMap(group, records, { digests, fileSystem });
  }
  if (plan.workspace.action === 'keep') {
    await writeRustWorkspaceRecords({ paths, fileSystem, records });
    return plan;
  }
  const manifestPath = path.join(rustCellsDir, 'Cargo.toml');
  const lockPath = path.join(rustCellsDir, 'Cargo.lock');
  await writeIfChanged(manifestPath, plan.workspace.manifest, { fileSystem });
  let previous = [];
  try {
    previous = seedPreviousPackages(String(await fileSystem.readFile(lockPath, 'utf8')));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const seed = seedWorkspaceLock({
    runtime: plan.workspace.runtime,
    helpers: plan.workspace.helperPackages,
    previous
  });
  await writeIfChanged(lockPath, seed, { fileSystem });
  records.lock = {
    inputFingerprint: plan.workspace.lockInputFingerprint,
    pending: true,
    files: {
      'Cargo.toml': digests.describe(manifestPath, Buffer.from(plan.workspace.manifest)),
      'Cargo.lock': digests.describe(lockPath, Buffer.from(seed))
    }
  };
  await writeRustWorkspaceRecords({ paths, fileSystem, records });
  if (!resolve) return { ...plan, pending: true };
  await events.phase('generation', { language: 'rust' }, () => resolveLock({ paths, environment, runCommand, events }));
  const lockBytes = await fileSystem.readFile(lockPath);
  const closures = lockClosuresFromLock(plan, String(lockBytes));
  records.lock = {
    inputFingerprint: plan.workspace.lockInputFingerprint,
    files: {
      'Cargo.toml': digests.describe(manifestPath, Buffer.from(plan.workspace.manifest)),
      'Cargo.lock': digests.describe(lockPath, Buffer.from(lockBytes))
    },
    closures
  };
  await writeRustWorkspaceRecords({ paths, fileSystem, records });
  return finalizeRustModulePlan(plan, { closures, digests, paths });
}

async function refreshSourceMap(group, records, { digests, fileSystem }) {
  const record = { ...records.modules[group.id], inputFingerprint: group.inputFingerprint };
  if (group.mapUpdate) {
    const file = path.join(group.sourceDir, 'source-map.json');
    await writeIfChanged(file, group.generated.files['source-map.json'], { fileSystem });
    record.files = {
      ...record.files,
      'source-map.json': digests.describe(file, Buffer.from(group.generated.files['source-map.json']))
    };
  }
  records.modules[group.id] = record;
}

// Keeps source maps and input fingerprints current when nothing else changed.
export async function refreshRustSourceRecords({ plan, paths, fileSystem, digests }) {
  const groups = plan.groups.filter((group) => group.generated && group.source === 'keep');
  if (!groups.length) return;
  const records = { lock: plan.records.lock, modules: { ...plan.records.modules } };
  for (const group of groups) await refreshSourceMap(group, records, { digests, fileSystem });
  await writeRustWorkspaceRecords({ paths, fileSystem, records });
}

export function rustBuildSelection(plan) {
  return {
    stale: plan.groups.filter((group) => group.public === 'build'),
    representatives: rustBuildRepresentatives(plan),
    exclude: plan.groups.filter((group) => group.public === 'failed').map((group) => group.packageName)
  };
}

async function loadSourceMap(group, fileSystem) {
  if (group.generated) return group.generated.sourceMap;
  try {
    const map = JSON.parse(await fileSystem.readFile(path.join(group.sourceDir, 'source-map.json'), 'utf8'));
    const file = path.join(group.sourceDir, 'src/lib.rs');
    const text = String(await fileSystem.readFile(file, 'utf8'));
    return map?.version === 1 && map.libSha256 === hashText(text) && Array.isArray(map.regions)
      ? { text, regions: map.regions, file, crateDir: group.sourceDir }
      : undefined;
  } catch {
    return undefined;
  }
}

// Failures from a build: messages of helper or dependency crates are attached to
// failed groups that have no messages of their own.
export function rustBuildFailures(result) {
  const dependencyMessages = result.dependencyMessages.map((entry) => entry.message);
  return result.results
    .filter((entry) => !entry.ok)
    .map((entry) => ({
      group: entry.group,
      kind: entry.kind,
      ownMessages: entry.messages,
      dependencyMessages: entry.messages.length ? [] : dependencyMessages,
      error: entry.error
    }));
}

// Maps raw compiler messages through the group's current source map, so replayed
// failures follow prose edits that moved the cell.
export async function describeRustFailures({ failures, paths, fileSystem }) {
  return Promise.all(
    failures.map(async (failure) => {
      const sourceMap = await loadSourceMap(failure.group, fileSystem);
      const messages = failure.ownMessages.length ? failure.ownMessages : failure.dependencyMessages;
      const mapped = await mapRustCompilerMessages({
        messages,
        files: sourceMap ? [sourceMap] : [],
        paths,
        fileSystem
      });
      return { ...failure, ...mapped };
    })
  );
}

export function rustFailureError(failures) {
  const original = failures.find((failure) => failure.error)?.error;
  const message = failures
    .map(
      (failure) =>
        `Rust module ${describeRustGroup(failure.group)} failed:\n${formatRustFailure({
          diagnostics: failure.diagnostics,
          unmapped: failure.unmapped,
          original: failure.error?.message ?? String(failure.error ?? 'unknown failure')
        })}`
    )
    .join('\n\n');
  const error = new Error(message, original ? { cause: original } : undefined);
  error.exitCode = failures.map((failure) => failure.error?.exitCode).find((code) => Number.isInteger(code)) ?? 1;
  error.rustDiagnostics = failures.flatMap((failure) => failure.diagnostics);
  error.rustModules = failures.map((failure) => ({ id: failure.group.id, pages: failure.group.pages }));
  return error;
}

export function nextRustFailureMemo({ plan, failures, mode }) {
  const next = {};
  for (const group of plan.groups) {
    const failure = failures.find((entry) => entry.group.id === group.id);
    if (group.public === 'failed' && plan.failures[group.id]) next[group.id] = plan.failures[group.id];
    else if (failure && ['compile', 'dependency'].includes(failure.kind))
      next[group.id] = {
        fingerprint: artifactBuildFingerprint(group.buildFingerprint, mode),
        kind: failure.kind,
        messages: failure.ownMessages,
        dependencyMessages: failure.dependencyMessages,
        error: failure.error?.message ?? '',
        exitCode: failure.error?.exitCode ?? 101
      };
  }
  return next;
}

export function memoizedRustFailures(plan) {
  return plan.groups
    .filter((group) => group.public === 'failed')
    .map((group) => {
      const memo = plan.failures[group.id];
      const error = new Error(memo.error || `Rust module ${group.id} failed previously.`);
      error.exitCode = memo.exitCode;
      return {
        group,
        kind: memo.kind,
        ownMessages: memo.messages ?? [],
        dependencyMessages: memo.dependencyMessages ?? [],
        error
      };
    });
}

export function rustLanguageState({ plan, outcomes, mode, sources, pages, buildOptions }) {
  const groups = {};
  for (const group of plan.groups) {
    const outcome = outcomes.get(group.id);
    const base = { mode: group.mode, key: group.key, pages: group.pages };
    if (outcome?.status === 'built')
      groups[group.id] = {
        ...base,
        sourceFingerprint: group.sourceFingerprint,
        sources: group.sources,
        buildFingerprint: artifactBuildFingerprint(group.buildFingerprint, mode),
        buildMode: mode,
        buildOptions,
        publicFiles: outcome.files
      };
    else if (outcome?.status === 'kept' || outcome?.status === 'retained')
      groups[group.id] = { ...group.previous, ...(outcome.status === 'kept' ? base : {}) };
  }
  return { layout: RUST_STATE_LAYOUT, grouping: plan.grouping, sources, pages, buildOptions, groups };
}

// Production verifies helper closures again after compilation, reading every
// helper crate once.
export async function assertRustHelperInputs({ plan, paths, helperCrates, fileSystem, mode }) {
  const reader = createHelperClosureReader({
    paths,
    helperCrates,
    fileSystem,
    digest: createFileDigests({ fileSystem, mode: 'build' }).digest
  });
  for (const group of plan.groups) {
    let current;
    try {
      current = await reader.closure(group.crates);
    } catch (cause) {
      throw new Error(`Rust module ${describeRustGroup(group)} helper inputs could not be verified: ${cause.message}`, {
        cause
      });
    }
    if (stableFingerprint(current.inputs) !== stableFingerprint(group.helpers.inputs))
      throw new Error(
        `Rust module ${describeRustGroup(group)} helper inputs changed during ${mode === 'build' ? 'the build' : 'generation'}. Rerun after the sources settle.`
      );
  }
}

export { writeRustFailures };
