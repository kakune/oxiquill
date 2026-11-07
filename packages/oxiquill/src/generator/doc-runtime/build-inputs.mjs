import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { binaryenEnvironment } from './wasm-opt-cache.mjs';
import { defaultFileSystem, listFiles } from './file-system.mjs';
import { hashBytes, hashText, stableFingerprint } from './hashing.mjs';
import { normalizePath } from './path-utils.mjs';

const installedSourceUrl = new URL('../../', import.meta.url);
const installedSourceRoot =
  installedSourceUrl.protocol === 'file:'
    ? fileURLToPath(installedSourceUrl)
    : path.resolve(process.cwd(), 'packages/oxiquill/src');
let installedIdentity;

// The installed generator is immutable during a process. Test readers remain uncached.
export function getGeneratorIdentity() {
  return (installedIdentity ??= readGeneratorIdentity());
}

export async function readGeneratorIdentity({ fileSystem = defaultFileSystem, sourceRoot = installedSourceRoot } = {}) {
  const files = (
    await Promise.all(
      ['generator', 'config', 'lib/doc-runtime'].map((directory) =>
        listFiles(path.join(sourceRoot, directory), { fileSystem })
      )
    )
  )
    .flat()
    .filter((file) => !file.endsWith('.d.ts'))
    .sort();
  const inputs = await Promise.all(
    files.map(async (file) => [
      normalizePath(path.relative(sourceRoot, file)),
      hashBytes(await fileSystem.readFile(file))
    ])
  );
  return hashText(stableFingerprint(inputs));
}

export function rustBuildEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment)
      .filter(
        ([name, value]) =>
          value !== undefined && /^(?:RUSTFLAGS$|CARGO_ENCODED_RUSTFLAGS$|CARGO_(?:PROFILE|BUILD|TARGET)_)/u.test(name)
      )
      .sort(([left], [right]) => left.localeCompare(right))
  );
}

export async function readRustBuildInputs({ environment = process.env, fileSystem = defaultFileSystem, paths }) {
  const configs = await Promise.all(
    ['config', 'config.toml'].map(async (name) => {
      try {
        return [name, hashBytes(await fileSystem.readFile(path.join(paths.workspaceRoot, '.cargo', name)))];
      } catch (error) {
        if (error?.code === 'ENOENT') return [name, null];
        throw error;
      }
    })
  );
  return hashText(
    stableFingerprint({
      environment: rustBuildEnvironment(environment),
      binaryen: binaryenEnvironment(environment),
      configs
    })
  );
}

export function artifactBuildFingerprint(inputs, mode) {
  return stableFingerprint({ inputs, mode });
}
