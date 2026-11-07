import { createRustModuleAssets } from '../../packages/oxiquill/src/generator/doc-runtime/rust-module-assets.mjs';
import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathFromUrl, pathInUrl } from '../../packages/oxiquill/src/config/paths.mjs';
import { oxiquillVirtualModulesPlugin } from '../../packages/oxiquill/src/astro/virtual-modules.mjs';
import { createDocRuntimePaths } from '../../packages/oxiquill/src/generator/doc-runtime-service.mjs';

function createPlugin() {
  const paths = createDocRuntimePaths('/repo');
  return {
    paths,
    plugin: oxiquillVirtualModulesPlugin(paths)
  };
}

function rustWasmFile(paths) {
  return pathInUrl(paths.rustWasmPublicDir, 'doc_rust_cells.js');
}

describe('oxiquill virtual modules', () => {
  it('maps generated file updates to the matching virtual module', () => {
    const { paths, plugin } = createPlugin();
    const cellsNode = { id: 'cells' };
    const freshCellsNode = { id: 'fresh-cells' };
    const singleCellNode = { id: 'single-cell' };
    const watchedFreshCellsNode = { url: '/@id/__x00__virtual:oxiquill/cells?oxiquill-fresh=2' };
    const unrelatedNode = { id: '/repo/src/lib/doc-runtime/manifest.ts' };
    const versionNode = { id: 'version' };
    const idToModuleMap = new Map([
      ['\0virtual:oxiquill/cells', cellsNode],
      ['\0virtual:oxiquill/cells?oxiquill-fresh=1', freshCellsNode],
      ['\0virtual:oxiquill/cell?cellId=page__one', singleCellNode],
      ['\0virtual:oxiquill/runtime-version', versionNode]
    ]);
    const moduleGraph = {
      getModuleById: vi.fn((id) =>
        new Map([
          ['\0virtual:oxiquill/cells', cellsNode],
          ['\0virtual:oxiquill/cell', undefined],
          ['\0virtual:oxiquill/runtime-version', versionNode]
        ]).get(id)
      ),
      idToModuleMap
    };
    const hot = { send: vi.fn() };
    const context = { environment: { hot, moduleGraph } };

    expect(
      plugin.hotUpdate.call(context, {
        file: pathFromUrl(paths.cellsModulePath),
        modules: [unrelatedNode, watchedFreshCellsNode]
      })
    ).toEqual([watchedFreshCellsNode, cellsNode, freshCellsNode]);
    expect(hot.send).toHaveBeenCalledWith({
      type: 'custom',
      event: 'oxiquill:manifest-changed',
      data: { module: 'cells' }
    });
    expect(hot.send).toHaveBeenCalledTimes(1);
    expect(plugin.hotUpdate.call(context, { file: pathFromUrl(paths.runtimeVersionPath) })).toEqual([versionNode]);
    expect(plugin.hotUpdate.call(context, { file: pathFromUrl(paths.cellsJsonPath) })).toEqual([singleCellNode]);
    expect(plugin.hotUpdate.call(context, { file: rustWasmFile(paths) })).toBeUndefined();
    expect(plugin.hotUpdate.call(context, { file: '/repo/content/docs/index.mdx' })).toBeUndefined();
  });

  it('serves query-suffixed virtual modules from the same generated files', () => {
    const { plugin } = createPlugin();
    const context = { addWatchFile: vi.fn() };

    expect(plugin.resolveId('virtual:oxiquill/cells?oxiquill-fresh=1')).toBe(
      '\0virtual:oxiquill/cells?oxiquill-fresh=1'
    );
    expect(plugin.resolveId('virtual:oxiquill/runtime-version?oxiquill-fresh=1')).toBe(
      '\0virtual:oxiquill/runtime-version?oxiquill-fresh=1'
    );
    expect(plugin.load.call(context, '\0virtual:oxiquill/cells?oxiquill-fresh=1')).toBe('export const cells = [];\n');
    expect(plugin.load.call(context, '\0virtual:oxiquill/runtime-version?oxiquill-fresh=1')).toBe(
      'export const runtimeVersion = "not-ready";\n'
    );
    expect(context.addWatchFile).toHaveBeenCalledTimes(2);
  });

  it('exposes encoded public runtime paths from the resolved directories', () => {
    const paths = createDocRuntimePaths({
      haskellWasmPublicDir: 'compiled haskell',
      publicAssetsDir: 'runtime assets',
      pyodidePublicDir: 'python runtime',
      workspaceRoot: '/repo'
    });
    const plugin = oxiquillVirtualModulesPlugin(paths);

    expect(plugin.resolveId('virtual:oxiquill/runtime-paths')).toBe('\0virtual:oxiquill/runtime-paths');
    expect(plugin.load('\0virtual:oxiquill/runtime-paths')).toContain('runtime%20assets/compiled%20haskell/');
    expect(plugin.load('\0virtual:oxiquill/runtime-paths')).toContain('runtime%20assets/python%20runtime/');
  });

  it('captures the routed descriptor under Astro base without importing runtime assets', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oxiquill-registry-base-'));
    try {
      const paths = createDocRuntimePaths(root);
      const cells = [
        { id: 'rust-a', language: 'rust' },
        { id: 'rust-b', language: 'rust' }
      ];
      const modules = cells.map(
        (cell, index) =>
          createRustModuleAssets({
            id: `module-${index}`,
            cells: [cell],
            glue: 'glue',
            wasm: Buffer.from('wasm'),
            publicPath: 'custom%20assets/rust'
          }).module
      );
      mkdirSync(path.dirname(paths.cellsJsonPath), { recursive: true });
      writeFileSync(paths.cellsJsonPath, JSON.stringify({ cells, rust: { version: 1, modules } }));
      const plugin = oxiquillVirtualModulesPlugin(paths, { base: '/nested/base/' });
      plugin.configResolved({ base: '/' });
      const source = plugin.load.call({ addWatchFile: vi.fn() }, '\0virtual:oxiquill/cell?cellId=rust-b');
      expect(source).toContain(`/nested/base/${modules[1].glue.url}`);
      expect(source).toContain(modules[1].fingerprint);
      expect(source).not.toContain(modules[0].fingerprint);
      expect(source).not.toContain('import ');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('serves registered public glue byte-for-byte before Vite import transforms, including under base', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oxiquill-registry-glue-'));
    try {
      const paths = createDocRuntimePaths(root);
      const cells = [{ id: 'rust-a', language: 'rust' }];
      const assets = createRustModuleAssets({
        id: 'site',
        cells,
        glue: 'export default async () => {};',
        wasm: Buffer.from('wasm'),
        publicPath: 'oxiquill/rust-wasm'
      });
      mkdirSync(path.dirname(paths.cellsJsonPath), { recursive: true });
      mkdirSync(paths.rustWasmPublicDir, { recursive: true });
      writeFileSync(paths.cellsJsonPath, JSON.stringify({ cells, rust: { version: 1, modules: [assets.module] } }));
      const [name, content] = Object.entries(assets.files).find(([name]) => name.endsWith('.js'));
      writeFileSync(path.join(paths.rustWasmPublicDir, name), content);
      const plugin = oxiquillVirtualModulesPlugin(paths);
      plugin.configResolved({ base: '/nested/base/' });
      let middleware;
      plugin.configureServer({
        watcher: { add: vi.fn() },
        middlewares: {
          use: (handler) => {
            middleware = handler;
          }
        }
      });
      const response = { statusCode: 0, end: vi.fn(), setHeader: vi.fn() };
      const next = vi.fn();
      middleware({ url: `/nested/base/${assets.module.glue.url}?import` }, response, next);
      expect(response.statusCode).toBe(200);
      expect(response.end.mock.calls[0][0].toString()).toBe(content);
      expect(response.setHeader).toHaveBeenCalledWith('Content-Type', 'text/javascript; charset=utf-8');
      expect(next).not.toHaveBeenCalled();
      middleware(
        { url: `/${assets.module.glue.url}?import`, originalUrl: `/nested/base/${assets.module.glue.url}?import` },
        response,
        next
      );
      expect(response.statusCode).toBe(200);
      expect(response.end.mock.lastCall[0].toString()).toBe(content);
      middleware({ url: '/unrelated.js' }, response, next);
      expect(next).toHaveBeenCalledOnce();
      rmSync(paths.cellsJsonPath);
      middleware({ url: `/nested/base/${assets.module.glue.url}?import` }, response, next);
      expect(response.statusCode).toBe(200);
      expect(response.end.mock.lastCall[0].toString()).toBe(content);
      rmSync(path.join(paths.rustWasmPublicDir, name));
      middleware({ url: `/nested/base/${assets.module.glue.url}` }, response, next);
      expect(response.statusCode).toBe(404);
      expect(response.end).toHaveBeenLastCalledWith('Rust module site glue asset is missing.');
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('serves one generated cell per page import', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oxiquill-virtual-cell-'));

    try {
      const paths = createDocRuntimePaths(root);
      mkdirSync(path.dirname(pathFromUrl(paths.cellsJsonPath)), { recursive: true });
      writeFileSync(
        pathFromUrl(paths.cellsJsonPath),
        JSON.stringify([
          { id: 'page__first', source: 'first' },
          { id: 'page__second', source: 'second' }
        ])
      );
      const plugin = oxiquillVirtualModulesPlugin(paths);
      const context = { addWatchFile: vi.fn() };
      const moduleId = 'virtual:oxiquill/cell?cellId=page__second';

      expect(plugin.resolveId(moduleId)).toBe('\0virtual:oxiquill/cell?cellId=page__second');
      expect(plugin.load.call(context, plugin.resolveId(moduleId))).toBe(
        'export const cell = {"id":"page__second","source":"second"};\nexport const rustModule = undefined;\n'
      );
      expect(context.addWatchFile).toHaveBeenCalledWith(pathFromUrl(paths.cellsJsonPath));
      expect(() => plugin.load.call(context, '\0virtual:oxiquill/cell?cellId=page__missing')).toThrow(
        'Interactive cell "page__missing" is not generated yet. The runtime watcher will regenerate it.'
      );
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it('registers generated files without installing a duplicate raw change sender', () => {
    const { paths, plugin } = createPlugin();
    const hot = { send: vi.fn() };
    const server = {
      environments: {
        client: { hot }
      },
      middlewares: {
        use: vi.fn()
      },
      watcher: {
        add: vi.fn(),
        on: vi.fn()
      }
    };

    plugin.configureServer(server);

    expect(server.watcher.add).toHaveBeenCalledWith([
      pathFromUrl(paths.cellsModulePath),
      pathFromUrl(paths.runtimeVersionPath),
      pathFromUrl(paths.cellsJsonPath)
    ]);
    expect(server.watcher.on).not.toHaveBeenCalled();
    expect(server.middlewares.use).toHaveBeenCalledOnce();
    expect(hot.send).not.toHaveBeenCalled();
    expect(hot.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'full-reload' }));
  });

  it('suppresses generated-file HMR when no client has loaded the virtual module', () => {
    const { paths, plugin } = createPlugin();
    const moduleGraph = { getModuleById: vi.fn(() => undefined) };
    const context = { environment: { moduleGraph } };

    expect(plugin.hotUpdate.call(context, { file: pathFromUrl(paths.cellsModulePath) })).toEqual([]);
  });

  it('serves the generated manifest endpoint without caching', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'oxiquill-virtual-modules-'));

    try {
      const paths = createDocRuntimePaths(root);
      const generatedDir = pathFromUrl(paths.generatedDir);
      mkdirSync(generatedDir, { recursive: true });
      writeFileSync(pathFromUrl(paths.cellsJsonPath), JSON.stringify([{ id: 'cell-one' }]));
      writeFileSync(pathFromUrl(paths.runtimeVersionPath), 'export const runtimeVersion = "version-one";\n');

      const plugin = oxiquillVirtualModulesPlugin(paths);
      const middlewareHandlers = [];
      plugin.configureServer({
        environments: {
          client: { hot: { send: vi.fn() } }
        },
        middlewares: {
          use: vi.fn((handler) => middlewareHandlers.push(handler))
        },
        watcher: {
          add: vi.fn(),
          on: vi.fn()
        }
      });

      let body = '';
      const response = {
        end: vi.fn((value) => {
          body = value;
        }),
        setHeader: vi.fn(),
        statusCode: 0
      };
      middlewareHandlers[0]({ url: '/__oxiquill/manifest.json?fresh=1' }, response, vi.fn());

      expect(response.statusCode).toBe(200);
      expect(response.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
      expect(JSON.parse(body)).toEqual({
        rust: { version: 1, modules: [] },
        cells: [{ id: 'cell-one' }],
        runtimeVersion: 'version-one'
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
