import path from 'node:path';
import { parse } from 'smol-toml';
import { pathFromUrl } from '../../config/paths.mjs';
import { listAuthoredHelperInputFiles } from './helper-inputs.mjs';
import { hashText, stableFingerprint } from './hashing.mjs';
import { isExternalLockPackage, lockClosure, lockPackageKey, parseLock, sortLockPackages } from './rust-lock.mjs';
import { normalizePath } from './path-utils.mjs';

const devDependencyTables = ['dev-dependencies', 'dev_dependencies'];

// Manifests without development-only tables: dev-dependencies never reach the
// generated crates, so editing them must not invalidate any Rust module.
export function buildManifestFingerprint(manifest) {
  const copy = structuredClone(manifest);
  devDependencyTables.forEach((table) => delete copy[table]);
  Object.values(copy.target ?? {}).forEach((target) => devDependencyTables.forEach((table) => delete target[table]));
  return hashText(stableFingerprint(canonical(copy)));
}

export function buildDependencyTables(manifest) {
  return [
    manifest.dependencies,
    manifest['build-dependencies'],
    manifest.build_dependencies,
    ...Object.values(manifest.target ?? {}).flatMap((target) => [
      target.dependencies,
      target['build-dependencies'],
      target.build_dependencies
    ])
  ].flatMap((table) => Object.entries(table ?? {}));
}

// Reads each helper crate (and its path dependencies) once per run. Closures are
// shared by every group that uses the helper.
export function createHelperClosureReader({ paths, helperCrates, fileSystem, digest }) {
  const workspaceRoot = pathFromUrl(paths.workspaceRoot);
  const rustCellsDir = pathFromUrl(paths.rustCellsDir);
  const manifests = new Map();
  const directories = new Map();
  const relative = (file) => normalizePath(path.relative(workspaceRoot, file));
  const readToml = (file) => {
    if (!manifests.has(file))
      manifests.set(
        file,
        (async () => {
          try {
            return parse(String(await fileSystem.readFile(file, 'utf8')));
          } catch (error) {
            if (error?.code === 'ENOENT') return undefined;
            throw new Error(`Unable to read Rust helper input ${file}: ${error.message}`, { cause: error });
          }
        })()
      );
    return manifests.get(file);
  };
  const workspaceFor = async (directory, manifest) => {
    if (manifest.workspace) return { directory, manifest };
    if (typeof manifest.package?.workspace === 'string') {
      const root = path.resolve(directory, manifest.package.workspace);
      return { directory: root, manifest: await readToml(path.join(root, 'Cargo.toml')) };
    }
    for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const candidate = await readToml(path.join(parent, 'Cargo.toml'));
      if (candidate?.workspace) return { directory: parent, manifest: candidate };
    }
    return undefined;
  };
  const visitDirectory = (directory, ancestors = []) => {
    if (ancestors.includes(directory))
      throw new Error(`Rust helper path dependencies form a cycle: ${[...ancestors, directory].join(' -> ')}.`);
    if (!directories.has(directory)) directories.set(directory, readDirectory(directory, [...ancestors, directory]));
    return directories.get(directory);
  };
  const readDirectory = async (directory, ancestors) => {
    const manifestPath = path.join(directory, 'Cargo.toml');
    const manifest = await readToml(manifestPath);
    if (!manifest?.package) throw new Error(`Missing helper package manifest: ${manifestPath}.`);
    const workspace = await workspaceFor(directory, manifest);
    const inputs = new Map();
    const packages = new Map();
    const inherited = {};
    Object.entries(manifest.package).forEach(([name, value]) => {
      if (value?.workspace) inherited[name] = workspace?.manifest?.workspace?.package?.[name];
    });
    const inheritedDependencies = {};
    const dependencyNames = new Set();
    const nested = [];
    for (const [name, value] of buildDependencyTables(manifest)) {
      const dependency = value?.workspace ? workspace?.manifest?.workspace?.dependencies?.[name] : value;
      if (value?.workspace) inheritedDependencies[name] = dependency;
      dependencyNames.add(dependency?.package ?? name);
      if (dependency?.path)
        nested.push(path.resolve(value?.workspace ? workspace.directory : directory, dependency.path));
    }
    for (const { filePath } of await listAuthoredHelperInputFiles(directory, { fileSystem })) {
      const name = path.basename(filePath);
      if (name === 'Cargo.lock') continue;
      inputs.set(
        relative(filePath),
        name === 'Cargo.toml' && path.dirname(filePath) === directory
          ? buildManifestFingerprint(manifest)
          : await digest(filePath)
      );
    }
    if (workspace)
      inputs.set(
        `${relative(path.join(workspace.directory, 'Cargo.toml'))}#${manifest.package.name}`,
        hashText(
          stableFingerprint(
            canonical({
              package: inherited,
              dependencies: inheritedDependencies,
              ...(manifest.lints?.workspace ? { lints: workspace.manifest.workspace.lints } : {}),
              patch: workspace.manifest.patch,
              replace: workspace.manifest.replace
            })
          )
        )
      );
    const packageVersion = typeof manifest.package.version === 'string' ? manifest.package.version : inherited.version;
    // Path packages appear in the resolved lock without a source; Cargo defaults a missing version.
    const locals = new Map([
      [manifest.package.name, { name: manifest.package.name, version: packageVersion ?? '0.0.0' }]
    ]);
    const lockPath = path.join(workspace?.directory ?? directory, 'Cargo.lock');
    const lock = await readToml(lockPath);
    if (lock) {
      const entries = parseLock(lock).package;
      // Path-package lock entries also list dev-dependencies; keep only the edges
      // named by normal and build dependency tables of the manifest.
      const roots = entries
        .filter(
          (entry) =>
            entry.name === manifest.package.name &&
            !isExternalLockPackage(entry) &&
            (packageVersion === undefined || entry.version === packageVersion)
        )
        .flatMap((entry) => entry.dependencies ?? [])
        .filter((reference) => dependencyNames.has(String(reference).split(' ')[0]));
      const closure = lockClosure(entries, roots, { include: isExternalLockPackage });
      closure.forEach((entry) => packages.set(lockPackageKey(entry), entry));
      // A lock that pins nothing reachable (for example only dev-dependencies) is not an input.
      if (closure.length)
        inputs.set(`${relative(lockPath)}#${manifest.package.name}`, hashText(stableFingerprint(closure)));
    }
    const merged = await Promise.all(nested.map((child) => visitDirectory(child, ancestors)));
    for (const child of merged) {
      child.inputs.forEach((value, key) => inputs.set(key, value));
      child.packages.forEach((value, key) => packages.set(key, value));
      child.locals.forEach((value, key) => locals.set(key, value));
    }
    return { inputs, packages, locals };
  };
  const readHelper = (name) => {
    const helper = helperCrates.get(name);
    if (!helper) throw new Error(`Unknown Rust helper crate ${name}.`);
    return visitDirectory(path.resolve(rustCellsDir, helper.relativePath));
  };
  return Object.freeze({
    // Union of the transitive helper closures used by a set of crates.
    async closure(crateNames) {
      const inputs = new Map();
      const packages = new Map();
      const locals = new Map();
      for (const name of [...new Set(crateNames)].sort()) {
        const result = await readHelper(name);
        result.inputs.forEach((value, key) => inputs.set(key, value));
        result.packages.forEach((value, key) => packages.set(key, value));
        result.locals.forEach((value, key) => locals.set(key, value));
      }
      return {
        inputs: [...inputs]
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([inputPath, digestValue]) => ({ path: inputPath, digest: digestValue })),
        packages: sortLockPackages([...packages.values()]),
        localPackages: [...locals.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      };
    }
  });
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !(value instanceof Date))
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key])])
    );
  return value;
}
