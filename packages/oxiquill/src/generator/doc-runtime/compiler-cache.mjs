import path from 'node:path';
import { defaultFileSystem, listFiles, writeIfChanged } from './file-system.mjs';

export function wasmPackEnvironment({ environment = process.env, paths }) {
  const env = { ...environment };
  delete env.NODE_PATH;
  return { ...env, CARGO_TARGET_DIR: environment.CARGO_TARGET_DIR ?? paths.rustTargetDir };
}

export function haskellCacheDirectory({ compilerVersion, mode, paths }) {
  if (!/^\d+(?:\.\d+)+$/u.test(compilerVersion)) {
    throw new Error(`Invalid Haskell compiler version for compiler cache: ${compilerVersion}.`);
  }
  return path.join(paths.haskellBuildCacheDir, `${mode === 'build' ? 'build' : 'dev'}-${compilerVersion}`);
}

export async function syncHaskellCacheSources({ fileSystem = defaultFileSystem, sourceDir, targetDir }) {
  await fileSystem.mkdir(targetDir, { recursive: true });
  const sources = (await listFiles(sourceDir, { fileSystem })).filter((file) => file.endsWith('.hs'));
  const relativeSources = new Set(sources.map((file) => path.relative(sourceDir, file)));
  const previous = await listFiles(targetDir, { fileSystem });
  await Promise.all([
    ...sources.map(async (file) =>
      writeIfChanged(path.join(targetDir, path.relative(sourceDir, file)), await fileSystem.readFile(file, 'utf8'), {
        fileSystem
      })
    ),
    ...previous
      .filter((file) => !relativeSources.has(path.relative(targetDir, file)))
      .map((file) => fileSystem.rm(file, { force: true }))
  ]);
}
