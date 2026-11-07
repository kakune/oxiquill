// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  it.each(['integration', 'cli'])(
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
      vi.stubEnv('OXIQUILL_RUNTIME_OWNER', owner === 'cli' ? 'cli' : '');
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
      await writeFile(page, '```rust\n//| id: demo\nprintln!("second");\n```');
      await expect(integration.hooks['astro:build:done']({ dir: pathToFileURL(`${paths.outDir}/`) })).rejects.toThrow(
        'cell "demo": source'
      );
    }
  );
});
