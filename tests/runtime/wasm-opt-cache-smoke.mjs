import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { wasmPackEnvironment } from '../../packages/oxiquill/dist/generator/doc-runtime/compiler-cache.mjs';
import { runCommandWithCapturedOutput } from '../../packages/oxiquill/dist/generator/doc-runtime/toolchain-preflight.mjs';
import { buildRustWasm } from '../../packages/oxiquill/dist/generator/doc-runtime/wasm-build.mjs';
import { resolveWasmOpt } from '../../packages/oxiquill/dist/generator/doc-runtime/wasm-opt-cache.mjs';

export async function verifyWasmOptCache({ paths }) {
  const environment = wasmPackEnvironment({ paths });
  const optimizer = await resolveWasmOpt({ environment, runCommand: runCommandWithCapturedOutput });
  if (!optimizer.command) {
    console.log('Rust optimizer cache smoke skipped: wasm-opt is not on PATH.');
    return;
  }
  const context = await createDocRuntimeContext({ paths });
  const wasmName = 'doc_rust_cells_bg.wasm';
  const published = path.join(paths.rustWasmPublicDir, wasmName);
  let calls = 0;
  let optimizationMs = 0;
  const runCommand = async (command, args, options) => {
    const started = performance.now();
    const result = await runCommandWithCapturedOutput(command, args, options);
    if (command === optimizer.command && args[0] !== '--version') {
      calls += 1;
      optimizationMs += performance.now() - started;
    }
    return result;
  };
  const buildRust = (options) => buildRustWasm({ ...options, runCommand });
  const rebuild = async () => {
    calls = 0;
    optimizationMs = 0;
    const started = performance.now();
    await syncDocRuntime({ ...context, buildRust, mode: 'build' });
    return {
      totalMs: Math.round(performance.now() - started),
      wasmOptMs: Math.round(optimizationMs),
      optimizerCalls: calls
    };
  };
  await rebuild();
  const expected = await readFile(published);
  const plainOutput = path.join(paths.workspaceRoot, 'plain-release');
  await runCommandWithCapturedOutput(
    'wasm-pack',
    [
      'build',
      paths.rustCellsDir,
      '--target',
      'web',
      '--release',
      '--out-dir',
      plainOutput,
      '--out-name',
      'doc_rust_cells',
      '--locked'
    ],
    { cwd: paths.workspaceRoot, env: environment }
  );
  assert.deepEqual(
    await readFile(path.join(plainOutput, wasmName)),
    expected,
    'cached path must match plain wasm-pack release bytes'
  );

  await rm(paths.wasmOptCacheDir, { recursive: true, force: true });
  await rm(published);
  const miss = await rebuild();
  assert.equal(miss.optimizerCalls, 1, 'a cold cache must optimize');
  assert.deepEqual(await readFile(published), expected, 'random source stages must produce identical release bytes');
  await rm(published);
  const hit = await rebuild();
  assert.equal(hit.optimizerCalls, 0, 'missing published Wasm must rebuild from verified cache bytes');
  assert.deepEqual(await readFile(published), expected);
  await syncDocRuntime({
    ...context,
    mode: 'dev',
    buildRust: async () => assert.fail('release output must satisfy dev requests')
  });
  console.log(`Rust optimizer cache parity and fresh-stage reuse passed: ${JSON.stringify({ miss, hit })}`);
}
