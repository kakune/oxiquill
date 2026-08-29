import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { assertPathWithin, canonicalPath } from '../config/paths.mjs';

const defaultFileSystem = { rm };

export async function cleanOxiquillWorkspace({ fileSystem = defaultFileSystem, paths } = {}) {
  if (!paths) throw new TypeError('cleanOxiquillWorkspace requires resolved project paths.');

  assertPathWithin(paths.workspaceRoot, paths.cacheDir, 'cacheDir');
  assertPathWithin(paths.workspaceRoot, paths.outDir, 'outDir');
  assertPathWithin(paths.publicDir, paths.publicAssetsDir, 'paths.publicAssetsDir');
  const ownedPaths = Array.from(new Set([
    canonicalPath(paths.cacheDir),
    canonicalPath(paths.publicAssetsDir),
    canonicalPath(paths.outDir)
  ]));

  await Promise.all(
    ownedPaths.map((targetPath) => fileSystem.rm(targetPath, { recursive: true, force: true }))
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadOxiquillProjectConfig } = await import('../config/project-config.mjs');
  const projectConfig = await loadOxiquillProjectConfig({ cwd: process.cwd() });
  await cleanOxiquillWorkspace({ paths: projectConfig.paths });
}
