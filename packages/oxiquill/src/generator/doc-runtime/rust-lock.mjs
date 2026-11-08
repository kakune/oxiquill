import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { pathFromUrl } from '../../config/paths.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';

const referencePattern = /^(\S+)(?: (\S+))?(?: \((.+)\))?$/u;

export function parseLockReference(reference) {
  const match = referencePattern.exec(String(reference));
  if (!match) throw new Error(`Invalid Cargo.lock dependency reference ${JSON.stringify(reference)}.`);
  return { name: match[1], ...(match[2] ? { version: match[2] } : {}), ...(match[3] ? { source: match[3] } : {}) };
}

export function lockPackageKey(entry) {
  return `${entry.name}\0${entry.version}\0${entry.source ?? ''}`;
}

export function parseLock(text) {
  const lock = typeof text === 'string' ? parse(text) : text;
  return { version: lock?.version, package: Array.isArray(lock?.package) ? lock.package : [] };
}

function indexPackages(packages) {
  const byName = new Map();
  for (const entry of packages) {
    if (!byName.has(entry.name)) byName.set(entry.name, []);
    byName.get(entry.name).push(entry);
  }
  return byName;
}

function resolveReference(byName, reference) {
  const { name, version, source } = typeof reference === 'string' ? parseLockReference(reference) : reference;
  return (byName.get(name) ?? []).filter(
    (entry) => (!version || entry.version === version) && (!source || entry.source === source)
  );
}

// Walks lock edges from the given references. `include` limits which packages are
// recorded and expanded; skipped packages still terminate their branch.
export function lockClosure(packages, roots, { include = () => true } = {}) {
  const byName = indexPackages(packages);
  const selected = new Map();
  const visit = (reference) => {
    for (const entry of resolveReference(byName, reference)) {
      const key = lockPackageKey(entry);
      if (selected.has(key) || !include(entry)) continue;
      selected.set(key, entry);
      (entry.dependencies ?? []).forEach(visit);
    }
  };
  roots.forEach(visit);
  return sortLockPackages([...selected.values()]);
}

// Only registry and git packages need seeding: Cargo derives path and workspace
// member entries itself, and their lock entries may list dev-dependencies.
export function isExternalLockPackage(entry) {
  return typeof entry.source === 'string' && entry.source !== '';
}

export function runtimeLockClosure(runtimeInputs) {
  const lock = parseLock(runtimeInputs.rustLock);
  return lockClosure(
    lock.package,
    Object.entries(runtimeInputs.rust.dependencies).map(([name, version]) => ({ name, version })),
    { include: isExternalLockPackage }
  );
}

export function semverCompatibility(version) {
  const [major = '0', minor = '0', patch = '0'] = String(version).split(/[-+]/u)[0].split('.');
  if (major !== '0') return major;
  return minor !== '0' ? `0.${minor}` : `0.0.${patch}`;
}

export function compareSemver(left, right) {
  const parts = (value) => {
    const [core, prerelease] = String(value).split('+')[0].split(/-(.*)/su);
    return { core: core.split('.').map((part) => Number.parseInt(part, 10) || 0), prerelease };
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < Math.max(a.core.length, b.core.length); index += 1) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference) return Math.sign(difference);
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === undefined) return 1;
  if (b.prerelease === undefined) return -1;
  return a.prerelease < b.prerelease ? -1 : 1;
}

export function sortLockPackages(packages) {
  return [...packages].sort(
    (a, b) =>
      compareText(a.name, b.name) || compareSemver(a.version, b.version) || compareText(a.source ?? '', b.source ?? '')
  );
}

function sourceIdentity(source) {
  return String(source).replace(/#.*$/u, '');
}

// Cargo allows one semver-compatible version per package and source. Runtime
// pins win, then the highest version locked by any helper workspace, then the
// previously resolved generated lock (so helpers without a lock stay stable).
// Every dependency reference is rewritten to a kept package so the seed stays
// unambiguous; Cargo's unlocked resolve then prunes unreachable entries.
export function seedWorkspaceLock({ version = 4, runtime = [], helpers = [], previous = [] }) {
  const candidates = new Map();
  for (const [priority, entries] of [
    [2, runtime],
    [1, helpers],
    [0, previous]
  ]) {
    for (const entry of entries.filter(isExternalLockPackage)) {
      const key = lockPackageKey(entry);
      if (!candidates.has(key) || candidates.get(key).priority < priority) candidates.set(key, { entry, priority });
    }
  }
  const classOf = (entry) => `${entry.name}\0${sourceIdentity(entry.source)}\0${semverCompatibility(entry.version)}`;
  const kept = new Map();
  for (const candidate of [...candidates.values()]) {
    const key = classOf(candidate.entry);
    const current = kept.get(key);
    if (
      !current ||
      candidate.priority > current.priority ||
      (candidate.priority === current.priority && compareSemver(candidate.entry.version, current.entry.version) > 0)
    )
      kept.set(key, candidate);
  }
  const all = indexPackages([...candidates.values()].map(({ entry }) => entry));
  const keptPackages = sortLockPackages([...kept.values()].map(({ entry }) => entry));
  const keptByName = indexPackages(keptPackages);
  const format = (target) => {
    const sameName = keptByName.get(target.name) ?? [];
    if (sameName.length === 1) return target.name;
    const sameVersion = sameName.filter((entry) => entry.version === target.version);
    return sameVersion.length === 1
      ? `${target.name} ${target.version}`
      : `${target.name} ${target.version} (${target.source})`;
  };
  const packages = keptPackages.map((entry) => {
    const dependencies = [
      ...new Set(
        (entry.dependencies ?? []).flatMap((reference) =>
          resolveReference(all, reference).flatMap((match) => {
            const target = kept.get(classOf(match))?.entry;
            return target ? [format(target)] : [];
          })
        )
      )
    ].sort(compareText);
    const fields = Object.fromEntries(Object.entries(entry).filter(([key]) => key !== 'dependencies'));
    return { ...fields, ...(dependencies.length ? { dependencies } : {}) };
  });
  return stringify({ version, package: packages });
}

// The resolved closure of one generated package, independent of other members.
export function groupLockClosure(lock, packageName) {
  const parsed = parseLock(lock);
  const roots = parsed.package.filter((entry) => entry.name === packageName && !isExternalLockPackage(entry));
  if (!roots.length) return undefined;
  return lockClosure(
    parsed.package,
    roots.flatMap((root) => root.dependencies ?? [])
  ).map((entry) => [entry.name, entry.version, entry.source ?? '', entry.checksum ?? '']);
}

export function lockClosureDigest(closure) {
  return closure ? hashText(stableFingerprint(closure)) : undefined;
}

export async function resolveWorkspaceLock({ paths, environment, runCommand, events }) {
  const manifestPath = path.join(pathFromUrl(paths.rustCellsDir), 'Cargo.toml');
  try {
    await runCommand(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--manifest-path',
        manifestPath,
        '--filter-platform',
        'wasm32-unknown-unknown'
      ],
      {
        cwd: pathFromUrl(paths.workspaceRoot),
        env: environment,
        events,
        language: 'rust',
        phase: 'generation',
        source: 'cargo',
        onStdoutLine: () => {}
      }
    );
  } catch (cause) {
    const error = new Error(
      `Unable to resolve the generated Rust workspace lock (${manifestPath}): ${cause.message}. Helper crate dependencies must accept the exact versions Oxiquill pins for its runtime crates; run with network access once when helper dependencies are not cached.`,
      { cause }
    );
    error.exitCode = cause.exitCode;
    throw error;
  }
}

function compareText(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}
