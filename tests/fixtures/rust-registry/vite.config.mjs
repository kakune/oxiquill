import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { defineConfig } from 'vite';
import { createOxiquillPaths } from '../../../packages/oxiquill/src/config/paths.mjs';
import { createRustModuleAssets } from '../../../packages/oxiquill/src/generator/doc-runtime/rust-module-assets.mjs';
import { collectAuthoringCells } from '../../../packages/oxiquill/src/generator/doc-runtime/cell-collection.mjs';
import {
  resolveRustRegistryUrls,
  validateRustRegistry
} from '../../../packages/oxiquill/src/lib/doc-runtime/rust-registry.mjs';
import { oxiquillVirtualModulesPlugin } from '../../../packages/oxiquill/src/astro/virtual-modules.mjs';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const paths = createOxiquillPaths({ workspaceRoot: path.join(repository, 'examples/docs-site') });
// Browser CI downloads only the built site, so derive this fixture from its compiled
// assets and the checked-in cell sources without requiring Cargo or generated caches.
const directory = path.join(paths.outDir, path.relative(paths.publicDir, paths.rustWasmPublicDir));
const wasmName = readdirSync(directory).find((name) => /^site-[a-f0-9]+\.wasm$/u.test(name));
const glueName = readdirSync(directory).find((name) => /^site-[a-f0-9]+\.js$/u.test(name));
if (!wasmName || !glueName) throw new Error('Build the docs site before running the Rust registry browser fixture.');
const wasm = readFileSync(path.join(directory, wasmName));
const glue = readFileSync(path.join(directory, glueName), 'utf8').replaceAll(wasmName, 'doc_rust_cells_bg.wasm');
const authored = await collectAuthoringCells({ paths, pythonOptions: { experimentalSetup: true } });
const cells = ['__run-mode-button', '__logistic-rust'].map((suffix) => {
  const cell = authored.find((candidate) => candidate.id.endsWith(suffix));
  if (!cell) throw new Error(`Missing Rust registry fixture cell ${suffix}`);
  return { ...cell, sourceHtml: '', timeoutMs: 30_000 };
});
const assets = [
  createRustModuleAssets({ id: 'first', cells: [cells[0]], glue, wasm, publicPath: 'modules' }),
  createRustModuleAssets({ id: 'second', cells: [cells[1]], glue, wasm, publicPath: 'modules' }),
  createRustModuleAssets({
    id: 'first',
    cells: [cells[0]],
    glue: `${glue}\n// Replacement generation\n`,
    wasm,
    publicPath: 'modules'
  })
];
const registry = resolveRustRegistryUrls(
  { version: 1, modules: assets.slice(0, 2).map((asset) => asset.module) },
  '/registry-base/'
);
const replacement = resolveRustRegistryUrls(
  { version: 1, modules: [assets[2].module, assets[1].module] },
  '/registry-base/'
);
validateRustRegistry(registry, cells);
validateRustRegistry(replacement, cells);
const files = Object.assign({}, ...assets.map((asset) => asset.files));
const fixturePlugin = {
  name: 'rust-registry-fixture',
  resolveId(id) {
    return id === 'fixture:registry' ? '\0fixture:registry' : undefined;
  },
  load(id) {
    return id === '\0fixture:registry'
      ? `export const fixture = ${JSON.stringify({ cells, registry, replacement })};`
      : undefined;
  },
  configureServer(server) {
    server.middlewares.use((request, response, next) => {
      const file = files[path.basename(new URL(request.url, 'http://fixture').pathname)];
      if (!file) return next();
      response.setHeader('Content-Type', Buffer.isBuffer(file) ? 'application/wasm' : 'text/javascript');
      response.end(file);
    });
  }
};

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  base: '/registry-base/',
  plugins: [fixturePlugin, oxiquillVirtualModulesPlugin(paths)],
  worker: { plugins: () => [oxiquillVirtualModulesPlugin(paths)] },
  server: { port: 4324, strictPort: true, fs: { allow: [repository] } }
});
