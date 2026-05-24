import { existsSync, readFileSync } from 'node:fs';
import { normalizePath, pathFromUrl } from '../config/paths.mjs';

const moduleIds = new Map([
  ['virtual:oxiquill/cells', '\0virtual:oxiquill/cells'],
  ['virtual:oxiquill/runtime-version', '\0virtual:oxiquill/runtime-version'],
  ['virtual:oxiquill/rust-wasm', '\0virtual:oxiquill/rust-wasm']
]);

export function oxiquillVirtualModulesPlugin(paths) {
  const generatedModules = new Map([
    ['\0virtual:oxiquill/cells', {
      file: pathFromUrl(paths.cellsModulePath),
      fallback: 'export const cells = [];\n'
    }],
    ['\0virtual:oxiquill/runtime-version', {
      file: pathFromUrl(paths.runtimeVersionPath),
      fallback: 'export const runtimeVersion = "not-ready";\n'
    }]
  ]);
  const rustWasmFile = pathFromUrl(new URL('doc_rust_cells.js', paths.rustWasmPublicDir));

  return {
    name: 'oxiquill-virtual-modules',
    resolveId(id) {
      return moduleIds.get(id);
    },
    load(id) {
      const generated = generatedModules.get(id);
      if (generated) {
        this.addWatchFile(generated.file);
        return existsSync(generated.file) ? readFileSync(generated.file, 'utf8') : generated.fallback;
      }

      if (id === '\0virtual:oxiquill/rust-wasm') {
        this.addWatchFile(rustWasmFile);
        if (!existsSync(rustWasmFile)) {
          return [
            'export default async function initRustWasm() {',
            '  throw new Error("Oxiquill Rust/Wasm runtime has not been generated.");',
            '}',
            'export function run_rust_cell() {',
            '  throw new Error("Oxiquill Rust/Wasm runtime has not been generated.");',
            '}'
          ].join('\n');
        }

        return `export { default, run_rust_cell } from "/@fs/${normalizePath(rustWasmFile)}";\n`;
      }

      return undefined;
    },
    configureServer(server) {
      const watchedFiles = [
        ...Array.from(generatedModules.values()).map(({ file }) => file),
        rustWasmFile
      ];

      server.watcher.add(watchedFiles);
      server.watcher.on('change', (filePath) => {
        if (!watchedFiles.includes(filePath)) return;

        for (const resolvedId of moduleIds.values()) {
          const moduleNode = server.moduleGraph.getModuleById(resolvedId);
          if (moduleNode) server.moduleGraph.invalidateModule(moduleNode);
        }

        server.ws.send({ type: 'full-reload' });
      });
    }
  };
}
