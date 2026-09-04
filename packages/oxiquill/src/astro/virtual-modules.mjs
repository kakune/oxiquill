import { existsSync, readFileSync } from 'node:fs';
import { normalizePath, pathFromUrl, pathInUrl, relativePathFromUrl } from '../config/paths.mjs';

const moduleIds = new Map([
  ['virtual:oxiquill/cell', '\0virtual:oxiquill/cell'],
  ['virtual:oxiquill/cells', '\0virtual:oxiquill/cells'],
  ['virtual:oxiquill/runtime-version', '\0virtual:oxiquill/runtime-version'],
  ['virtual:oxiquill/runtime-paths', '\0virtual:oxiquill/runtime-paths'],
  ['virtual:oxiquill/rust-wasm', '\0virtual:oxiquill/rust-wasm']
]);

export function oxiquillVirtualModulesPlugin(paths) {
  const cellsJsonFile = pathFromUrl(paths.cellsJsonPath);
  const generatedModules = new Map([
    [
      '\0virtual:oxiquill/cells',
      {
        file: pathFromUrl(paths.cellsModulePath),
        fallback: 'export const cells = [];\n'
      }
    ],
    [
      '\0virtual:oxiquill/runtime-version',
      {
        file: pathFromUrl(paths.runtimeVersionPath),
        fallback: 'export const runtimeVersion = "not-ready";\n'
      }
    ]
  ]);
  const rustWasmFile = pathInUrl(paths.rustWasmPublicDir, 'doc_rust_cells.js');
  const watchedFiles = [...Array.from(generatedModules.values()).map(({ file }) => file), cellsJsonFile, rustWasmFile];
  const changedFileModuleIds = new Map([
    [normalizePath(cellsJsonFile), '\0virtual:oxiquill/cell'],
    [normalizePath(pathFromUrl(paths.cellsModulePath)), '\0virtual:oxiquill/cells'],
    [normalizePath(pathFromUrl(paths.runtimeVersionPath)), '\0virtual:oxiquill/runtime-version'],
    [normalizePath(rustWasmFile), '\0virtual:oxiquill/rust-wasm']
  ]);

  return {
    name: 'oxiquill-virtual-modules',
    resolveId(id) {
      return resolveVirtualModuleId(id);
    },
    load(id) {
      const baseId = baseVirtualModuleId(id);
      if (baseId === '\0virtual:oxiquill/cell') {
        this.addWatchFile(cellsJsonFile);
        const cellId = new URLSearchParams(moduleQuery(id)).get('cellId');
        const cell = readGeneratedCellsJson(cellsJsonFile).find((candidate) => candidate.id === cellId);
        if (!cell) {
          throw new Error(`Oxiquill could not find generated interactive cell ${JSON.stringify(cellId)}.`);
        }

        return `export const cell = ${JSON.stringify(cell)};\n`;
      }

      const generated = generatedModules.get(baseId);
      if (generated) {
        this.addWatchFile(generated.file);
        return existsSync(generated.file) ? readFileSync(generated.file, 'utf8') : generated.fallback;
      }

      if (baseId === '\0virtual:oxiquill/rust-wasm') {
        this.addWatchFile(rustWasmFile);
        if (!existsSync(rustWasmFile)) {
          return [
            'export default async function initRustWasm() {',
            '  throw new Error("Oxiquill Rust/Wasm runtime has not been generated.");',
            '}',
            'export function run_rust_cell() {',
            '  throw new Error("Oxiquill Rust/Wasm runtime has not been generated.");',
            '}'
          ].join('\n');
        }

        return `export { default, run_rust_cell } from "/@fs/${normalizePath(rustWasmFile)}";\n`;
      }
      if (baseId === '\0virtual:oxiquill/runtime-paths') {
        return [
          `export const haskellWasmPath = ${JSON.stringify(publicUrlPath(paths, paths.haskellWasmPublicDir))};`,
          `export const pyodidePath = ${JSON.stringify(publicUrlPath(paths, paths.pyodidePublicDir))};`
        ].join('\n');
      }

      return undefined;
    },
    hotUpdate(options) {
      const resolvedId = changedFileModuleIds.get(normalizePath(options.file));
      if (!resolvedId) return undefined;

      this.environment.hot?.send({
        type: 'custom',
        event: 'oxiquill:manifest-changed',
        data: { module: virtualModuleName(resolvedId) }
      });
      return loadedVirtualModuleNodes(this.environment.moduleGraph, resolvedId, options.modules);
    },
    configureServer(server) {
      server.watcher.add(watchedFiles);
      server.middlewares.use((request, response, next) => {
        const requestUrl = new URL(request.url ?? '/', 'http://localhost');
        if (requestUrl.pathname !== '/__oxiquill/manifest.json') {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(
          JSON.stringify({
            cells: readGeneratedCellsJson(cellsJsonFile),
            runtimeVersion: readGeneratedRuntimeVersion(pathFromUrl(paths.runtimeVersionPath))
          })
        );
      });
    }
  };
}

function publicUrlPath(paths, directory) {
  const relativePath = relativePathFromUrl(paths.publicDir, directory);
  return `${relativePath.split('/').map(encodeURIComponent).join('/')}/`;
}

function resolveVirtualModuleId(id) {
  const [baseId, query = ''] = splitModuleQuery(id);
  const resolvedBaseId = moduleIds.get(baseId);
  return resolvedBaseId ? `${resolvedBaseId}${query}` : undefined;
}

function baseVirtualModuleId(id) {
  return splitModuleQuery(id)[0];
}

function splitModuleQuery(id) {
  const queryIndex = id.indexOf('?');
  return queryIndex === -1 ? [id] : [id.slice(0, queryIndex), id.slice(queryIndex)];
}

function moduleQuery(id) {
  const query = splitModuleQuery(id)[1] ?? '';
  return query.startsWith('?') ? query.slice(1) : query;
}

function loadedVirtualModuleNodes(moduleGraph, resolvedId, watchedModules = []) {
  const nodes = new Set();
  for (const moduleNode of watchedModules) {
    if (isVirtualModuleNode(moduleNode, resolvedId)) nodes.add(moduleNode);
  }

  const exactNode = moduleGraph.getModuleById(resolvedId);
  if (exactNode) nodes.add(exactNode);

  for (const [moduleId, moduleNode] of moduleGraph.idToModuleMap?.entries?.() ?? []) {
    if (isMatchingVirtualModuleId(moduleId, resolvedId)) {
      nodes.add(moduleNode);
    }
  }

  return Array.from(nodes);
}

function isVirtualModuleNode(moduleNode, resolvedId) {
  const ids = [moduleNode.id, moduleNode.url].filter((id) => typeof id === 'string');
  return ids.some((id) => isMatchingVirtualModuleId(id, resolvedId));
}

function isMatchingVirtualModuleId(id, resolvedId) {
  const unwrappedId = id.startsWith('/@id/') ? id.slice('/@id/'.length).replace('__x00__', '\0') : id;
  return unwrappedId === resolvedId || unwrappedId.startsWith(`${resolvedId}?`);
}

function virtualModuleName(resolvedId) {
  return resolvedId.slice('\0virtual:oxiquill/'.length);
}

function readGeneratedCellsJson(file) {
  if (!existsSync(file)) return [];

  return JSON.parse(readFileSync(file, 'utf8'));
}

function readGeneratedRuntimeVersion(file) {
  if (!existsSync(file)) return 'not-ready';

  const match = readFileSync(file, 'utf8').match(/export const runtimeVersion = (.*);/);
  return match ? JSON.parse(match[1]) : 'not-ready';
}
