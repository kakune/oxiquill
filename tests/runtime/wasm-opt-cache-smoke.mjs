import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  createDocRuntimeContext,
  syncDocRuntime
} from '../../packages/oxiquill/dist/generator/doc-runtime-service.mjs';
import { cargoEnvironment } from '../../packages/oxiquill/dist/generator/doc-runtime/compiler-cache.mjs';
import { runProcess } from '../../packages/oxiquill/dist/generator/doc-runtime/process-runner.mjs';
import { buildRustModules } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-module-build.mjs';
import { rustGroupPackage } from '../../packages/oxiquill/dist/generator/doc-runtime/rust-grouping.mjs';
import {
  preflightRequiredToolchains,
  runCommandWithCapturedOutput
} from '../../packages/oxiquill/dist/generator/doc-runtime/toolchain-preflight.mjs';
import { ensureToolDownload } from '../../packages/oxiquill/dist/generator/doc-runtime/tool-downloads.mjs';
import { resolveWasmOpt } from '../../packages/oxiquill/dist/generator/doc-runtime/wasm-opt-cache.mjs';

export async function verifyWasmOptCache({ paths }) {
  const environment = cargoEnvironment({ paths });
  const optimizer = await resolveWasmOpt({ environment, runCommand: runCommandWithCapturedOutput });
  if (!optimizer.command) {
    console.log('Rust optimizer cache smoke skipped: wasm-opt is not on PATH.');
    return;
  }
  const context = await createDocRuntimeContext({ paths });
  const manifest = async () => JSON.parse(await readFile(paths.cellsJsonPath, 'utf8'));
  const publishedPath = async () => path.join(paths.publicDir, (await manifest()).rust.modules[0].wasm.url);
  let calls = 0;
  let optimizationMs = 0;
  const runCommand = async (command, args, options) => {
    const started = performance.now();
    const result = await runProcess(command, args, options);
    if (command === optimizer.command && args[0] !== '--version') {
      calls += 1;
      optimizationMs += performance.now() - started;
    }
    return result;
  };
  const buildRust = (options) => buildRustModules({ ...options, runCommand });
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
  const expected = await readFile(await publishedPath());

  // A plain reference build of the same module: Cargo release, wasm-bindgen, wasm-opt -O.
  const { id } = (await manifest()).rust.modules[0];
  const { packageName, crateName } = rustGroupPackage(id);
  const { rust } = await preflightRequiredToolchains({
    paths,
    mode: 'build',
    rustCellCount: 1,
    haskellCellCount: 0,
    runtimeInputs: context.runtimeInputs,
    environment
  });
  if (rust.wasmBindgen.url) await ensureToolDownload(rust.wasmBindgen, { runCommand: runCommandWithCapturedOutput });
  const plainOutput = path.join(paths.workspaceRoot, 'plain-release');
  await mkdir(plainOutput, { recursive: true });
  const options = { cwd: paths.workspaceRoot, env: environment };
  await runCommandWithCapturedOutput(
    'cargo',
    [
      'build',
      '--manifest-path',
      path.join(paths.rustCellsDir, 'Cargo.toml'),
      '--target',
      'wasm32-unknown-unknown',
      '--locked',
      '--release',
      '--package',
      packageName
    ],
    options
  );
  await runCommandWithCapturedOutput(
    rust.wasmBindgen.command,
    [
      path.join(environment.CARGO_TARGET_DIR, 'wasm32-unknown-unknown', 'release', `${crateName}.wasm`),
      '--target',
      'web',
      '--no-typescript',
      '--out-dir',
      plainOutput,
      '--out-name',
      'doc_rust_cells'
    ],
    options
  );
  await runCommandWithCapturedOutput(
    optimizer.command,
    [path.join(plainOutput, 'doc_rust_cells_bg.wasm'), '-o', path.join(plainOutput, 'optimized.wasm'), '-O'],
    options
  );
  assert.deepEqual(
    await readFile(path.join(plainOutput, 'optimized.wasm')),
    expected,
    'cached and parallel post-link output must match a plain release build'
  );
  await rm(plainOutput, { recursive: true, force: true });

  await rm(paths.wasmOptCacheDir, { recursive: true, force: true });
  await rm(await publishedPath());
  const miss = await rebuild();
  assert.equal(miss.optimizerCalls, 1, 'a cold cache must optimize');
  assert.deepEqual(
    await readFile(await publishedPath()),
    expected,
    'random source stages must produce identical release bytes'
  );
  await rm(await publishedPath());
  const hit = await rebuild();
  assert.equal(hit.optimizerCalls, 0, 'missing published Wasm must rebuild from verified cache bytes');
  assert.deepEqual(await readFile(await publishedPath()), expected);
  await syncDocRuntime({
    ...context,
    mode: 'dev',
    buildRust: async () => assert.fail('release output must satisfy dev requests')
  });
  console.log(`Rust optimizer cache parity and fresh-stage reuse passed: ${JSON.stringify({ miss, hit })}`);
}
