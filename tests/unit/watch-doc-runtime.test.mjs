// @vitest-environment node

import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { main } from '../../packages/oxiquill/src/generator/watch-doc-runtime.mjs';

const root = process.cwd();
const workspaceRoot = path.join(root, 'examples/docs-site');
const paths = createOxiquillPaths({ workspaceRoot });

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('runtime watcher entrypoint', () => {
  it('rebuilds changed Rust and Haskell runtimes from a ready baseline', async () => {
    const handlers = new Map();
    const watcher = {
      on: vi.fn((event, handler) => {
        handlers.set(event, handler);
        return watcher;
      })
    };
    const initial = {
      cellCount: 1,
      plan: { languages: { haskell: { public: 'keep' }, rust: { public: 'keep' } } }
    };
    const current = {
      cellCount: 2,
      haskellBuildResult: { ok: false, error: new Error('compiler failed') },
      plan: { languages: { haskell: { public: 'build' }, rust: { public: 'build' } } }
    };
    const services = {
      createDocRuntimeContext: vi.fn(async () => ({ highlighter: {}, paths })),
      loadProjectConfig: vi.fn(async () => ({ paths })),
      prepareCleanupOwnership: vi.fn(async () => []),
      syncDocRuntime: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(current),
      watch: vi.fn(() => watcher)
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await main(['--skip-initial'], services);

    expect(services.prepareCleanupOwnership).toHaveBeenCalledWith({
      configFile: undefined,
      fields: ['cacheDir', 'publicAssetsDir'],
      paths
    });
    expect(services.watch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]), {
      cwd: workspaceRoot,
      ignoreInitial: true
    });
    handlers.get('ready')();
    handlers.get('all')('change', path.join(root, 'README.md'));
    expect(services.syncDocRuntime).toHaveBeenCalledTimes(1);

    handlers.get('all')('change', path.join(root, 'examples/docs-site/content/docs/index.mdx'));
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenLastCalledWith(
      expect.objectContaining({
        forceRustBuild: false,
        mode: 'dev',
        paths,
        tolerateHaskellBuildFailure: true
      })
    );
    expect(warning).toHaveBeenCalledWith('[runtime] Haskell/WASI runtime unavailable: compiler failed');
    expect(log).toHaveBeenCalledWith('[runtime] watching MDX, Rust, and Haskell cell sources');
  });

  it('queues an initial documentation sync when no baseline is requested', async () => {
    const watcher = { on: vi.fn(() => watcher) };
    const services = {
      createDocRuntimeContext: vi.fn(async () => ({ highlighter: {}, paths })),
      loadProjectConfig: vi.fn(async () => ({ paths })),
      prepareCleanupOwnership: vi.fn(async () => []),
      syncDocRuntime: vi.fn(async () => ({
        cellCount: 0,
        plan: { languages: { haskell: { public: 'keep' }, rust: { public: 'keep' } } }
      })),
      watch: vi.fn(() => watcher)
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], services);
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenCalledTimes(1);
    expect(services.syncDocRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'dev', tolerateHaskellBuildFailure: true })
    );
  });
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
