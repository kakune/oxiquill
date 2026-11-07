import path from 'node:path';
import { writeIfChanged } from './file-system.mjs';

// Failure markers are independent of the last successfully published registry.
export async function readBuildFailures({ paths, fileSystem }) {
  try {
    const value = JSON.parse(
      await fileSystem.readFile(path.join(paths.buildCacheDir, 'runtime-failures.json'), 'utf8')
    );
    return value?.version === 1 && Array.isArray(value.rust) ? value.rust : [];
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return [];
    throw error;
  }
}

export async function recordRustBuildFailure({ modules, paths, fileSystem }) {
  await writeIfChanged(
    path.join(paths.buildCacheDir, 'runtime-failures.json'),
    JSON.stringify({ version: 1, rust: modules }),
    { fileSystem }
  );
}

export async function clearBuildFailures({ paths, fileSystem }) {
  await fileSystem.rm(path.join(paths.buildCacheDir, 'runtime-failures.json'), { force: true });
}
