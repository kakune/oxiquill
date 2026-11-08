import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { retryFileOperation } from './atomic-output.mjs';

export const RUST_MODULE_FILE_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*-[a-f0-9]{64}\.(?:js|wasm)$/u;
// Assets produced by earlier wasm-pack based layouts.
const legacyFileNames = new Set([
  '.gitignore',
  'package.json',
  'LICENSE-MIT',
  'LICENSE-APACHE',
  'doc_rust_cells.js',
  'doc_rust_cells_bg.wasm',
  'doc_rust_cells.d.ts',
  'doc_rust_cells_bg.wasm.d.ts'
]);

// Content-addressed files are installed before the registry that references
// them. An existing file is never replaced in place unless it fails verification.
// Returns the files that did not exist before, for rollback before publication.
export async function installRustModuleFiles({ stageDir, targetDir, files, digests, fileSystem }) {
  const target = pathFromUrl(targetDir);
  const installed = [];
  await fileSystem.mkdir(target, { recursive: true });
  for (const [name, record] of Object.entries(files)) {
    const source = path.join(stageDir, name);
    const destination = path.join(target, name);
    if (fileSystem.existsSync(destination)) {
      if (await digests.verify(destination, record)) {
        await fileSystem.rm(source, { force: true });
        continue;
      }
      await retryFileOperation(() => fileSystem.rm(destination, { force: true }));
    } else installed.push(destination);
    await retryFileOperation(() => fileSystem.rename(source, destination));
  }
  return installed;
}

// Removes module assets that the published registry no longer references.
// Failures (for example a file held open on Windows) only produce a diagnostic;
// the next publication collects the file again.
export async function collectRustModuleGarbage({ targetDir, referenced, fileSystem, events }) {
  const target = pathFromUrl(targetDir);
  let entries;
  try {
    entries = await fileSystem.readdir(target);
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const names = entries
    .map((entry) => (typeof entry === 'string' ? entry : entry.name))
    .filter((name) => (RUST_MODULE_FILE_PATTERN.test(name) || legacyFileNames.has(name)) && !referenced.has(name))
    .sort();
  const removed = [];
  for (const name of names) {
    try {
      await retryFileOperation(() => fileSystem.rm(path.join(target, name), { force: true }));
      removed.push(name);
    } catch (error) {
      events?.report({
        type: 'diagnostic',
        message: `Unable to remove unreferenced Rust module asset ${name}: ${error.message}. It will be removed after the next publication.`
      });
    }
  }
  return removed;
}

export function referencedRustFiles(registry) {
  return new Set(
    (registry?.modules ?? []).flatMap((module) =>
      [module.glue, module.wasm].map((asset) => path.posix.basename(asset.url))
    )
  );
}
