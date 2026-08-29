import path from 'node:path';
import { pathInUrl } from '../../config/paths.mjs';
import { vendoredPyodidePackageRoots } from './constants.mjs';
import { copyFileIfChanged, defaultFileSystem, hasPackageContent } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

export async function copyPyodideAssets({ fetchPackage, fileSystem = defaultFileSystem, paths }) {
  const packageDir = resolvePyodidePackageDir({ fileSystem, paths });
  if (!fileSystem.existsSync(packageDir)) return false;

  const [lockFile, pyodideVersion] = await Promise.all([
    readJsonFile(path.join(packageDir, 'pyodide-lock.json'), { fileSystem }),
    readPyodideVersion(packageDir, { fileSystem })
  ]);
  const coreChanged = await Promise.all(
    [
      'pyodide.mjs',
      'pyodide.mjs.map',
      'pyodide.asm.mjs',
      'pyodide.asm.wasm',
      'python_stdlib.zip',
      'pyodide-lock.json'
    ].map((file) =>
      copyFileIfChanged(path.join(packageDir, file), pathInUrl(paths.pyodidePublicDir, file), {
        fileSystem
      })
    )
  );
  const packageChanged = await copyVendoredPyodidePackages({
    fetchPackage,
    fileSystem,
    lockFile,
    paths,
    pyodideVersion
  });

  return coreChanged.some(Boolean) || packageChanged;
}

export async function copyVendoredPyodidePackages({
  fetchPackage,
  fileSystem = defaultFileSystem,
  lockFile,
  paths,
  pyodideVersion,
  roots = vendoredPyodidePackageRoots
}) {
  const packages = resolveVendoredPyodidePackages(lockFile, roots);
  const downloadPackage = fetchPackage ?? ((fileName) => fetchPyodidePackage(fileName, pyodideVersion));
  const changed = await Promise.all(
    packages.map(async (packageInfo) => {
      const targetPath = pathInUrl(paths.pyodidePublicDir, packageInfo.file_name);
      if (await hasPackageContent(targetPath, packageInfo.sha256, { fileSystem })) return false;

      const content = await downloadPackage(packageInfo.file_name);
      assertPackageSha256(content, packageInfo.sha256, packageInfo.name);
      await fileSystem.mkdir(path.dirname(targetPath), { recursive: true });
      await fileSystem.writeFile(targetPath, content);
      return true;
    })
  );

  return changed.some(Boolean);
}

async function readPyodideVersion(packageDir, { fileSystem }) {
  const packageMetadata = await readJsonFile(path.join(packageDir, 'package.json'), { fileSystem });
  if (typeof packageMetadata.version !== 'string' || packageMetadata.version.trim() === '') {
    throw new Error('Pyodide package metadata is missing a version.');
  }

  return packageMetadata.version;
}

async function readJsonFile(filePath, { fileSystem }) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Pyodide metadata file is invalid: ${filePath}.`, { cause: error });
  }
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

async function fetchPyodidePackage(fileName, pyodideVersion) {
  if (typeof pyodideVersion !== 'string' || pyodideVersion.trim() === '') {
    throw new Error('A Pyodide version is required to download vendored packages.');
  }

  const url = `https://cdn.jsdelivr.net/pyodide/v${pyodideVersion}/full/${fileName}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`);
  }

  return Buffer.from(await response.arrayBuffer());
}
