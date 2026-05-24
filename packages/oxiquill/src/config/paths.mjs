import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const defaultFrameworkRoot = inferDefaultFrameworkRoot();

export function createOxiquillPaths(options = {}) {
  const workspaceRoot = directoryUrl(options.workspaceRoot ?? process.cwd());
  const frameworkRoot = directoryUrl(options.frameworkRoot ?? defaultFrameworkRoot);
  const publicDir = directoryUrl(options.publicDir ?? 'public', workspaceRoot);
  const publicAssetsDir = directoryUrl(options.publicAssetsDir ?? 'oxiquill', publicDir);
  const cacheDir = directoryUrl(options.cacheDir ?? '.oxiquill', workspaceRoot);
  const generatedDir = directoryUrl(options.generatedDir ?? 'generated', cacheDir);

  return {
    workspaceRoot,
    frameworkRoot,
    docsDir: directoryUrl(options.docsDir ?? 'content/docs', workspaceRoot),
    cratesDir: directoryUrl(options.cratesDir ?? 'crates', workspaceRoot),
    cacheDir,
    generatedDir,
    rustCellsDir: directoryUrl(options.rustCellsDir ?? 'rust-cells', cacheDir),
    publicDir,
    publicAssetsDir,
    pyodidePublicDir: directoryUrl(options.pyodidePublicDir ?? 'pyodide', publicAssetsDir),
    rustWasmPublicDir: directoryUrl(options.rustWasmPublicDir ?? 'rust-wasm', publicAssetsDir),
    cellsModulePath: fileUrl('cells.ts', generatedDir),
    cellsJsonPath: fileUrl('cells.json', generatedDir),
    runtimeVersionPath: fileUrl('runtime-version.ts', generatedDir)
  };
}

export function directoryUrl(value, baseUrl) {
  if (value instanceof URL) return ensureDirectoryUrl(value);

  if (typeof value !== 'string') {
    throw new TypeError(`Expected a path string or file URL, received ${typeof value}.`);
  }

  if (value.startsWith('file:')) return ensureDirectoryUrl(new URL(value));

  const basePath = baseUrl ? fileURLToPath(baseUrl) : process.cwd();
  const absolutePath = path.isAbsolute(value) ? value : path.resolve(basePath, value);
  return ensureDirectoryUrl(pathToFileURL(absolutePath));
}

export function fileUrl(value, baseUrl) {
  if (value instanceof URL) return value;
  const basePath = baseUrl ? fileURLToPath(baseUrl) : process.cwd();
  const absolutePath = path.isAbsolute(value) ? value : path.resolve(basePath, value);
  return pathToFileURL(absolutePath);
}

export function pathFromUrl(value) {
  if (!(value instanceof URL)) return value;

  const filePath = fileURLToPath(value);
  return filePath.length > 1 && filePath.endsWith(path.sep) ? filePath.slice(0, -1) : filePath;
}

export function pathInUrl(directory, ...segments) {
  return path.join(pathFromUrl(directory), ...segments);
}

export function relativePathFromUrl(fromDirectory, toPath) {
  return normalizePath(path.relative(pathFromUrl(fromDirectory), pathFromUrl(toPath)));
}

export function normalizePath(value) {
  return String(value).split(path.sep).join('/');
}

function ensureDirectoryUrl(url) {
  return url.href.endsWith('/') ? url : new URL(`${url.href}/`);
}

function inferDefaultFrameworkRoot() {
  const rootUrl = new URL('../../', import.meta.url);
  return rootUrl.protocol === 'file:' ? directoryUrl(rootUrl) : directoryUrl(process.cwd());
}
