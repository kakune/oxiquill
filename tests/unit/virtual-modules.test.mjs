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
    const watchedFreshCellsNode = { url: '/@id/__x00__virtual:oxiquill/cells?oxiquill-fresh=2' };
    const unrelatedNode = { id: '/repo/src/lib/doc-runtime/manifest.ts' };
    const versionNode = { id: 'version' };
    const rustNode = { id: 'rust-wasm' };
    const idToModuleMap = new Map([
      ['\0virtual:oxiquill/cells', cellsNode],
      ['\0virtual:oxiquill/cells?oxiquill-fresh=1', freshCellsNode],
      ['\0virtual:oxiquill/runtime-version', versionNode],
      ['\0virtual:oxiquill/rust-wasm', rustNode]
    ]);
    const moduleGraph = {
      getModuleById: vi.fn((id) =>
        new Map([
          ['\0virtual:oxiquill/cells', cellsNode],
          ['\0virtual:oxiquill/runtime-version', versionNode],
          ['\0virtual:oxiquill/rust-wasm', rustNode]
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
    expect(plugin.hotUpdate.call(context, { file: pathFromUrl(paths.runtimeVersionPath) })).toEqual([versionNode]);
    expect(plugin.hotUpdate.call(context, { file: rustWasmFile(paths) })).toEqual([rustNode]);
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

  it('watches generated files without forcing full-page reloads', () => {
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
      rustWasmFile(paths)
    ]);
    expect(server.watcher.on).toHaveBeenCalledWith('change', expect.any(Function));
    expect(server.middlewares.use).toHaveBeenCalledOnce();

    const changeHandler = server.watcher.on.mock.calls[0][1];
    changeHandler(pathFromUrl(paths.cellsModulePath));
    expect(hot.send).toHaveBeenCalledWith({
      type: 'custom',
      event: 'oxiquill:manifest-changed',
      data: { module: 'cells' }
    });
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
        cells: [{ id: 'cell-one' }],
        runtimeVersion: 'version-one'
      });
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
