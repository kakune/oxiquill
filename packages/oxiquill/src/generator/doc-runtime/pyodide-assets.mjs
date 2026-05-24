import path from 'node:path';
import { pathInUrl } from '../../config/paths.mjs';
import { vendoredPyodidePackageRoots } from './constants.mjs';
import {
  copyFileIfChanged,
  defaultFileSystem,
  hasPackageContent
} from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

export async function copyPyodideAssets({ fetchPackage, fileSystem = defaultFileSystem, paths }) {
  const packageDir = resolvePyodidePackageDir({ fileSystem, paths });
  if (!fileSystem.existsSync(packageDir)) return false;

  const coreChanged = await Promise.all(
    [
      'pyodide.mjs',
      'pyodide.mjs.map',
      'pyodide.asm.js',
      'pyodide.asm.wasm',
      'python_stdlib.zip',
      'pyodide-lock.json'
    ].map((file) =>
      copyFileIfChanged(path.join(packageDir, file), pathInUrl(paths.pyodidePublicDir, file), {
        fileSystem
      })
    )
  );
  const lockFile = JSON.parse(await fileSystem.readFile(path.join(packageDir, 'pyodide-lock.json'), 'utf8'));
  const packageChanged = await copyVendoredPyodidePackages({
    fetchPackage,
    fileSystem,
    lockFile,
    paths
  });

  return coreChanged.some(Boolean) || packageChanged;
}

export async function copyVendoredPyodidePackages({
  fetchPackage = fetchPyodidePackage,
  fileSystem = defaultFileSystem,
  lockFile,
  paths,
  roots = vendoredPyodidePackageRoots
}) {
  const packages = resolveVendoredPyodidePackages(lockFile, roots);
  const changed = await Promise.all(
    packages.map(async (packageInfo) => {
      const targetPath = pathInUrl(paths.pyodidePublicDir, packageInfo.file_name);
      if (await hasPackageContent(targetPath, packageInfo.sha256, { fileSystem })) return false;

      const content = await fetchPackage(packageInfo.file_name);
      assertPackageSha256(content, packageInfo.sha256, packageInfo.name);
      await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });
      await fileSystem.writeFile(targetPath, content);
      return true;
    })
  );

  return changed.some(Boolean);
}

function resolvePyodidePackageDir({ fileSystem, paths }) {
  const candidates = [
    pathInUrl(paths.frameworkRoot, 'node_modules/pyodide'),
    pathInUrl(paths.workspaceRoot, 'node_modules/pyodide')
  ];

  return candidates.find((candidate) => fileSystem.existsSync(candidate)) ?? candidates[0];
}

export function resolveVendoredPyodidePackages(lockFile, roots = vendoredPyodidePackageRoots) {
  const packages = lockFile?.packages;
  if (!packages || typeof packages !== 'object') {
    throw new Error('Pyodide lock file is missing a packages table.');
  }

  const selected = new Set();
  function visit(packageName) {
    if (selected.has(packageName)) return;
    const packageInfo = packages[packageName];
    if (!packageInfo) throw new Error(`Pyodide package "${packageName}" is missing from the lock file.`);
    selected.add(packageName);
    for (const dependency of packageInfo.depends ?? []) {
      visit(dependency);
    }
  }

  roots.forEach(visit);
  return Array.from(selected)
    .sort()
    .map((name) => ({ name, ...packages[name] }));
}

function assertPackageSha256(content, expectedSha256, packageName) {
  const actualSha256 = hashBytes(content);
  if (actualSha256 !== expectedSha256) {
    throw new Error(
      `Downloaded Pyodide package "${packageName}" has sha256 ${actualSha256}; expected ${expectedSha256}.`
    );
  }
}

async function fetchPyodidePackage(fileName) {
  const url = `https://cdn.jsdelivr.net/pyodide/v0.29.4/full/${fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
