import path from 'node:path';
import { assertPathWithin, canonicalPath, normalizePath } from '../../config/paths.mjs';
import { defaultFileSystem } from './file-system.mjs';

export const RUNTIME_OWNERSHIP_SCHEMA_VERSION = 1;

export function createRuntimeOwnedOutputs(paths) {
  return Object.freeze([
    ownedOutput('rust', 'cache', paths.cacheDir, paths.rustCellsDir),
    ownedOutput('rust', 'public', paths.publicAssetsDir, paths.rustWasmPublicDir),
    ownedOutput('python', 'public', paths.publicAssetsDir, paths.pyodidePublicDir),
    ownedOutput('haskell', 'cache', paths.cacheDir, paths.haskellCellsDir),
    ownedOutput('haskell', 'public', paths.publicAssetsDir, paths.haskellWasmPublicDir)
  ]);
}

export async function readRuntimeOwnership({ fileSystem = defaultFileSystem, paths }) {
  let source;
  try {
    source = await fileSystem.readFile(paths.runtimeOwnershipPath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined;
    throw error;
  }

  let manifest;
  try {
    manifest = JSON.parse(source);
  } catch (error) {
    throw new Error(`Runtime ownership manifest is invalid JSON: ${paths.runtimeOwnershipPath}.`, { cause: error });
  }

  validateRuntimeOwnership(manifest, paths);
  return manifest;
}

export function validateRuntimeOwnership(manifest, paths) {
  if (
    manifest?.schemaVersion !== RUNTIME_OWNERSHIP_SCHEMA_VERSION ||
    typeof manifest.manifestFingerprint !== 'string' ||
    !isRecord(manifest.languages) ||
    !Array.isArray(manifest.ownedOutputs)
  ) {
    throw new Error('Runtime ownership manifest must use schemaVersion 1 and contain valid runtime state.');
  }

  const expected = new Map(createRuntimeOwnedOutputs(paths).map((entry) => [ownershipKey(entry), entry]));
  for (const entry of manifest.ownedOutputs) {
    if (!isOwnedOutput(entry)) throw new Error('Runtime ownership manifest contains an invalid owned output.');

    const key = ownershipKey(entry);
    const expectedEntry = expected.get(key);
    if (!expectedEntry || expectedEntry.path !== entry.path) {
      throw new Error(`Runtime ownership manifest contains an unexpected owned output: ${entry.path}.`);
    }

    resolveOwnedOutput(entry, paths);
  }

  return manifest;
}

export function resolveOwnedOutput(entry, paths) {
  const root = entry.root === 'cache' ? paths.cacheDir : paths.publicAssetsDir;
  const target = canonicalPath(path.resolve(root, entry.path));
  assertPathWithin(root, target, `runtime ownership ${entry.language}`);
  return target;
}

export function generateRuntimeOwnershipJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function ownedOutput(language, root, rootPath, targetPath) {
  const relativePath = normalizePath(path.relative(rootPath, targetPath));
  if (relativePath === '' || relativePath === '..' || relativePath.startsWith('../')) {
    throw new Error(`Runtime ${language} output must be a descendant of ${rootPath}.`);
  }
  return Object.freeze({ language, path: relativePath, root });
}

function ownershipKey(entry) {
  return `${entry.language}:${entry.root}`;
}

function isOwnedOutput(entry) {
  return (
    isRecord(entry) &&
    (entry.language === 'rust' || entry.language === 'python' || entry.language === 'haskell') &&
    (entry.root === 'cache' || entry.root === 'public') &&
    typeof entry.path === 'string' &&
    entry.path !== '' &&
    !path.isAbsolute(entry.path) &&
    !normalizePath(entry.path).split('/').includes('..')
  );
}

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
