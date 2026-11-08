import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateRustRegistry } from '../../lib/doc-runtime/rust-registry.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';
import { pathFromUrl } from '../../config/paths.mjs';
import { removeUnusedGlueState } from '../postprocess-rust-wasm.mjs';

export function createRustModuleAssets({ id, cells, glue, wasm, publicPath }) {
  const wasmName = `${id}-${hashBytes(wasm)}.wasm`;
  const source = `${glue.replaceAll('doc_rust_cells_bg.wasm', wasmName)}\n// Rust module Wasm: ${wasmName}\n`;
  const glueName = `${id}-${hashBytes(Buffer.from(source))}.js`;
  const module = {
    id,
    fingerprint: hashBytes(Buffer.from(JSON.stringify([glueName, wasmName]))),
    glue: { url: `${publicPath}/${glueName}` },
    wasm: { url: `${publicPath}/${wasmName}`, integrity: integrity(wasm), bytes: wasm.length },
    cells: cells.map((cell) => cell.id).sort()
  };
  validateRustRegistry({ version: 1, modules: [module] }, cells);
  return { module, files: { [glueName]: source, [wasmName]: wasm } };
}

export const RUST_GLUE_FILE = 'doc_rust_cells.js';
export const RUST_WASM_FILE = 'doc_rust_cells_bg.wasm';

export function rustModulePublicPath(paths) {
  return path
    .relative(pathFromUrl(paths.publicDir), pathFromUrl(paths.rustWasmPublicDir))
    .split(path.sep)
    .map(encodeURIComponent)
    .join('/');
}

// Turns raw wasm-bindgen output into content-addressed files. Integrity records
// come from the in-memory bytes, so finalized files are never read back.
export async function finalizeRustModuleOutput({
  id,
  cells,
  directory,
  outputDirectory,
  publicPath,
  fileSystem = defaultFileSystem
}) {
  const [glue, wasm] = await Promise.all([
    fileSystem.readFile(path.join(directory, RUST_GLUE_FILE), 'utf8'),
    fileSystem.readFile(path.join(directory, RUST_WASM_FILE))
  ]).catch((cause) => {
    throw new Error(
      `Rust module ${id} (cells: ${cells.map((cell) => cell.id).join(', ')}) has missing build assets: ${cause.message}`,
      { cause }
    );
  });
  const assets = createRustModuleAssets({ id, cells, glue: removeUnusedGlueState(String(glue)), wasm, publicPath });
  await fileSystem.mkdir(outputDirectory, { recursive: true });
  const files = await Promise.all(
    Object.entries(assets.files).map(async ([name, content]) => {
      const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
      await fileSystem.writeFile(path.join(outputDirectory, name), bytes);
      return [name, { size: bytes.length, sha256: hashBytes(bytes) }];
    })
  );
  return { module: assets.module, files: Object.fromEntries(files.sort(([a], [b]) => (a < b ? -1 : 1))) };
}

export async function validateRustModuleFiles({
  registry,
  cells,
  publicDir,
  assetDirectory,
  fileSystem = defaultFileSystem
}) {
  validateRustRegistry(registry, cells);
  await Promise.all(
    registry.modules.map(async (module) => {
      try {
        const [glue, wasm] = await Promise.all(
          [module.glue, module.wasm].map((asset) =>
            fileSystem.readFile(
              assetDirectory
                ? path.join(assetDirectory, path.basename(asset.url))
                : path.join(publicDir, decodeURIComponent(asset.url))
            )
          )
        );
        if (!glue.length || wasm.length !== module.wasm.bytes || integrity(wasm) !== module.wasm.integrity) {
          throw new Error('asset integrity or byte length does not match');
        }
      } catch (cause) {
        throw new Error(
          `Rust module ${module.id} (cells: ${module.cells.join(', ')}) has missing or invalid assets: ${cause.message}`,
          { cause }
        );
      }
    })
  );
}

function integrity(bytes) {
  return `sha384-${createHash('sha384').update(bytes).digest('base64')}`;
}
