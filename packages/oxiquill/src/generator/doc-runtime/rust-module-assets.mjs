import { createHash } from 'node:crypto';
import path from 'node:path';
import { validateRustRegistry } from '../../lib/doc-runtime/rust-registry.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { hashBytes } from './hashing.mjs';

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

export async function finalizeRustModule({ cells, paths, publicPaths = paths, fileSystem = defaultFileSystem }) {
  const directory = paths.rustWasmPublicDir;
  const [glue, wasm] = await Promise.all([
    fileSystem.readFile(path.join(directory, 'doc_rust_cells.js'), 'utf8'),
    fileSystem.readFile(path.join(directory, 'doc_rust_cells_bg.wasm'))
  ]).catch((cause) => {
    throw new Error(
      `Rust module site (cells: ${cells.map((cell) => cell.id).join(', ')}) has missing build assets: ${cause.message}`,
      { cause }
    );
  });
  const assets = createRustModuleAssets({
    id: 'site',
    cells,
    glue,
    wasm,
    publicPath: path
      .relative(publicPaths.publicDir, publicPaths.rustWasmPublicDir)
      .split(path.sep)
      .map(encodeURIComponent)
      .join('/')
  });
  await Promise.all(
    Object.entries(assets.files).map(([name, bytes]) => fileSystem.writeFile(path.join(directory, name), bytes))
  );
  await Promise.all(
    ['doc_rust_cells.js', 'doc_rust_cells_bg.wasm'].map((name) =>
      fileSystem.rm(path.join(directory, name), { force: true })
    )
  );
  return { version: 1, modules: [assets.module] };
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
