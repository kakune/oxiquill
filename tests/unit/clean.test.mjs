// @vitest-environment node

import { access, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';
import { cleanOxiquillWorkspace } from '../../packages/oxiquill/src/generator/clean.mjs';

describe('workspace cleaner', () => {
  it('removes only owned generated and explicitly supplied paths', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'oxiquill-clean-'));
    const paths = {
      cacheDir: pathToFileURL(path.join(root, '.oxiquill/')),
      publicAssetsDir: pathToFileURL(path.join(root, 'public/oxiquill/')),
      workspaceRoot: pathToFileURL(`${root}/`)
    };
    const targets = [
      path.join(root, '.oxiquill'),
      path.join(root, 'public/oxiquill'),
      path.join(root, 'dist'),
      path.join(root, '.astro'),
      path.join(root, 'playwright-report'),
      path.join(root, 'test-results'),
      path.join(root, 'extra')
    ];
    const preserved = path.join(root, 'content', 'index.mdx');

    await Promise.all(targets.map((target) => mkdir(target, { recursive: true })));
    await mkdir(path.dirname(preserved), { recursive: true });
    await writeFile(preserved, '# Preserved\n');

    await cleanOxiquillWorkspace({ paths, extraPaths: [path.join(root, 'extra')] });

    await expect(access(preserved)).resolves.toBeUndefined();
    await Promise.all(targets.map((target) => expect(access(target)).rejects.toThrow()));
  });
});
