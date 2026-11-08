import { defaultFileSystem } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

const missingCodes = new Set(['ENOENT', 'ENOTDIR', 'EISDIR']);

// Reads and hashes each file at most once per run. Kept outputs are verified by
// existence and size in development and by SHA-256 in production builds.
export function createFileDigests({ fileSystem = defaultFileSystem, mode } = {}) {
  const run = new Map();
  const record = (file) => {
    if (!run.has(file))
      run.set(
        file,
        (async () => {
          const bytes = await fileSystem.readFile(file);
          return Object.freeze({ size: bytes.length, sha256: hashBytes(bytes) });
        })()
      );
    return run.get(file);
  };
  const quick = mode !== 'build' && typeof fileSystem.stat === 'function';
  return Object.freeze({
    mode,
    record,
    async digest(file) {
      return (await record(file)).sha256;
    },
    // Records bytes this run has just written without reading them back.
    describe(file, bytes) {
      const described = Object.freeze({ size: bytes.length, sha256: hashBytes(bytes) });
      run.set(file, Promise.resolve(described));
      return described;
    },
    async verify(file, expected) {
      if (!isFileRecord(expected)) return false;
      try {
        if (quick && !run.has(file)) {
          const info = await fileSystem.stat(file);
          return info.isFile() && info.size === expected.size;
        }
        const actual = await record(file);
        return actual.size === expected.size && actual.sha256 === expected.sha256;
      } catch (error) {
        if (missingCodes.has(error?.code)) {
          run.delete(file);
          return false;
        }
        throw error;
      }
    }
  });
}

export function isFileRecord(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    Number.isSafeInteger(value.size) &&
    value.size >= 0 &&
    /^[a-f0-9]{64}$/u.test(value.sha256 ?? '')
  );
}
