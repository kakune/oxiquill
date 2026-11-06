import path from 'node:path';
import { defaultFileSystem, listFiles } from './file-system.mjs';
import { createSha256, hashBytes } from './hashing.mjs';
import { normalizePath } from './path-utils.mjs';

async function fileIntegrity(file, fileSystem) {
  if (!fileSystem.createReadStream) {
    const bytes = await fileSystem.readFile(file);
    return { size: bytes.length, sha256: hashBytes(bytes) };
  }
  const hash = createSha256();
  let size = 0;
  for await (const chunk of fileSystem.createReadStream(file)) {
    size += chunk.length;
    hash.update(chunk);
  }
  return { size, sha256: hash.digest('hex') };
}

export async function recordOutputIntegrity(directory, { fileSystem = defaultFileSystem } = {}) {
  const files = await listFiles(directory, { fileSystem });
  return Object.fromEntries(
    await Promise.all(
      files.map(async (file) => [normalizePath(path.relative(directory, file)), await fileIntegrity(file, fileSystem)])
    )
  );
}

export async function recordedOutputIsComplete(state, directory, fileSystem = defaultFileSystem) {
  const files = state?.publicFiles;
  if (!Array.isArray(files) || files.length === 0) return false;
  const results = await Promise.all(
    files.map(async (name) => {
      if (
        typeof name !== 'string' ||
        name === '' ||
        path.isAbsolute(name) ||
        normalizePath(name).split('/').includes('..')
      )
        return false;
      const expected = state.publicFileIntegrity?.[name];
      if (!Number.isSafeInteger(expected?.size) || expected.size < 0 || !/^[a-f0-9]{64}$/u.test(expected?.sha256))
        return false;
      try {
        const actual = await fileIntegrity(path.join(directory, name), fileSystem);
        return actual.size === expected.size && actual.sha256 === expected.sha256;
      } catch (error) {
        if (error?.code === 'ENOENT' || error?.code === 'EISDIR' || error?.code === 'ENOTDIR') return false;
        throw error;
      }
    })
  );
  return results.every(Boolean);
}
