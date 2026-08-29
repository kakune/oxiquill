import { existsSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const defaultFrameworkRoot = inferDefaultFrameworkRoot();

export function createOxiquillPaths(options = {}) {
  const workspaceRoot = directoryPath(options.workspaceRoot ?? process.cwd());
  const frameworkRoot = directoryPath(options.frameworkRoot ?? defaultFrameworkRoot, workspaceRoot);
  const publicDir = directoryPath(options.publicDir ?? 'public', workspaceRoot);
  const publicAssetsDir = directoryPath(options.publicAssetsDir ?? 'oxiquill', publicDir);
  const cacheDir = directoryPath(options.cacheDir ?? '.oxiquill', workspaceRoot);
  const generatedDir = directoryPath(options.generatedDir ?? 'generated', cacheDir);

  return Object.freeze({
    workspaceRoot,
    frameworkRoot,
    docsDir: directoryPath(options.docsDir ?? 'content/docs', workspaceRoot),
    cratesDir: directoryPath(options.cratesDir ?? 'crates', workspaceRoot),
    cacheDir,
    outDir: directoryPath(options.outDir ?? 'dist', workspaceRoot),
    generatedDir,
    haskellCellsDir: directoryPath(options.haskellCellsDir ?? 'haskell-cells', cacheDir),
    rustCellsDir: directoryPath(options.rustCellsDir ?? 'rust-cells', cacheDir),
    publicDir,
    publicAssetsDir,
    haskellWasmPublicDir: directoryPath(options.haskellWasmPublicDir ?? 'haskell-wasm', publicAssetsDir),
    licensesPublicDir: directoryPath(options.licensesPublicDir ?? 'licenses', publicAssetsDir),
    pyodidePublicDir: directoryPath(options.pyodidePublicDir ?? 'pyodide', publicAssetsDir),
    rustWasmPublicDir: directoryPath(options.rustWasmPublicDir ?? 'rust-wasm', publicAssetsDir),
    cellsModulePath: filePath('cells.ts', generatedDir),
    cellsJsonPath: filePath('cells.json', generatedDir),
    runtimeOwnershipPath: filePath('runtime-ownership.json', generatedDir),
    runtimeVersionPath: filePath('runtime-version.ts', generatedDir)
  });
}

export function directoryPath(value, basePath = process.cwd()) {
  return canonicalPath(resolvePathValue(value, basePath));
}

export function filePath(value, basePath = process.cwd()) {
  return canonicalPath(resolvePathValue(value, basePath));
}

export function directoryUrl(value, baseUrl) {
  return pathToFileURL(directoryPath(value, baseUrl));
}

export function fileUrl(value, baseUrl) {
  return pathToFileURL(filePath(value, baseUrl));
}

export function pathFromUrl(value) {
  if (value instanceof URL) return withoutTrailingSeparator(fileURLToPath(assertFileUrl(value)));
  if (typeof value === 'string' && value.startsWith('file:')) {
    return withoutTrailingSeparator(fileURLToPath(assertFileUrl(new URL(value))));
  }

  return value;
}

export function pathInUrl(directory, ...segments) {
  return path.join(pathFromUrl(directory), ...segments);
}

export function relativePathFromUrl(fromDirectory, toPath) {
  return normalizePath(path.relative(pathFromUrl(fromDirectory), pathFromUrl(toPath)));
}

export function normalizePath(value) {
  return String(value).replaceAll('\\', '/');
}

export function canonicalPath(value) {
  const absolutePath = path.resolve(value);
  const missingSegments = [];
  let existingAncestor = absolutePath;

  while (!existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) return absolutePath;

    missingSegments.unshift(path.basename(existingAncestor));
    existingAncestor = parent;
  }

  const realAncestor = realpathSync.native?.(existingAncestor) ?? realpathSync(existingAncestor);
  return path.resolve(realAncestor, ...missingSegments);
}

export function isPathWithin(parentPath, candidatePath) {
  const relativePath = path.relative(canonicalPath(parentPath), canonicalPath(candidatePath));
  return (
    relativePath !== '' &&
    relativePath !== '..' &&
    !relativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relativePath)
  );
}

export function assertPathWithin(parentPath, candidatePath, fieldName) {
  if (!isPathWithin(parentPath, candidatePath)) {
    throw new Error(`${fieldName} must resolve to a directory inside ${parentPath}; received ${candidatePath}.`);
  }
}

function resolvePathValue(value, basePath) {
  const resolvedBasePath = pathFromUrl(basePath);

  if (value instanceof URL) return fileURLToPath(assertFileUrl(value));
  if (typeof value !== 'string') {
    throw new TypeError(`Expected a path string or file URL, received ${typeof value}.`);
  }
  if (value.trim() === '') {
    throw new TypeError('Expected a non-empty path string or file URL.');
  }
  if (value.startsWith('file:')) return fileURLToPath(assertFileUrl(new URL(value)));

  return path.isAbsolute(value) ? value : path.resolve(resolvedBasePath, value);
}

function assertFileUrl(value) {
  if (value.protocol !== 'file:') {
    throw new TypeError(`Expected a file URL, received ${value.protocol} URL.`);
  }

  return value;
}

function withoutTrailingSeparator(value) {
  return value.length > path.parse(value).root.length && value.endsWith(path.sep) ? value.slice(0, -1) : value;
}

function inferDefaultFrameworkRoot() {
  const rootUrl = new URL('../../', import.meta.url);
  return rootUrl.protocol === 'file:' ? directoryPath(rootUrl) : directoryPath(process.cwd());
}
