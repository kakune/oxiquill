import { spawn } from 'node:child_process';
import { collectAuthoringCells } from '../generator/doc-runtime/cell-collection.mjs';
import { createCellTestPlan } from '../generator/doc-runtime/cell-test-plan.mjs';
import {
  assertGenerationSnapshot,
  createGenerationSnapshot,
  readHelperInputs,
  sourceChangedError
} from '../generator/doc-runtime/generation-snapshot.mjs';
import { buildHaskellWasm, buildRustWasm } from '../generator/doc-runtime/wasm-build.mjs';
import { testGeneratedHaskellCells } from '../generator/doc-runtime/haskell-runtime-test.mjs';
import { testGeneratedRustCells } from '../generator/doc-runtime/rust-runtime-test.mjs';
import { createEventReporter } from './events.mjs';

export async function runWasmTests({
  projectConfig,
  values,
  generateRuntime,
  log = console.log,
  progress = console.error,
  collect = collectAuthoringCells,
  readHelpers = readHelperInputs,
  assertSnapshot = assertGenerationSnapshot,
  testRust = testGeneratedRustCells,
  testHaskell = testGeneratedHaskellCells
}) {
  const report = createEventReporter({ format: values.format, write: log });
  let counts = { total: 0, passed: 0, failed: 0 };
  let haskell;
  let exitStatus = 1;
  try {
    const snapshotOptions = { paths: projectConfig.paths, pythonOptions: projectConfig.python };
    const [cells, helpers] = await Promise.all([collect(snapshotOptions), readHelpers(snapshotOptions)]);
    const snapshot = createGenerationSnapshot(cells, helpers);
    const plan = createCellTestPlan(cells, values, projectConfig.paths);
    const summary = await generateRuntime({
      projectConfig,
      wasmMode: 'dev',
      log: progress,
      runtimeOptions:
        values.format === 'json'
          ? {
              buildRust: (options) => buildRustWasm({ ...options, runCommand: runCommandToStderr }),
              buildHaskell: (options) => buildHaskellWasm({ ...options, runCommand: runCommandToStderr })
            }
          : {}
    });
    if (summary.generationId !== snapshot.generationId)
      throw sourceChangedError([{ kind: 'changed', path: 'authored cells or helper inputs' }]);
    await assertSnapshot(snapshot, snapshotOptions);
    counts = await testRust({ tests: plan.tests, paths: projectConfig.paths, report });
    if (plan.runHaskell && summary.haskellCellCount > 0) {
      try {
        const result = await testHaskell({
          expectedFingerprint: summary.haskellFingerprint,
          paths: projectConfig.paths
        });
        haskell = { status: 'pass', cellCount: result.cellCount };
      } catch (error) {
        haskell = { status: 'fail', cellCount: summary.haskellCellCount };
        throw error;
      }
    }
    exitStatus = counts.failed ? 1 : 0;
  } catch (error) {
    report({ type: 'diagnostic', message: error instanceof Error ? error.message : String(error) });
    throw error;
  } finally {
    report({ type: 'summary', ...counts, ...(haskell ? { haskell } : {}), exitStatus });
  }
  if (exitStatus) throw new Error(`${counts.failed} Rust cell test(s) failed.`);
  return counts;
}

// Compiler output belongs on stderr so stdout remains a machine-readable stream.
function runCommandToStderr(command, args, options) {
  return new Promise((resolve, reject) => {
    const detached = Boolean(options.trackChild) && process.platform !== 'win32';
    const child = spawn(command, args, {
      detached,
      cwd: options.cwd,
      env: options.env,
      stdio: ['ignore', options.captureOutput ? 'pipe' : 2, 2]
    });
    options.trackChild?.(child, detached);
    const chunks = [];
    child.stdout?.on('data', (chunk) => chunks.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) =>
      code === 0
        ? resolve(Buffer.concat(chunks).toString('utf8'))
        : reject(new Error(`${command} exited with ${signal ?? code}`))
    );
  });
}
