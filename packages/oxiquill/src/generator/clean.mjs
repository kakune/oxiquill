import { rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createOxiquillPaths, pathFromUrl } from '../config/paths.mjs';

export async function cleanOxiquillWorkspace({ paths = createOxiquillPaths(), extraPaths = [] } = {}) {
  const workspaceRoot = pathFromUrl(paths.workspaceRoot);
  const ownedPaths = [
    pathFromUrl(paths.cacheDir),
    pathFromUrl(paths.publicAssetsDir),
    `${workspaceRoot}/dist`,
    `${workspaceRoot}/.astro`,
    `${workspaceRoot}/playwright-report`,
    `${workspaceRoot}/test-results`,
    ...extraPaths
  ];

  await Promise.all(ownedPaths.map((targetPath) => rm(targetPath, { recursive: true, force: true })));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await cleanOxiquillWorkspace();
}
