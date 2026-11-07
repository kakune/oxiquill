import path from 'node:path';
import {
  createRustGroups,
  generateRustWorkspace,
  generateRustWorkspaceLock,
  readRustHelperClosure
} from './rust-groups.mjs';
import { artifactBuildFingerprint } from './build-inputs.mjs';
import { writeIfChanged, listFiles } from './file-system.mjs';
import { recordedOutputIsComplete, recordOutputIntegrity } from './output-integrity.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';
import { actionReasons, sourceFingerprints } from './plan-reasons.mjs';
import { finalizeRustModule } from './rust-module-assets.mjs';

export async function analyzeRustGroups({
  cells,
  paths,
  helperCrates,
  runtimeInputs,
  fileSystem,
  state,
  mode,
  buildInputs,
  buildOptions,
  toolchain,
  generatorIdentity,
  failures = [],
  force = false
}) {
  const generated = createRustGroups({ cells, paths, helperCrates, runtimeInputs });
  const groups = await Promise.all(
    generated.map(async (group) => {
      const helpers = await readRustHelperClosure({ cells: group.cells, helperCrates, paths, fileSystem });
      const sourceFingerprint = hashText(
        stableFingerprint({ cargo: group.cargo, lib: group.lib, lock: runtimeInputs.rustLockSha256 })
      );
      const desired = {
        cellCount: group.cells.length,
        sourceFingerprint,
        sources: sourceFingerprints(group.cells),
        buildOptions,
        buildFingerprint: stableFingerprint({
          generatorIdentity,
          package: runtimeInputs.package,
          rustBuildInputs: buildInputs,
          helpers: stableFingerprint(helpers.inputs),
          source: sourceFingerprint,
          toolchain: {
            ...toolchain,
            wasmBindgen: toolchain?.wasmBindgen?.identity,
            wasmOpt: toolchain?.wasmOpt?.identity
          }
        })
      };
      const recorded = state?.languages?.rust?.groups?.[group.id];
      const previous = failures.includes(group.id) ? { ...recorded, status: 'failed' } : recorded;
      const sourceMissing = !['Cargo.toml', 'src/lib.rs'].every((name) =>
        fileSystem.existsSync(path.join(group.sourceDir, name))
      );
      const sourceComplete =
        !sourceMissing &&
        (await fileSystem.readFile(path.join(group.sourceDir, 'Cargo.toml'), 'utf8')) === group.cargo &&
        (await fileSystem.readFile(path.join(group.sourceDir, 'src/lib.rs'), 'utf8')) === group.lib;
      const descriptor = state?.rust?.modules.find((entry) => entry.id === group.id);
      const missing =
        !descriptor ||
        !previous?.publicFiles?.length ||
        previous.publicFiles.some((name) => !fileSystem.existsSync(path.join(paths.rustWasmPublicDir, name)));
      const complete =
        Boolean(descriptor) && (await recordedOutputIsComplete(previous, paths.rustWasmPublicDir, fileSystem));
      const source = !force && sourceComplete && previous?.sourceFingerprint === sourceFingerprint ? 'keep' : 'write';
      const current =
        source === 'keep' &&
        previous?.status === 'ready' &&
        complete &&
        previous.buildFingerprint === artifactBuildFingerprint(desired.buildFingerprint, previous.mode) &&
        (mode !== 'build' || previous.mode === 'build');
      const publicAction =
        mode == null ? (source === 'keep' ? 'keep' : 'remove') : current && !force ? 'keep' : 'build';
      return {
        ...group,
        desired,
        helpers,
        previous,
        descriptor,
        source,
        public: publicAction,
        reasons: {
          source: actionReasons({
            action: source,
            desired,
            previous,
            kind: 'source',
            mode,
            forced: force,
            missing: sourceMissing,
            complete: sourceComplete,
            sources: desired.sources
          }),
          public: actionReasons({
            action: publicAction,
            desired,
            previous,
            kind: 'public',
            mode,
            forced: force,
            complete,
            missing,
            sources: desired.sources
          })
        }
      };
    })
  );
  return {
    groups,
    cargo: generateRustWorkspace(groups),
    lock: generateRustWorkspaceLock(
      groups,
      runtimeInputs,
      groups.flatMap((group) => group.helpers.packages)
    )
  };
}

export function applyRustGroupPlan(plan, groupAnalysis, state, mode) {
  const { groups } = groupAnalysis;
  const previousIds = Object.keys(state?.languages?.rust?.groups ?? {});
  const invalid = previousIds.find((id) => !/^page-[a-f0-9]{64}$/u.test(id));
  if (invalid)
    throw new Error(`Invalid Rust group state id ${JSON.stringify(invalid)}; clean the generated runtime and retry.`);
  const removed = previousIds.filter((id) => !groups.some((group) => group.id === id)).sort();
  if (!groups.length) return { ...plan, rustGroups: [], removedRustGroups: removed };
  const source = groups.some((group) => group.source === 'write') || removed.length ? 'write' : 'keep';
  const publicAction =
    mode == null
      ? groups.some((group) => group.public === 'remove')
        ? 'remove'
        : 'keep'
      : groups.some((group) => group.public === 'build') || removed.length
        ? 'build'
        : 'keep';
  const changed = source !== 'keep' || publicAction !== 'keep';
  return {
    ...plan,
    generated: changed ? 'write' : plan.generated,
    hasChanges: changed || plan.hasChanges,
    languages: { ...plan.languages, rust: { source, public: publicAction } },
    rustGroups: groups,
    removedRustGroups: removed
  };
}

export async function prepareRustGroupSources({ analysis, paths, fileSystem, syncRustSupport }) {
  await syncRustSupport({ paths, fileSystem });
  await writeIfChanged(path.join(paths.rustCellsDir, 'Cargo.toml'), analysis.cargo, { fileSystem });
  await writeIfChanged(path.join(paths.rustCellsDir, 'Cargo.lock'), analysis.lock, { fileSystem });
  for (const group of analysis.groups.filter((entry) => entry.source === 'write')) {
    await writeIfChanged(path.join(group.sourceDir, 'Cargo.toml'), group.cargo, { fileSystem });
    await writeIfChanged(path.join(group.sourceDir, 'src/lib.rs'), group.lib, { fileSystem });
  }
}

export async function finalizeRustGroups({ groups, paths, publicPaths, fileSystem, mode }) {
  const modules = [];
  const states = {};
  for (const group of groups) {
    if (group.public === 'build') {
      const directory = path.join(paths.rustWasmPublicDir, group.id);
      const registry = await finalizeRustModule({
        id: group.id,
        cells: group.cells,
        paths: { ...paths, rustWasmPublicDir: directory },
        publicPaths,
        fileSystem
      });
      const integrity = await recordOutputIntegrity(directory, { fileSystem });
      for (const file of await listFiles(directory, { fileSystem })) {
        await fileSystem.rename(file, path.join(paths.rustWasmPublicDir, path.basename(file)));
      }
      await fileSystem.rm(directory, { recursive: true, force: true });
      modules.push(registry.modules[0]);
      const publicFiles = [registry.modules[0].glue, registry.modules[0].wasm]
        .map((asset) => path.basename(asset.url))
        .sort();
      states[group.id] = {
        page: group.page,
        ...group.desired,
        buildFingerprint: artifactBuildFingerprint(group.desired.buildFingerprint, mode),
        mode,
        status: 'ready',
        publicFiles,
        publicFileIntegrity: Object.fromEntries(publicFiles.map((name) => [name, integrity[name]]))
      };
    } else {
      modules.push(group.descriptor);
      states[group.id] = group.previous;
      for (const asset of [group.descriptor.glue, group.descriptor.wasm]) {
        await fileSystem.copyFile(
          path.join(publicPaths.rustWasmPublicDir, path.basename(asset.url)),
          path.join(paths.rustWasmPublicDir, path.basename(asset.url))
        );
      }
    }
  }
  return { registry: { version: 1, modules }, states };
}
