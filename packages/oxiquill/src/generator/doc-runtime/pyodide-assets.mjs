import path from 'node:path';
import { createRequire } from 'node:module';
import { pathInUrl } from '../../config/paths.mjs';
import { vendoredPyodidePackageRoots } from './constants.mjs';
import { copyFileIfChanged, defaultFileSystem, hasPackageContent } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

const require = createRequire(import.meta.url);
const requiredPyodideFiles = [
  'pyodide.mjs',
  'pyodide.mjs.map',
  'pyodide.asm.mjs',
  'pyodide.asm.wasm',
  'python_stdlib.zip',
  'pyodide-lock.json'
];

export async function copyPyodideAssets({
  fetchPackage,
  fileSystem = defaultFileSystem,
  paths,
  resolvePackageJson = resolvePyodidePackageJson
}) {
  const packageDir = resolvePyodidePackageDir(resolvePackageJson);
  assertRequiredPyodideFiles(packageDir, { fileSystem });

  const [lockFile, pyodideVersion] = await Promise.all([
    readJsonFile(path.join(packageDir, 'pyodide-lock.json'), { fileSystem }),
    readPyodideVersion(packageDir, { fileSystem })
  ]);
  const coreChanged = await Promise.all(
    requiredPyodideFiles.map((file) =>
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

function resolvePyodidePackageJson() {
  return require.resolve('pyodide/package.json');
}

function resolvePyodidePackageDir(resolvePackageJson) {
  try {
    const packageJsonPath = resolvePackageJson();
    if (typeof packageJsonPath !== 'string' || packageJsonPath.length === 0) {
      throw new TypeError('The package resolver did not return a file path.');
    }

    return path.dirname(packageJsonPath);
  } catch (error) {
    throw new Error('Unable to resolve required Pyodide package "pyodide" from Oxiquill.', {
      cause: error
    });
  }
}

function assertRequiredPyodideFiles(packageDir, { fileSystem }) {
  requiredPyodideFiles.forEach((fileName) => {
    const filePath = path.join(packageDir, fileName);
    if (fileSystem.existsSync(filePath)) return;

    throw new Error(`Required Pyodide asset "${fileName}" is missing from package "pyodide" at "${filePath}".`);
  });
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
