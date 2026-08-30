// @vitest-environment node

import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { cleanOxiquillWorkspace } from '../../packages/oxiquill/src/generator/clean.mjs';
import {
  CLEANUP_OWNERSHIP_MARKER,
  maintainCleanupOwnership,
  prepareCleanupOwnership
} from '../../packages/oxiquill/src/generator/cleanup-ownership.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe('Oxiquill cleanup', () => {
  it('removes safe default output and preserves authored, repository, dependency, and download-cache files', async () => {
    const root = await temporaryDirectory();
    const paths = createOxiquillPaths({ workspaceRoot: root });
    const preservedFiles = [
      path.join(paths.docsDir, 'guide.mdx'),
      path.join(paths.cratesDir, 'helper/Cargo.toml'),
      path.join(paths.publicDir, 'media/photo.txt'),
      path.join(root, '.git/HEAD'),
      path.join(root, 'node_modules/package/index.js'),
      path.join(paths.downloadCacheDir, 'verified.whl')
    ];
    const removedFiles = [
      path.join(paths.cacheDir, 'generated/cells.json'),
      path.join(paths.outDir, 'index.html'),
      path.join(paths.publicAssetsDir, 'rust-wasm/runtime.wasm')
    ];

    await Promise.all([...preservedFiles, ...removedFiles].map((filePath) => writeSentinel(filePath)));
    await cleanOxiquillWorkspace({ paths });

    preservedFiles.forEach((filePath) => expect(existsSync(filePath), filePath).toBe(true));
    [paths.cacheDir, paths.outDir, paths.publicAssetsDir].forEach((directory) =>
      expect(existsSync(directory), directory).toBe(false)
    );
  });

  it('cleans custom roots only after the lifecycle establishes explicit ownership', async () => {
    const root = await temporaryDirectory();
    const paths = createOxiquillPaths({
      cacheDir: 'custom-cache',
      outDir: 'custom-output',
      publicAssetsDir: 'custom-assets',
      workspaceRoot: root
    });

    const ownership = await prepareCleanupOwnership({ paths });
    expect(ownership).toHaveLength(3);
    for (const targetPath of [paths.cacheDir, paths.outDir, paths.publicAssetsDir]) {
      expect(JSON.parse(await readFile(path.join(targetPath, CLEANUP_OWNERSHIP_MARKER), 'utf8'))).toMatchObject({
        owner: 'oxiquill',
        schemaVersion: 1
      });
      await writeSentinel(path.join(targetPath, 'generated.txt'));
    }

    await cleanOxiquillWorkspace({ paths });

    [paths.cacheDir, paths.outDir, paths.publicAssetsDir].forEach((directory) =>
      expect(existsSync(directory), directory).toBe(false)
    );
  });

  it('does not infer ownership from a pre-existing custom directory', async () => {
    const root = await temporaryDirectory();
    const paths = createOxiquillPaths({ cacheDir: 'custom-cache', workspaceRoot: root });
    const sentinel = path.join(paths.cacheDir, 'authored.txt');
    await writeSentinel(sentinel);

    await expect(cleanOxiquillWorkspace({ paths })).rejects.toThrow(
      `Unsafe cleanup root cacheDir at ${paths.cacheDir}: the custom cleanup target has no ${CLEANUP_OWNERSHIP_MARKER}`
    );
    expect(existsSync(sentinel)).toBe(true);
  });

  it('restores ownership after a build tool empties a verified custom output root', async () => {
    const root = await temporaryDirectory();
    const paths = createOxiquillPaths({ outDir: 'custom-output', workspaceRoot: root });
    const ownership = await prepareCleanupOwnership({ paths });
    const outOwnership = ownership.filter(({ root: ownedRoot }) => ownedRoot.property === 'outDir');

    await rm(paths.outDir, { force: true, recursive: true });
    await writeSentinel(path.join(paths.outDir, 'index.html'));
    await maintainCleanupOwnership({ ownership: outOwnership });
    await cleanOxiquillWorkspace({ paths });

    expect(existsSync(paths.outDir)).toBe(false);
  });

  it('validates every target before deleting any otherwise valid target', async () => {
    const root = await temporaryDirectory();
    const paths = createOxiquillPaths({ cacheDir: 'custom-cache', workspaceRoot: root });
    const sentinels = [
      path.join(paths.cacheDir, 'authored.txt'),
      path.join(paths.outDir, 'generated.html'),
      path.join(paths.publicAssetsDir, 'generated.js')
    ];
    await Promise.all(sentinels.map((filePath) => writeSentinel(filePath)));
    const fileSystem = { rm: vi.fn(rm) };

    await expect(cleanOxiquillWorkspace({ fileSystem, paths })).rejects.toThrow('custom cleanup target has no');

    expect(fileSystem.rm).not.toHaveBeenCalled();
    sentinels.forEach((filePath) => expect(existsSync(filePath), filePath).toBe(true));
  });

  it.each(['.git', 'node_modules'])(
    'rejects a generated root containing discovered protected state: %s',
    async (protectedName) => {
      const root = await temporaryDirectory();
      const paths = createOxiquillPaths({ workspaceRoot: root });
      const protectedSentinel = path.join(paths.outDir, 'nested', protectedName, 'sentinel');
      const otherSentinel = path.join(paths.cacheDir, 'generated.txt');
      await Promise.all([writeSentinel(protectedSentinel), writeSentinel(otherSentinel)]);
      const fileSystem = { rm: vi.fn(rm) };

      await expect(cleanOxiquillWorkspace({ fileSystem, paths })).rejects.toThrow(protectedName);

      expect(fileSystem.rm).not.toHaveBeenCalled();
      expect(existsSync(protectedSentinel)).toBe(true);
      expect(existsSync(otherSentinel)).toBe(true);
    }
  );

  it('canonicalizes a symlinked cleanup ancestor and rejects authored content', async () => {
    const root = await temporaryDirectory();
    const docsDir = path.join(root, 'content/docs');
    const linked = path.join(root, 'linked');
    const sentinel = path.join(docsDir, 'guide.mdx');
    await writeSentinel(sentinel);
    await symlink(path.join(root, 'content'), linked, process.platform === 'win32' ? 'junction' : 'dir');
    const paths = createOxiquillPaths({ cacheDir: path.join(linked, 'docs'), workspaceRoot: root });

    await expect(cleanOxiquillWorkspace({ paths })).rejects.toThrow(
      `cacheDir at ${docsDir}: it is equal to docsDir (authored documentation input)`
    );
    expect(existsSync(sentinel)).toBe(true);
  });

  it('canonicalizes a symlinked ancestor and rejects an external cleanup target', async () => {
    const root = await temporaryDirectory();
    const external = await temporaryDirectory();
    const linked = path.join(root, 'linked');
    const sentinel = path.join(external, 'generated/sentinel');
    await writeSentinel(sentinel);
    await symlink(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
    const paths = createOxiquillPaths({ outDir: path.join(linked, 'generated'), workspaceRoot: root });

    await expect(cleanOxiquillWorkspace({ paths })).rejects.toThrow(
      `Unsafe path outDir at ${path.join(external, 'generated')}`
    );
    expect(existsSync(sentinel)).toBe(true);
  });

  it('rejects malformed calls and persistent caches below cleanup roots without mutating files', async () => {
    const root = await temporaryDirectory();
    const paths = {
      ...createOxiquillPaths({ workspaceRoot: root }),
      downloadCacheDir: path.join(root, '.oxiquill/downloads')
    };
    const sentinel = path.join(paths.outDir, 'index.html');
    await writeSentinel(sentinel);

    await expect(cleanOxiquillWorkspace({ paths })).rejects.toThrow(
      'cacheDir at ' + path.join(root, '.oxiquill') + ': it is an ancestor of paths.downloadCacheDir'
    );
    expect(existsSync(sentinel)).toBe(true);
    await expect(cleanOxiquillWorkspace()).rejects.toThrow('requires resolved project paths');
  });
});

async function temporaryDirectory() {
  const directory = await mkdtemp(path.join(tmpdir(), 'oxiquill-clean-'));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeSentinel(filePath) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, 'sentinel\n');
}
