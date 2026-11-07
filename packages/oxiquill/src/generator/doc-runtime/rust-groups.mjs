import path from 'node:path';
import { parse, stringify } from 'smol-toml';
import { generateRustCargoToml } from './rust-codegen/cargo.mjs';
import { generateRustLibMapped } from './rust-codegen/lib.mjs';
import { listAuthoredHelperInputFiles } from './helper-inputs.mjs';
import { hashBytes, hashText, stableFingerprint } from './hashing.mjs';
import { normalizePath } from './path-utils.mjs';

export function createRustGroups({ cells, paths, helperCrates, runtimeInputs }) {
  const pages = Object.groupBy(cells, (cell) =>
    normalizePath(path.relative(paths.docsDir, path.resolve(paths.workspaceRoot, normalizePath(cell.pagePath))))
  );
  return Object.entries(pages)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([page, members]) => {
      const id = `page-${hashText(page)}`;
      const packageName = `doc-rust-${id}`;
      const sourceDir = path.join(paths.rustCellsDir, 'pages', id);
      const helpers = new Map(
        [...helperCrates].map(([name, info]) => [
          name,
          {
            ...info,
            relativePath: normalizePath(path.relative(sourceDir, path.resolve(paths.rustCellsDir, info.relativePath)))
          }
        ])
      );
      const sortedCells = [...members].sort((a, b) => a.id.localeCompare(b.id));
      const mapped = generateRustLibMapped(sortedCells);
      return Object.freeze({
        id,
        page,
        packageName,
        sourceDir,
        cells: sortedCells,
        cargo: generateRustCargoToml(sortedCells, helpers, runtimeInputs, { packageName, workspace: false }),
        lib: mapped.text,
        sourceMap: { ...mapped, file: path.join(sourceDir, 'src/lib.rs'), crateDir: sourceDir }
      });
    });
}

export function generateRustWorkspace(groups) {
  return `[workspace]\nmembers = ${JSON.stringify(groups.map(({ id }) => `pages/${id}`).sort())}\nresolver = "3"\n`;
}

export function generateRustWorkspaceLock(groups, runtimeInputs, helperPackages = []) {
  const base = parse(runtimeInputs.rustLock);
  const packages = [...base.package.filter((entry) => entry.name !== 'doc-rust-cells'), ...helperPackages];
  const unique = new Map(
    packages.map((entry) => [stableFingerprint([entry.name, entry.version, entry.source]), entry])
  );
  groups.forEach((group) =>
    unique.set(group.packageName, {
      name: group.packageName,
      version: runtimeInputs.package.version,
      dependencies: [
        ...new Set([...Object.keys(runtimeInputs.rust.dependencies), ...group.cells.flatMap((cell) => cell.crates)])
      ].sort()
    })
  );
  return stringify({
    version: base.version,
    package: [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  });
}

export function lockDependencyClosure(packages, roots) {
  const selected = new Map();
  const visit = (reference) => {
    const [name, version] = reference.split(' ');
    packages
      .filter((entry) => entry.name === name && (!version || entry.version === version))
      .forEach((entry) => {
        const key = stableFingerprint([entry.name, entry.version, entry.source]);
        if (selected.has(key)) return;
        selected.set(key, entry);
        (entry.dependencies ?? []).forEach(visit);
      });
  };
  roots.forEach(visit);
  return [...selected.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

export async function readRustHelperClosure({ cells, helperCrates, paths, fileSystem }) {
  const visited = new Set();
  const inputs = new Map();
  const packages = new Map();
  const record = (file, digest) => inputs.set(normalizePath(path.relative(paths.workspaceRoot, file)), digest);
  const readOptional = async (file) => {
    try {
      return parse(await fileSystem.readFile(file, 'utf8'));
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw new Error(`Unable to read Rust helper input ${file}: ${error.message}`, { cause: error });
    }
  };
  const workspaceFor = async (directory, manifest) => {
    if (manifest.workspace) return { directory, manifest };
    if (typeof manifest.package?.workspace === 'string') {
      const root = path.resolve(directory, manifest.package.workspace);
      return { directory: root, manifest: await readOptional(path.join(root, 'Cargo.toml')) };
    }
    for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const candidate = await readOptional(path.join(parent, 'Cargo.toml'));
      if (candidate?.workspace) return { directory: parent, manifest: candidate };
    }
    return undefined;
  };
  const visit = async (directory) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    const manifestPath = path.join(directory, 'Cargo.toml');
    const manifest = await readOptional(manifestPath);
    if (!manifest?.package) throw new Error(`Missing helper package manifest: ${manifestPath}.`);
    const workspace = await workspaceFor(directory, manifest);
    const inherited = {};
    Object.entries(manifest.package).forEach(([name, value]) => {
      if (value?.workspace) inherited[name] = workspace?.manifest.workspace.package?.[name];
    });
    const dependencyTables = [
      manifest.dependencies,
      manifest['build-dependencies'],
      ...Object.values(manifest.target ?? {}).flatMap((target) => [target.dependencies, target['build-dependencies']])
    ];
    const dependencies = dependencyTables.flatMap((table) => Object.entries(table ?? {}));
    const inheritedDependencies = {};
    const dependencyNames = [];
    for (const [name, value] of dependencies) {
      const dependency = value?.workspace ? workspace?.manifest.workspace.dependencies?.[name] : value;
      if (value?.workspace) inheritedDependencies[name] = dependency;
      dependencyNames.push(dependency?.package ?? name);
      if (dependency?.path)
        await visit(path.resolve(value?.workspace ? workspace.directory : directory, dependency.path));
    }
    for (const { filePath } of await listAuthoredHelperInputFiles(directory, { fileSystem })) {
      if (path.basename(filePath) !== 'Cargo.lock') record(filePath, hashBytes(await fileSystem.readFile(filePath)));
    }
    if (workspace) {
      record(
        `${path.join(workspace.directory, 'Cargo.toml')}#${manifest.package.name}`,
        hashText(
          stableFingerprint({
            package: inherited,
            dependencies: inheritedDependencies,
            ...(manifest.lints?.workspace ? { lints: workspace.manifest.workspace.lints } : {}),
            patch: workspace.manifest.patch,
            replace: workspace.manifest.replace
          })
        )
      );
    }
    const lockPath = path.join(workspace?.directory ?? directory, 'Cargo.lock');
    const lock = await readOptional(lockPath);
    const closure = lockDependencyClosure(lock?.package ?? [], [manifest.package.name]);
    closure.forEach((entry) => packages.set(stableFingerprint([entry.name, entry.version, entry.source]), entry));
    const packageVersion = typeof manifest.package.version === 'string' ? manifest.package.version : inherited.version;
    if (typeof packageVersion !== 'string') throw new Error(`Missing helper package version: ${manifestPath}.`);
    packages.set(stableFingerprint([manifest.package.name, packageVersion, undefined]), {
      name: manifest.package.name,
      version: packageVersion,
      ...(dependencyNames.length ? { dependencies: [...new Set(dependencyNames)].sort() } : {})
    });
    if (lock) record(`${lockPath}#${manifest.package.name}`, hashText(stableFingerprint(closure)));
  };
  for (const name of [...new Set(cells.flatMap((cell) => cell.crates))].sort()) {
    const helper = helperCrates.get(name);
    if (!helper) throw new Error(`Unknown Rust helper crate ${name}.`);
    await visit(path.resolve(paths.rustCellsDir, helper.relativePath));
  }
  return {
    inputs: [...inputs].sort(([a], [b]) => a.localeCompare(b)).map(([name, digest]) => ({ path: name, digest })),
    packages: [...packages.values()]
  };
}
