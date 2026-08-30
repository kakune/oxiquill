import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifyCleanupOwnership } from './cleanup-ownership.mjs';

const defaultFileSystem = { rm };

export async function cleanOxiquillWorkspace({ configFile, fileSystem = defaultFileSystem, paths } = {}) {
  if (!paths) throw new TypeError('cleanOxiquillWorkspace requires resolved project paths.');

  const ownedRoots = await verifyCleanupOwnership({ configFile, fileSystem, paths });

  await Promise.all(
    ownedRoots.map(({ path: targetPath }) => fileSystem.rm(targetPath, { recursive: true, force: true }))
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadOxiquillProjectConfig } = await import('../config/project-config.mjs');
  const projectConfig = await loadOxiquillProjectConfig({ cwd: process.cwd() });
  await cleanOxiquillWorkspace({ configFile: projectConfig.configFile, paths: projectConfig.paths });
}
