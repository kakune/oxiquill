import { pathToFileURL } from 'node:url';
import {
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  syncDocRuntime
} from './doc-runtime-service.mjs';

export async function main(argv = process.argv.slice(2)) {
  const wasmMode = parseWasmMode(argv);
  const root = process.cwd();
  const context = await createDocRuntimeContext({ root });
  const result = await syncDocRuntime(context);

  console.log(`Generated ${result.cellCount} interactive cell(s).`);

  if (wasmMode) {
    await buildRustWasm({ mode: wasmMode, paths: context.paths });
  }

  await markRuntimeReady({ paths: context.paths, summary: result });
}

function parseWasmMode(argv) {
  const wasmIndex = argv.indexOf('--wasm');
  if (wasmIndex === -1) return undefined;

  const mode = argv[wasmIndex + 1];
  if (mode === 'dev' || mode === 'build') return mode;

  throw new Error('--wasm must be followed by "dev" or "build".');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
