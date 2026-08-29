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
    const initial = { cellCount: 1, haskellFingerprint: 'old', rustFingerprint: 'old' };
    const current = { cellCount: 2, haskellFingerprint: 'new', rustFingerprint: 'new' };
    const services = {
      buildHaskellWasm: vi.fn(async () => ({ ok: false, error: new Error('compiler failed') })),
      buildRustWasm: vi.fn(async () => undefined),
      createDocRuntimeContext: vi.fn(async () => ({ highlighter: {}, paths })),
      markRuntimeReady: vi.fn(async () => undefined),
      shouldBuildHaskellWasm: vi.fn(() => true),
      shouldBuildWasm: vi.fn(() => true),
      syncDocRuntime: vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(current),
      syncLicenseArtifacts: vi.fn(async () => undefined),
      watch: vi.fn(() => watcher)
    };
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await main(['--skip-initial'], services);

    expect(services.watch).toHaveBeenCalledWith(expect.arrayContaining([expect.any(String)]), {
      cwd: workspaceRoot,
      ignoreInitial: true
    });
    handlers.get('ready')();
    handlers.get('all')('change', path.join(root, 'README.md'));
    expect(services.syncDocRuntime).toHaveBeenCalledTimes(1);

    handlers.get('all')('change', path.join(root, 'examples/docs-site/content/docs/index.mdx'));
    await flushMicrotasks();

    expect(services.buildRustWasm).toHaveBeenCalledWith({ mode: 'dev', paths });
    expect(services.buildHaskellWasm).toHaveBeenCalledWith({
      haskellFingerprint: 'new',
      mode: 'dev',
      paths,
      tolerateFailure: true
    });
    expect(services.syncLicenseArtifacts).toHaveBeenCalledWith({ paths });
    expect(services.markRuntimeReady).toHaveBeenCalledWith({ paths, summary: current });
    expect(warning).toHaveBeenCalledWith('[runtime] Haskell/WASI runtime unavailable: compiler failed');
    expect(log).toHaveBeenCalledWith('[runtime] watching MDX, Rust, and Haskell cell sources');
  });

  it('queues an initial documentation sync when no baseline is requested', async () => {
    const watcher = { on: vi.fn(() => watcher) };
    const services = {
      buildHaskellWasm: vi.fn(),
      buildRustWasm: vi.fn(),
      createDocRuntimeContext: vi.fn(async () => ({ highlighter: {}, paths })),
      markRuntimeReady: vi.fn(async () => undefined),
      shouldBuildHaskellWasm: vi.fn(() => false),
      shouldBuildWasm: vi.fn(() => false),
      syncDocRuntime: vi.fn(async () => ({ cellCount: 0, haskellFingerprint: '', rustFingerprint: '' })),
      syncLicenseArtifacts: vi.fn(async () => undefined),
      watch: vi.fn(() => watcher)
    };
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main([], services);
    await flushMicrotasks();

    expect(services.syncDocRuntime).toHaveBeenCalledTimes(1);
    expect(services.buildRustWasm).not.toHaveBeenCalled();
    expect(services.buildHaskellWasm).not.toHaveBeenCalled();
    expect(services.markRuntimeReady).toHaveBeenCalled();
  });
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
