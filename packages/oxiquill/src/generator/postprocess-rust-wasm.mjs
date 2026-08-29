import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const defaultFileSystem = {
  readFile,
  rm,
  writeFile
};

export async function postprocessRustWasm({ fileSystem = defaultFileSystem, rustWasmDir }) {
  await Promise.all([
    fileSystem.rm(path.join(rustWasmDir, '.gitignore'), { force: true }),
    stripUnusedWasmPackState(path.join(rustWasmDir, 'doc_rust_cells.js'), { fileSystem })
  ]);
}

export async function stripUnusedWasmPackState(filePath, { fileSystem = defaultFileSystem } = {}) {
  const source = await fileSystem.readFile(filePath, 'utf8');
  const processed = removeUnusedWasmPackState(source);

  if (processed !== source) {
    await fileSystem.writeFile(filePath, processed, 'utf8');
  }
}

export function removeUnusedWasmPackState(source) {
  return source.replace(
    [
      'let wasmModule, wasmInstance, wasm;',
      'function __wbg_finalize_init(instance, module) {',
      '    wasmInstance = instance;',
      '    wasm = instance.exports;',
      '    wasmModule = module;'
    ].join('\n'),
    ['let wasm;', 'function __wbg_finalize_init(instance) {', '    wasm = instance.exports;'].join('\n')
  );
}
