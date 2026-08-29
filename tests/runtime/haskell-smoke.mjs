import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';

const runtimeRoot = new URL('../../examples/docs-site/public/oxiquill/haskell-wasm/', import.meta.url);
const status = JSON.parse(await readFile(new URL('status.json', runtimeRoot), 'utf8'));
assert.equal(status.status, 'ready', status.message || 'Haskell runtime is not ready.');

const chunks = [];
const stdout = new ConsoleStdout((buffer) => chunks.push(new TextDecoder().decode(buffer)));
const stderr = new ConsoleStdout((buffer) => chunks.push(new TextDecoder().decode(buffer)));
const wasi = new WASI(
  ['doc_haskell_cells', 'features__interactive-cells__haskell-controls', '3', 'sample', 'true'],
  [],
  [new OpenFile(new File([])), stdout, stderr]
);
const wasmPath = fileURLToPath(new URL('doc_haskell_cells.wasm', runtimeRoot));
const module = await WebAssembly.compile(await readFile(wasmPath));
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: wasi.wasiImport
});
const exitCode = wasi.start(instance);
const output = chunks.join('').trimEnd();

assert.equal(exitCode, 0, output);
assert.match(output, /sample: 9, 36, 81, 144/u);
assert.match(output, /total = 270/u);
console.log('Generated Haskell/WASI runtime smoke test passed.');
