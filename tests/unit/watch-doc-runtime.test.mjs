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
  it('skips synchronization until a relevant filesystem event arrives', async () => {
    const { handlers, services } = createServices({
      syncDocRuntime: vi.fn(async () =>
        runtimeSummary({
          cellCount: 2,
          haskellBuildResult: { ok: false, error: new Error('compiler failed') },
          haskellPlan: 'build',
          rustPlan: 'build'
        })
      )
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await main(['--skip-initial'], services);

    expect(services.prepareCleanupOwnership).toHaveBeenCalledWith({
      configFile: undefined,
      fields: ['cacheDir', 'publicAssetsDir'],
      paths
    });
    expect(services.watch).toHaveBeenCalledWith(
      expect.arrayContaining([expect.any(String)]),
      expect.objectContaining({
        cwd: workspaceRoot,
        ignored: expect.any(Function),
        ignoreInitial: true
      })
    );
    expect(handlers.has('all')).toBe(true);
    expect(handlers.has('ready')).toBe(true);
    expect(services.createDocRuntimeContext).not.toHaveBeenCalled();
    expect(services.syncDocRuntime).not.toHaveBeenCalled();

    handlers.get('ready')();
    handlers.get('all')('change', path.join(root, 'README.md'));
    await flushMicrotasks();

    expect(services.syncDocRuntime).not.toHaveBeenCalled();

    handlers.get('all')('change', path.join(workspaceRoot, 'content/docs/index.mdx'));
    await waitForCallCount(services.syncDocRuntime, 1);

    expect(services.syncDocRuntime).toHaveBeenCalledOnce();
    expect(services.syncDocRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        forceRustBuild: false,
        mode: 'dev',
        paths,
        tolerateHaskellBuildFailure: true
      })
    );
    expect(warning).toHaveBeenCalledWith('[runtime] Haskell/WASI runtime unavailable: compiler failed');
    expect(log).toHaveBeenCalledWith('[runtime] watching documentation and helper-crate inputs');
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining('baseline ready'));
  });

  it('registers watcher handlers before queuing exactly one initial documentation sync', async () => {
    const registrationsAtSync = [];
    const { handlers, services } = createServices({
      syncDocRuntime: vi.fn(async () => {
        registrationsAtSync.push(new Set(handlers.keys()));
        return runtimeSummary();
      })
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], services);
    await waitForCallCount(services.syncDocRuntime, 1);
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenCalledOnce();
    expect(registrationsAtSync).toEqual([new Set(['all', 'ready'])]);
    expect(services.syncDocRuntime).toHaveBeenCalledWith(
      expect.objectContaining({
        forceRustBuild: false,
        mode: 'dev',
        tolerateHaskellBuildFailure: true
      })
    );
  });

  it('coalesces events received during the initial sync and reuses its highlighter', async () => {
    const firstSync = createDeferred();
    const highlighter = {};
    const { handlers, services } = createServices({
      createDocRuntimeContext: vi
        .fn()
        .mockResolvedValueOnce({ highlighter, paths })
        .mockResolvedValueOnce({ highlighter, paths }),
      syncDocRuntime: vi
        .fn()
        .mockImplementationOnce(async () => firstSync.promise)
        .mockResolvedValueOnce(runtimeSummary({ cellCount: 2, haskellPlan: 'build', rustPlan: 'build' }))
    });
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], services);
    await waitForCallCount(services.syncDocRuntime, 1);

    handlers.get('all')('change', path.join(workspaceRoot, 'content/docs/index.mdx'));
    handlers.get('all')('change', path.join(workspaceRoot, 'crates/doc-rust/src/lib.rs'));
    handlers.get('all')('change', path.join(workspaceRoot, 'content/docs/guide.mdx'));
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenCalledOnce();

    firstSync.resolve(runtimeSummary());
    await waitForCallCount(services.syncDocRuntime, 2);
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenCalledTimes(2);
    expect(services.createDocRuntimeContext).toHaveBeenNthCalledWith(1, { highlighter: undefined, paths });
    expect(services.createDocRuntimeContext).toHaveBeenNthCalledWith(2, { highlighter, paths });
    expect(services.syncDocRuntime).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ forceRustBuild: true, mode: 'dev', tolerateHaskellBuildFailure: true })
    );
    expect(log).toHaveBeenCalledWith('[runtime] rebuilt Rust/Wasm cells');
    expect(log).toHaveBeenCalledWith('[runtime] rebuilt Haskell/WASI cells');
  });

  it('rebuilds for helper data-file add, change, and unlink events while ignoring generated paths', async () => {
    const { handlers, services } = createServices({
      syncDocRuntime: vi.fn(async () => runtimeSummary({ rustPlan: 'build' }))
    });
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main(['--skip-initial'], services);
    const watchOptions = services.watch.mock.calls[0][1];
    const assetPath = path.join(workspaceRoot, 'crates/doc-rust/assets/help.txt');
    const targetPath = path.join(workspaceRoot, 'crates/doc-rust/target/debug/generated.rs');
    expect(watchOptions.ignored(assetPath)).toBe(false);
    expect(watchOptions.ignored(targetPath)).toBe(true);

    for (const event of ['add', 'change', 'unlink']) {
      const expectedCallCount = services.syncDocRuntime.mock.calls.length + 1;
      handlers.get('all')(event, assetPath);
      await waitForCallCount(services.syncDocRuntime, expectedCallCount);
      expect(services.syncDocRuntime).toHaveBeenLastCalledWith(expect.objectContaining({ forceRustBuild: true }));
    }

    handlers.get('all')('addDir', path.dirname(assetPath));
    handlers.get('all')('change', targetPath);
    await flushMicrotasks();
    expect(services.syncDocRuntime).toHaveBeenCalledTimes(3);
  });
});

function createServices({ createDocRuntimeContext, syncDocRuntime }) {
  const handlers = new Map();
  const watcher = {
    on: vi.fn((event, handler) => {
      handlers.set(event, handler);
      return watcher;
    })
  };
  const services = {
    createDocRuntimeContext: createDocRuntimeContext ?? vi.fn(async () => ({ highlighter: {}, paths })),
    loadProjectConfig: vi.fn(async () => ({ paths })),
    prepareCleanupOwnership: vi.fn(async () => []),
    syncDocRuntime,
    watch: vi.fn(() => watcher)
  };

  return { handlers, services, watcher };
}

function runtimeSummary({ cellCount = 0, haskellBuildResult, haskellPlan = 'keep', rustPlan = 'keep' } = {}) {
  return {
    cellCount,
    haskellBuildResult,
    plan: { languages: { haskell: { public: haskellPlan }, rust: { public: rustPlan } } }
  };
}

function createDeferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function waitForCallCount(mock, count) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (mock.mock.calls.length >= count) return;
    await Promise.resolve();
  }
  throw new Error(`Expected ${count} call(s), received ${mock.mock.calls.length}.`);
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
