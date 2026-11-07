import { resolveRustRegistryUrls, validateRustRegistry } from '../lib/doc-runtime/rust-registry.mjs';
import { parseGeneratedCellManifest } from '../generator/doc-runtime/cell-manifest.mjs';
import { sourceChangedError } from '../generator/doc-runtime/generation-snapshot.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { assertPathWithin, normalizePath, pathFromUrl, pathInUrl, relativePathFromUrl } from '../config/paths.mjs';

const moduleIds = new Map([
  ['virtual:oxiquill/cell', '\0virtual:oxiquill/cell'],
  ['virtual:oxiquill/cells', '\0virtual:oxiquill/cells'],
  ['virtual:oxiquill/runtime-version', '\0virtual:oxiquill/runtime-version'],
  ['virtual:oxiquill/runtime-paths', '\0virtual:oxiquill/runtime-paths']
]);

export function oxiquillVirtualModulesPlugin(paths, { generation, base: astroBase } = {}) {
  let base = astroBase ?? '/';
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
  const watchedFiles = [...Array.from(generatedModules.values()).map(({ file }) => file), cellsJsonFile];
  const changedFileModuleIds = new Map([
    [normalizePath(cellsJsonFile), '\0virtual:oxiquill/cell'],
    [normalizePath(pathFromUrl(paths.cellsModulePath)), '\0virtual:oxiquill/cells'],
    [normalizePath(pathFromUrl(paths.runtimeVersionPath)), '\0virtual:oxiquill/runtime-version']
  ]);

  return {
    name: 'oxiquill-virtual-modules',
    configResolved(config) {
      base = astroBase ?? config.base;
    },
    resolveId(id) {
      return resolveVirtualModuleId(id);
    },
    load(id) {
      const baseId = baseVirtualModuleId(id);
      const expected = generation?.current();
      if (baseId === '\0virtual:oxiquill/cell') {
        this.addWatchFile(cellsJsonFile);
        const cellId = new URLSearchParams(moduleQuery(id)).get('cellId');
        const requestedGeneration = new URLSearchParams(moduleQuery(id)).get('generationId');
        if (expected && requestedGeneration !== expected.generationId) {
          throw sourceChangedError([{ kind: 'changed', path: cellsJsonFile }]);
        }
        const manifest = expected ?? readGeneratedManifest(cellsJsonFile);
        const cell = manifest.cells.find((candidate) => candidate.id === cellId);
        if (!cell) {
          if (expected) throw sourceChangedError([{ kind: 'added', path: cellsJsonFile, cellId }]);
          throw new Error(
            `Interactive cell ${JSON.stringify(cellId)} is not generated yet. The runtime watcher will regenerate it.`
          );
        }

        const rust = manifest.rust ? resolveRustRegistryUrls(manifest.rust, base) : undefined;
        if (rust) validateRustRegistry(rust, manifest.cells);
        const rustModule =
          cell.language === 'rust' ? rust?.modules.find((module) => module.cells.includes(cell.id)) : undefined;
        return `export const cell = ${JSON.stringify(cell)};\nexport const rustModule = ${JSON.stringify(rustModule)};\n`;
      }

      const generated = generatedModules.get(baseId);
      if (generated) {
        this.addWatchFile(generated.file);
        if (expected && baseId === '\0virtual:oxiquill/cells') {
          return `export const generationId = ${JSON.stringify(expected.generationId)};\nexport const cells = ${JSON.stringify(expected.cells)};\n`;
        }
        return existsSync(generated.file) ? readFileSync(generated.file, 'utf8') : generated.fallback;
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
        const requestUrl = new URL(request.originalUrl ?? request.url ?? '/', 'http://localhost');
        const rustPrefix = `${base.replace(/\/?$/u, '/')}${publicUrlPath(paths, paths.rustWasmPublicDir)}`;
        const glueName = requestUrl.pathname.slice(rustPrefix.length);
        if (
          requestUrl.pathname.startsWith(rustPrefix) &&
          /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{64}\.js$/u.test(glueName)
        ) {
          // Vite rejects public/ imports. Serve immutable glue unchanged, including
          // the previous generation while its registry is being replaced.
          const moduleId = glueName.replace(/-[a-f0-9]{64}\.js$/u, '');
          const file = pathInUrl(paths.rustWasmPublicDir, glueName);
          assertPathWithin(paths.rustWasmPublicDir, file, `Rust module ${moduleId} glue`);
          if (!existsSync(file)) {
            response.statusCode = 404;
            response.end(`Rust module ${moduleId} glue asset is missing.`);
            return;
          }
          response.statusCode = 200;
          response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          response.setHeader('Content-Type', 'text/javascript; charset=utf-8');
          response.end(readFileSync(file));
          return;
        }
        if (requestUrl.pathname !== '/__oxiquill/manifest.json') {
          next();
          return;
        }

        response.statusCode = 200;
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Type', 'application/json; charset=utf-8');
        response.end(
          JSON.stringify({
            ...readBrowserManifest(cellsJsonFile, base),
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

function readGeneratedManifest(file) {
  return existsSync(file) ? parseGeneratedCellManifest(readFileSync(file, 'utf8')) : { cells: [] };
}

function readBrowserManifest(file, base) {
  const manifest = readGeneratedManifest(file);
  const rust = resolveRustRegistryUrls(manifest.rust ?? { version: 1, modules: [] }, base);
  if (manifest.rust) validateRustRegistry(rust, manifest.cells);
  return { cells: manifest.cells, rust };
}

function readGeneratedRuntimeVersion(file) {
  if (!existsSync(file)) return 'not-ready';

  const match = readFileSync(file, 'utf8').match(/export const runtimeVersion = (.*);/);
  return match ? JSON.parse(match[1]) : 'not-ready';
}
