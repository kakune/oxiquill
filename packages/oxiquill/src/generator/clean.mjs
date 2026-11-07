import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLEANUP_OWNERSHIP_MARKER, prepareCleanupOwnership, verifyCleanupOwnership } from './cleanup-ownership.mjs';
import { isRuntimeLockFile } from './runtime-lock-record.mjs';
import { withRuntimeLock } from './runtime-lock.mjs';

const defaultFileSystem = { readdir, rm };

export async function cleanOxiquillWorkspace({ configFile, fileSystem = defaultFileSystem, paths, lockToken } = {}) {
  if (!paths) throw new TypeError('cleanOxiquillWorkspace requires resolved project paths.');

  const services = { ...defaultFileSystem, ...fileSystem };
  if (lockToken) {
    // Check output ownership only after acquiring: a live build may temporarily replace those roots.
    await verifyCleanupOwnership({ configFile, fileSystem: services, fields: ['outDir', 'publicAssetsDir'], paths });
    await prepareCleanupOwnership({ configFile, fileSystem: services, fields: ['cacheDir'], paths });
  }
  const ownedRoots = await verifyCleanupOwnership({ configFile, fileSystem: services, paths });

  await Promise.all(
    ownedRoots.map(async ({ path: targetPath, property }) => {
      if (!lockToken || property !== 'cacheDir') return services.rm(targetPath, { recursive: true, force: true });
      const entries = await services.readdir(targetPath);
      await Promise.all(
        entries
          .filter((name) => name !== CLEANUP_OWNERSHIP_MARKER && !isRuntimeLockFile(name))
          .map((name) => services.rm(path.join(targetPath, name), { recursive: true, force: true }))
      );
    })
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const { loadOxiquillProjectConfig } = await import('../config/project-config.mjs');
  const projectConfig = await loadOxiquillProjectConfig({ cwd: process.cwd() });
  await withRuntimeLock({ ...projectConfig, command: 'clean' }, ({ token }) =>
    cleanOxiquillWorkspace({ configFile: projectConfig.configFile, paths: projectConfig.paths, lockToken: token })
  );
}
