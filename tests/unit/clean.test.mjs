// @vitest-environment node

import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { cleanOxiquillWorkspace } from '../../packages/oxiquill/src/generator/clean.mjs';

describe('Oxiquill cleanup', () => {
  it('removes only exact resolved Oxiquill and Astro output paths', async () => {
    const root = path.resolve('/repo');
    const paths = createOxiquillPaths({
      cacheDir: 'custom-cache',
      outDir: 'custom-output',
      publicAssetsDir: 'custom-assets',
      workspaceRoot: root
    });
    const fileSystem = { rm: vi.fn(async () => undefined) };

    await cleanOxiquillWorkspace({ fileSystem, paths });

    expect(fileSystem.rm.mock.calls).toEqual(
      expect.arrayContaining([
        [path.join(root, 'custom-cache'), { force: true, recursive: true }],
        [path.join(root, 'custom-output'), { force: true, recursive: true }],
        [path.join(root, 'public/custom-assets'), { force: true, recursive: true }]
      ])
    );
    expect(fileSystem.rm).toHaveBeenCalledTimes(3);
  });

  it('validates every target before deleting anything', async () => {
    const root = path.resolve('/repo');
    const paths = {
      ...createOxiquillPaths({ workspaceRoot: root }),
      cacheDir: root
    };
    const fileSystem = { rm: vi.fn(async () => undefined) };

    await expect(cleanOxiquillWorkspace({ fileSystem, paths })).rejects.toThrow(
      'cacheDir must resolve to a directory inside'
    );
    expect(fileSystem.rm).not.toHaveBeenCalled();
    await expect(cleanOxiquillWorkspace()).rejects.toThrow('requires resolved project paths');
  });
});
