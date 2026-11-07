import { readFile } from 'node:fs/promises';
import { Worker } from 'node:worker_threads';
import { pathToFileURL } from 'node:url';
import { pathInUrl } from '../../config/paths.mjs';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { evaluateExpectation } from '../../lib/doc-runtime/cell-tests.mjs';
import { boundedDisplay } from '../../cli/events.mjs';
import { parseGeneratedCellManifest } from './cell-manifest.mjs';
import { validateRustRegistry, rustModuleForCell } from '../../lib/doc-runtime/rust-registry.mjs';
import { validateRustModuleFiles } from './rust-module-assets.mjs';

export async function testGeneratedRustCells({
  tests,
  paths,
  report,
  compile = WebAssembly.compile,
  execute = executeGeneratedRustCell,
  fileSystem = { readFile }
}) {
  if (!tests.length) return { total: 0, passed: 0, failed: 0 };
  const manifest = parseGeneratedCellManifest(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
  validateRustRegistry(manifest.rust, manifest.cells);
  const modules = new Map();
  async function loadRuntime(cellId) {
    const descriptor = rustModuleForCell(manifest.rust, cellId);
    const key = JSON.stringify([descriptor.id, descriptor.fingerprint]);
    if (!modules.has(key))
      modules.set(
        key,
        (async () => {
          await validateRustModuleFiles({
            registry: { version: 1, modules: [descriptor] },
            cells: manifest.cells.filter((cell) => descriptor.cells.includes(cell.id)),
            publicDir: paths.publicDir,
            fileSystem
          });
          return {
            module: await compile(
              await fileSystem.readFile(pathInUrl(paths.publicDir, decodeURIComponent(descriptor.wasm.url)))
            ),
            runtimeUrl: pathToFileURL(pathInUrl(paths.publicDir, decodeURIComponent(descriptor.glue.url))).href
          };
        })()
      );
    return modules.get(key);
  }
  const events = [];
  for (const test of tests) {
    const started = performance.now();
    const outcome = await loadRuntime(test.cell.id)
      .then((runtime) => execute({ ...runtime, cell: test.cell, inputs: test.inputs }))
      .catch((error) => ({
        kind: 'harness-error',
        error: boundedErrorMessage(error)
      }));
    const failures = testFailures(test, outcome);
    const event = {
      type: 'test',
      page: test.page,
      line: test.cell.fenceStartLine,
      cell: test.cell.id,
      case: test.case,
      status: failures.length ? 'fail' : 'pass',
      durationMs: Math.round(performance.now() - started),
      failures
    };
    events.push(event);
    report(event);
  }
  const failed = events.filter((event) => event.status === 'fail').length;
  return { total: events.length, passed: events.length - failed, failed };
}

export function testFailures(test, outcome) {
  const location = test.expectationLocations?.[0] ?? test.location ?? { line: test.cell.fenceStartLine, column: 1 };
  if (
    outcome.kind === 'timeout' ||
    outcome.kind === 'harness-error' ||
    (!test.expect.length && outcome.kind !== 'result')
  ) {
    return [
      {
        reason: outcome.kind,
        actual: boundedDisplay(outcome.error),
        expected: test.expect.length ? boundedDisplay(test.expect) : 'execute without an error',
        fieldPath: test.expect.length ? `tests[${test.testIndex}].expect[0]` : 'tests',
        location
      }
    ];
  }
  return test.expect.flatMap((expectation, index) => {
    const failure = evaluateExpectation(expectation, outcome);
    return failure
      ? [
          {
            ...failure,
            actual: boundedDisplay(failure.actual),
            expected: boundedDisplay(expectation),
            ...(expectation.path !== undefined ? { path: expectation.path } : {}),
            ...(expectation.artifact !== undefined ? { artifact: expectation.artifact } : {}),
            fieldPath: `tests[${test.testIndex}].expect[${index}]`,
            location: test.expectationLocations?.[index] ?? location
          }
        ]
      : [];
  });
}

export function executeGeneratedRustCell({
  module,
  runtimeUrl,
  cell,
  inputs,
  createWorker = (url, options) => new Worker(url, options),
  setTimer = setTimeout,
  clearTimer = clearTimeout
}) {
  return new Promise((resolve) => {
    let timer;
    let settled = false;
    const worker = createWorker(new URL('./rust-test-worker.mjs', import.meta.url), {
      workerData: { module, runtimeUrl },
      stdout: true,
      stderr: true
    });
    // Drain incidental Rust/panic output without allowing it to corrupt NDJSON.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimer(timer);
      void worker.terminate();
      resolve(outcome);
    };
    worker.on('message', (message) => {
      if (message.kind === 'ready') {
        clearTimer(timer);
        timer = setTimer(
          () => finish({ kind: 'timeout', error: `Cell ${cell.id} timed out after ${cell.timeoutMs}ms` }),
          cell.timeoutMs
        );
        worker.postMessage({ cellId: cell.id, inputs });
      } else finish(message);
    });
    worker.on('error', (error) => finish({ kind: 'harness-error', error: boundedErrorMessage(error) }));
    worker.on('exit', (code) =>
      finish({ kind: 'harness-error', error: `Rust test worker exited before returning a result (status ${code}).` })
    );
    // Bound startup separately so module initialization cannot hang the command.
    timer = setTimer(
      () => finish({ kind: 'harness-error', error: 'Rust test worker initialization timed out after 30000ms.' }),
      30_000
    );
  });
}
