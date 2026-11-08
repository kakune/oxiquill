import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { writeIfChanged } from './file-system.mjs';

// Generated Rust sources and the resolved lock live in the compiler cache. Their
// records are written whenever they change on disk, independently of whether a
// build later succeeds, so a failed run never forces regeneration or re-resolution.
const workspaceFile = (paths) => path.join(pathFromUrl(paths.buildCacheDir), 'rust-workspace.json');
// Development failures whose inputs are unchanged are replayed instead of recompiled.
const failureFile = (paths) => path.join(pathFromUrl(paths.buildCacheDir), 'rust-failures.json');
export const RUST_GROUP_ID_PATTERN = /^(?:page|directory|site|custom)-[a-f0-9]{16}$/u;

async function readJson(file, fileSystem) {
  try {
    return JSON.parse(await fileSystem.readFile(file, 'utf8'));
  } catch (error) {
    if (error?.code === 'ENOENT' || error instanceof SyntaxError) return undefined;
    throw error;
  }
}

// Ids recorded on disk become paths; anything unexpected is ignored.
function recordsById(value) {
  return Object.fromEntries(
    Object.entries(value && typeof value === 'object' ? value : {}).filter(
      ([id, record]) => RUST_GROUP_ID_PATTERN.test(id) && record && typeof record === 'object'
    )
  );
}

export async function readRustWorkspaceRecords({ paths, fileSystem }) {
  const value = await readJson(workspaceFile(paths), fileSystem);
  return value?.version === 1
    ? {
        lock: value.lock && typeof value.lock === 'object' ? value.lock : undefined,
        modules: recordsById(value.modules)
      }
    : { lock: undefined, modules: {} };
}

export async function writeRustWorkspaceRecords({ paths, fileSystem, records }) {
  const modules = Object.fromEntries(Object.entries(records.modules).sort(([a], [b]) => (a < b ? -1 : 1)));
  await writeIfChanged(workspaceFile(paths), `${JSON.stringify({ version: 1, lock: records.lock, modules })}\n`, {
    fileSystem
  });
}

export async function readRustFailures({ paths, fileSystem }) {
  const value = await readJson(failureFile(paths), fileSystem);
  return value?.version === 2 ? recordsById(value.groups) : {};
}

export async function writeRustFailures({ paths, fileSystem, failures }) {
  const groups = Object.fromEntries(Object.entries(failures).sort(([a], [b]) => (a < b ? -1 : 1)));
  if (!Object.keys(groups).length) {
    await fileSystem.rm(failureFile(paths), { force: true });
    return;
  }
  await writeIfChanged(failureFile(paths), `${JSON.stringify({ version: 2, groups })}\n`, { fileSystem });
}

// Files from earlier layouts that no longer have a reader.
export function legacyRustCacheFiles(paths) {
  const buildCacheDir = pathFromUrl(paths.buildCacheDir);
  return ['runtime-failures.json', 'rust-source-maps.json'].map((name) => path.join(buildCacheDir, name));
}
