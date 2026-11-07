// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acquireRuntimeLock, readRuntimeLock } from '../../packages/oxiquill/src/generator/runtime-lock.mjs';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { readGenerationSnapshot } from '../../packages/oxiquill/src/generator/doc-runtime/generation-snapshot.mjs';

const mocks = vi.hoisted(() => ({ generate: vi.fn(), context: vi.fn() }));
vi.mock('astro/config', () => ({ defineConfig: (config) => config }));
vi.mock('@astrojs/preact', () => ({ default: () => ({ hooks: {}, name: '@astrojs/preact' }) }));
vi.mock('../../packages/oxiquill/src/generator/doc-runtime-service.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  createDocRuntimeContext: mocks.context,
  syncDocRuntime: mocks.generate,
  syncLicenseArtifacts: vi.fn()
}));
vi.mock('../../packages/oxiquill/src/generator/browser-bundle-report.mjs', async (importOriginal) => ({
  ...(await importOriginal()),
  syncBrowserBundleReport: vi.fn()
}));
vi.mock('../../packages/oxiquill/src/generator/cleanup-ownership.mjs', () => ({
  preflightCleanupOwnership: vi.fn(async () => undefined),
  prepareCleanupOwnership: vi.fn(async () => []),
  maintainCleanupOwnership: vi.fn()
}));
const { oxiquillIntegration } = await import('../../packages/oxiquill/src/astro/index.ts');
const roots = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe('production build hooks', () => {
  it('releases its own lock if runtime generation fails', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-build-failure-'));
    roots.push(root);
    const paths = createOxiquillPaths({ workspaceRoot: root });
    mocks.context.mockResolvedValue({ paths });
    mocks.generate.mockRejectedValueOnce(new Error('compiler failed'));
    vi.stubEnv('OXIQUILL_RUNTIME_OWNER', '');
    const integration = oxiquillIntegration({ paths: { workspaceRoot: root } });
    integration.hooks['astro:config:setup']({
      command: 'build',
      config: { root: pathToFileURL(`${root}/`) },
      addWatchFile: vi.fn(),
      injectScript: vi.fn(),
      updateConfig: vi.fn()
    });
    await expect(integration.hooks['astro:build:start']()).rejects.toThrow('compiler failed');
    expect(readRuntimeLock(path.join(paths.cacheDir, 'runtime.lock')).exists).toBe(false);
  });

  it.each(['integration', 'cli', 'unverified-cli'])(
    'validates the %s generation through transforms and build completion',
    async (owner) => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'oxiquill-build-hooks-'));
      roots.push(root);
      const paths = createOxiquillPaths({ workspaceRoot: root });
      await mkdir(paths.docsDir, { recursive: true });
      await mkdir(paths.generatedDir, { recursive: true });
      const page = path.join(paths.docsDir, 'index.mdx');
      await writeFile(page, '```rust\n//| id: demo\nprintln!("first");\n```');
      const snapshot = await readGenerationSnapshot({ paths });
      await writeFile(
        paths.cellsJsonPath,
        JSON.stringify({ generationId: snapshot.generationId, cells: snapshot.cells })
      );
      await writeFile(paths.runtimeOwnershipPath, JSON.stringify({ generationId: snapshot.generationId, snapshot }));
      const lease = owner === 'cli' ? await acquireRuntimeLock({ paths, command: 'build' }) : undefined;
      vi.stubEnv('OXIQUILL_LOCK_TOKEN', lease?.token ?? 'unverified');
      vi.stubEnv('OXIQUILL_RUNTIME_OWNER', owner === 'integration' ? '' : 'cli');
      vi.stubEnv('OXIQUILL_GENERATION_ID', owner === 'cli' ? snapshot.generationId : '');
      mocks.context.mockResolvedValue({ paths });
      mocks.generate.mockResolvedValue({ generationId: snapshot.generationId });
      const integration = oxiquillIntegration({ paths: { workspaceRoot: root } });
      let update;
      integration.hooks['astro:config:setup']({
        command: 'build',
        config: { root: pathToFileURL(`${root}/`) },
        addWatchFile: vi.fn(),
        injectScript: vi.fn(),
        updateConfig: (value) => {
          update = value;
        }
      });
      await integration.hooks['astro:build:start']();
      integration.hooks['astro:config:done']({
        config: {
          base: '/manual/',
          site: 'https://example.test',
          trailingSlash: 'always',
          build: { format: 'directory' },
          redirects: { '/old': '/new' },
          markdown: { processor: { name: 'custom' } }
        },
        injectTypes: vi.fn()
      });
      expect(readRuntimeLock(path.join(paths.cacheDir, 'runtime.lock')).exists).toBe(true);
      expect(mocks.generate).toHaveBeenCalledTimes(owner === 'cli' ? 0 : 1);
      const plugin = update.vite.plugins.find(({ name }) => name === 'oxiquill-virtual-modules');
      const loaded = plugin.load.call(
        { addWatchFile: vi.fn() },
        `\0virtual:oxiquill/cell?cellId=index__demo&generationId=${snapshot.generationId}`
      );
      expect(loaded).toContain('println!');
      await expect(
        integration.hooks['astro:build:done']({ dir: pathToFileURL(`${paths.outDir}/`) })
      ).resolves.toBeUndefined();
      expect(readRuntimeLock(path.join(paths.cacheDir, 'runtime.lock')).exists).toBe(owner === 'cli');
      const reportPath = path.join(paths.cacheDir, 'build-report.json');
      const report = await readFile(reportPath, 'utf8');
      expect(JSON.parse(report)).toMatchObject({
        outDir: paths.outDir,
        base: '/manual/',
        redirects: { '/old': '/new' }
      });
      await writeFile(page, '```rust\n//| id: demo\nprintln!("second");\n```');
      await expect(integration.hooks['astro:build:done']({ dir: pathToFileURL(`${paths.outDir}/`) })).rejects.toThrow(
        'cell "demo": source'
      );
      expect(await readFile(reportPath, 'utf8')).toBe(report);
      lease?.release();
    }
  );
});
