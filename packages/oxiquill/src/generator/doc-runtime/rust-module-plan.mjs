import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { artifactBuildFingerprint } from './build-inputs.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';
import { actionReasons, sourceFingerprints } from './plan-reasons.mjs';
import { normalizePath } from './path-utils.mjs';
import { RUST_GROUP_ID_PATTERN } from './rust-build-records.mjs';
import { generateRustCargoToml } from './rust-codegen/cargo.mjs';
import { generateRustLibMapped } from './rust-codegen/lib.mjs';
import { compareText } from './rust-grouping.mjs';
import {
  groupLockClosure,
  lockClosureDigest,
  lockPackageKey,
  parseLock,
  runtimeLockClosure,
  semverCompatibility
} from './rust-lock.mjs';

export const RUST_STATE_LAYOUT = 2;
export const RUST_SOURCE_FILES = Object.freeze(['Cargo.toml', 'src/lib.rs', 'source-map.json']);

export function generateRustWorkspaceManifest(groups) {
  const members = groups.map((group) => `modules/${group.id}`).sort(compareText);
  return `[workspace]\nmembers = ${JSON.stringify(members)}\nresolver = "3"\n`;
}

// Source maps keep regions and the lib.rs digest; the text is read back only
// when a compiler error must be mapped.
export function generateRustModuleSources(group, { helperCrates, paths, runtimeInputs }) {
  const rustCellsDir = pathFromUrl(paths.rustCellsDir);
  const helpers = new Map(
    [...helperCrates].map(([name, info]) => [
      name,
      {
        ...info,
        relativePath: normalizePath(path.relative(group.sourceDir, path.resolve(rustCellsDir, info.relativePath)))
      }
    ])
  );
  const cargo = generateRustCargoToml(group.cells, helpers, runtimeInputs, { packageName: group.packageName });
  const mapped = generateRustLibMapped(group.cells);
  const sourceMap = `${JSON.stringify({ version: 1, libSha256: hashText(mapped.text), regions: mapped.regions })}\n`;
  return Object.freeze({
    files: Object.freeze({ 'Cargo.toml': cargo, 'src/lib.rs': mapped.text, 'source-map.json': sourceMap }),
    sourceFingerprint: hashText(stableFingerprint({ cargo, lib: mapped.text })),
    sourceMap: Object.freeze({
      text: mapped.text,
      regions: mapped.regions,
      file: path.join(group.sourceDir, 'src/lib.rs'),
      crateDir: group.sourceDir
    })
  });
}

// Includes authored positions: a prose edit regenerates the group's source map
// while lib.rs, and therefore the build, stays unchanged.
export function rustGroupInputFingerprint(group, { generatorIdentity, helperCrates, runtimeInputs }) {
  const crates = [...new Set(group.cells.flatMap((cell) => cell.crates ?? []))].sort(compareText);
  return hashText(
    stableFingerprint({
      generatorIdentity,
      id: group.id,
      cells: group.cells,
      helpers: crates.map((name) => [name, helperCrates.get(name)?.relativePath ?? null]),
      package: runtimeInputs.package,
      rust: runtimeInputs.rust
    })
  );
}

export function publishedRustState(state) {
  const rust = state?.languages?.rust;
  if (rust?.layout !== RUST_STATE_LAYOUT) return undefined;
  return {
    ...rust,
    groups: Object.fromEntries(Object.entries(rust.groups ?? {}).filter(([id]) => RUST_GROUP_ID_PATTERN.test(id)))
  };
}

// Cargo unifies dependency features across one build, so every module's output
// depends on which helper manifests take part in it. Including that set keeps
// incremental and clean builds identical.
function featureFingerprint(groups) {
  const inputs = new Map(
    groups.flatMap((group) =>
      group.helpers.inputs
        .filter((input) => input.path.endsWith('Cargo.toml') || input.path.includes('#'))
        .map((input) => [input.path, input.digest])
    )
  );
  return hashText(stableFingerprint([...inputs].sort(([a], [b]) => compareText(a, b))));
}

// Read-only planning of sources, the workspace lock, and (when the lock is
// unchanged) module builds. `finalizeRustModulePlan` completes builds after a
// changed lock has been resolved.
export async function planRustModules({
  groups,
  paths,
  helperCrates,
  runtimeInputs,
  state,
  records = { modules: {} },
  failures = {},
  mode,
  force = false,
  digests,
  helperReader,
  generatorIdentity,
  buildInputs,
  buildOptions,
  toolchain
}) {
  const published = publishedRustState(state);
  const planned = await Promise.all(
    groups.map(async (group) => {
      const record = records.modules[group.id];
      const inputFingerprint = rustGroupInputFingerprint(group, { generatorIdentity, helperCrates, runtimeInputs });
      const verified = async (files) =>
        (
          await Promise.all(
            RUST_SOURCE_FILES.map((name) => digests.verify(path.join(group.sourceDir, name), files?.[name]))
          )
        ).every(Boolean);
      const helpers = await helperReader.closure(group.cells.flatMap((cell) => cell.crates ?? []));
      const common = {
        ...group,
        previous: published?.groups[group.id],
        descriptor: state?.rust?.modules?.find((entry) => entry.id === group.id),
        inputFingerprint,
        helpers,
        crates: [...new Set(group.cells.flatMap((cell) => cell.crates ?? []))].sort(compareText),
        sources: sourceFingerprints(group.cells)
      };
      if (!force && record?.inputFingerprint === inputFingerprint && (await verified(record.files)))
        return { ...common, source: 'keep', sourceFingerprint: record.sourceFingerprint, sourceFiles: record.files };
      const generated = generateRustModuleSources(group, { helperCrates, paths, runtimeInputs });
      const shas = Object.fromEntries(RUST_SOURCE_FILES.map((name) => [name, hashText(generated.files[name])]));
      // A prose edit only moves authored lines: the source map is refreshed as a
      // cache update while the crate sources, and therefore the module, are kept.
      const unchanged =
        record?.files &&
        ['Cargo.toml', 'src/lib.rs'].every((name) => record.files[name]?.sha256 === shas[name]) &&
        (await verified(record.files));
      return {
        ...common,
        generated,
        source: unchanged ? 'keep' : 'write',
        mapUpdate: Boolean(unchanged) && record.files['source-map.json']?.sha256 !== shas['source-map.json'],
        sourceFingerprint: generated.sourceFingerprint,
        sourceFiles: unchanged ? record.files : undefined,
        shas
      };
    })
  );
  const runtime = runtimeLockClosure(runtimeInputs);
  const helperPackages = [
    ...new Map(
      planned.flatMap((group) => group.helpers.packages.map((entry) => [lockPackageKey(entry), entry]))
    ).values()
  ];
  const manifest = generateRustWorkspaceManifest(planned);
  const helperManifests = featureFingerprint(planned);
  // Helper manifests (without dev-dependencies) decide which packages the lock
  // must contain, including registry and path dependencies a helper lock omits.
  const lockInputFingerprint = hashText(
    stableFingerprint({
      manifest,
      members: planned.map((group) => [
        group.id,
        group.shas?.['Cargo.toml'] ?? group.sourceFiles?.['Cargo.toml']?.sha256
      ]),
      runtime,
      helpers: helperPackages,
      helperManifests,
      buildInputs,
      cargo: toolchain?.cargo ?? null
    })
  );
  const rustCellsDir = pathFromUrl(paths.rustCellsDir);
  const lockRecord = records.lock;
  const lockFilesCurrent =
    planned.length > 0 &&
    lockRecord?.inputFingerprint === lockInputFingerprint &&
    (
      await Promise.all(
        ['Cargo.toml', 'Cargo.lock'].map((name) =>
          digests.verify(path.join(rustCellsDir, name), lockRecord.files?.[name])
        )
      )
    ).every(Boolean);
  const lockCurrent =
    lockFilesCurrent &&
    !lockRecord.pending &&
    planned.every((group) => typeof lockRecord.closures?.[group.id] === 'string');
  // Source-only generation writes the seeded lock without resolving it.
  const seededOnly = mode == null && lockFilesCurrent && lockRecord.pending === true;
  const current = new Set(planned.map((group) => group.id));
  const plan = {
    groups: planned,
    removed: Object.keys(published?.groups ?? {})
      .filter((id) => !current.has(id))
      .sort(compareText),
    staleSources: [...new Set([...Object.keys(records.modules), ...Object.keys(published?.groups ?? {})])]
      .filter((id) => !current.has(id))
      .sort(compareText),
    workspace: {
      action: lockCurrent || seededOnly ? 'keep' : 'write',
      manifest,
      runtime,
      helperPackages,
      lockInputFingerprint
    },
    published: Boolean(state?.rust?.modules?.length),
    featureFingerprint: helperManifests,
    legacy: Boolean(state?.languages?.rust) && !published,
    context: { mode, force, failures, generatorIdentity, runtimeInputs, buildInputs, buildOptions, toolchain }
  };
  if (lockCurrent) return finalizeRustModulePlan(plan, { closures: lockRecord.closures, digests, paths });
  return { ...plan, pending: true };
}

// Explain mode cannot resolve a lock; predict each closure from the seed inputs.
export function predictRustLockClosures(plan) {
  const preferred = new Map();
  for (const [priority, entries] of [
    [1, plan.workspace.runtime],
    [0, plan.workspace.helperPackages]
  ])
    for (const entry of entries) {
      const key = `${entry.name}\0${entry.source}\0${semverCompatibility(entry.version)}`;
      if (!preferred.has(key) || preferred.get(key).priority < priority) preferred.set(key, { entry, priority });
    }
  return Object.fromEntries(
    plan.groups.map((group) => {
      const closure = new Map();
      for (const entry of [...plan.workspace.runtime, ...group.helpers.packages]) {
        const target =
          preferred.get(`${entry.name}\0${entry.source}\0${semverCompatibility(entry.version)}`)?.entry ?? entry;
        closure.set(lockPackageKey(target), [target.name, target.version, target.source ?? '', target.checksum ?? '']);
      }
      // Helper crates themselves are path packages of the resolved closure.
      for (const local of group.helpers.localPackages ?? [])
        closure.set(lockPackageKey(local), [local.name, local.version, '', '']);
      return [
        group.id,
        lockClosureDigest([...closure.values()].sort((a, b) => compareText(a.join('\0'), b.join('\0'))))
      ];
    })
  );
}

export function lockClosuresFromLock(plan, lockText) {
  return Object.fromEntries(
    plan.groups.map((group) => {
      const closure = groupLockClosure(lockText, group.packageName);
      if (!closure)
        throw new Error(`The resolved Rust workspace lock has no entry for module ${group.id} (${group.packageName}).`);
      return [group.id, lockClosureDigest(closure)];
    })
  );
}

function modeSatisfies(actual, requested) {
  if (requested == null) return true;
  if (requested === 'dev') return actual === 'dev' || actual === 'build';
  return actual === 'build';
}

export async function finalizeRustModulePlan(plan, { closures, digests, paths }) {
  const { mode, force, failures, generatorIdentity, runtimeInputs, buildInputs, buildOptions, toolchain } =
    plan.context;
  const publicDir = pathFromUrl(paths.rustWasmPublicDir);
  const groups = await Promise.all(
    plan.groups.map(async (group) => {
      const lockClosure = closures[group.id];
      const buildFingerprint = stableFingerprint({
        generatorIdentity,
        package: runtimeInputs.package,
        rustBuildInputs: buildInputs,
        helpers: hashText(stableFingerprint(group.helpers.inputs)),
        features: plan.featureFingerprint,
        lock: lockClosure,
        source: group.sourceFingerprint,
        toolchain: {
          ...toolchain,
          wasmBindgen: toolchain?.wasmBindgen?.identity,
          wasmOpt: toolchain?.wasmOpt?.identity
        }
      });
      const previous = group.previous;
      const publicFiles = previous?.publicFiles ?? {};
      const complete =
        Boolean(group.descriptor) &&
        Object.keys(publicFiles).length > 0 &&
        (
          await Promise.all(
            Object.entries(publicFiles).map(([name, record]) => digests.verify(path.join(publicDir, name), record))
          )
        ).every(Boolean);
      const current =
        complete &&
        previous.buildFingerprint === artifactBuildFingerprint(buildFingerprint, previous.buildMode) &&
        modeSatisfies(previous.buildMode, mode);
      const failure = failures[group.id];
      const memoized =
        mode === 'dev' && !force && failure?.fingerprint === artifactBuildFingerprint(buildFingerprint, mode);
      const publicAction =
        mode == null
          ? group.source === 'keep' && current
            ? 'keep'
            : 'remove'
          : memoized
            ? 'failed'
            : current && !force
              ? 'keep'
              : 'build';
      const desired = {
        cellCount: group.cells.length,
        sourceFingerprint: group.sourceFingerprint,
        sources: group.sources,
        buildOptions,
        buildFingerprint
      };
      const before = previous && {
        sourceFingerprint: previous.sourceFingerprint,
        sources: previous.sources,
        buildFingerprint: previous.buildFingerprint,
        buildOptions: previous.buildOptions,
        mode: previous.buildMode,
        status: failure ? 'failed' : 'ready'
      };
      return {
        ...group,
        lockClosure,
        buildFingerprint,
        // Whether the published files of the previous build are still in place.
        previousComplete: complete,
        public: publicAction,
        reasons: {
          source: actionReasons({
            action: group.source,
            desired,
            previous: before,
            kind: 'source',
            mode,
            forced: force,
            missing: !group.sourceFiles,
            complete: group.source === 'keep',
            sources: group.sources
          }),
          public:
            publicAction === 'failed'
              ? [{ code: 'failure-unchanged' }]
              : actionReasons({
                  action: publicAction,
                  desired,
                  previous: before,
                  kind: 'public',
                  mode,
                  forced: force,
                  complete,
                  missing: !group.descriptor || !Object.keys(publicFiles).length,
                  sources: group.sources
                })
        }
      };
    })
  );
  return { ...plan, groups, pending: false };
}

// Representatives give the build the same helper set, and therefore the same
// unified features, as a clean build of every module.
export function rustBuildRepresentatives(plan) {
  const stale = plan.groups.filter((group) => group.public === 'build');
  const covered = new Set(stale.flatMap((group) => group.crates));
  const representatives = new Map();
  for (const group of plan.groups.filter((entry) => entry.public === 'keep'))
    for (const crate of group.crates)
      if (!covered.has(crate) && !representatives.has(crate)) representatives.set(crate, group.packageName);
  return [...new Set(representatives.values())].sort(compareText);
}

// Aggregate Rust actions for the language-level plan.
export function rustPlanActions(plan) {
  const source =
    plan.workspace.action === 'write' ||
    plan.staleSources.length ||
    plan.legacy ||
    plan.groups.some((group) => group.source === 'write')
      ? 'write'
      : 'keep';
  // Source-only generation removes previously published modules once they are stale.
  if (plan.pending) return { source, public: plan.context.mode != null ? 'build' : plan.published ? 'remove' : 'keep' };
  const publicAction =
    plan.context.mode == null
      ? plan.groups.some((group) => group.public === 'remove')
        ? 'remove'
        : 'keep'
      : plan.removed.length || plan.legacy || plan.groups.some((group) => group.public === 'build')
        ? 'build'
        : 'keep';
  return { source, public: publicAction };
}

export function seedPreviousPackages(lockText) {
  try {
    return parseLock(lockText).package;
  } catch {
    return [];
  }
}
