import { parentPort, workerData } from 'node:worker_threads';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import { boundWorkerResult } from '../../lib/doc-runtime/worker-output.js';
import { normalizeCellExecutionResult } from '../../lib/doc-runtime/output-artifacts.js';

export async function runRustTestRequest(runtime, request) {
  let raw;
  try {
    raw = runtime.run_rust_cell(request.cellId, JSON.stringify(request.inputs));
  } catch (error) {
    return { kind: 'execution-error', error: boundedErrorMessage(error) };
  }
  try {
    const { outputs } = normalizeCellExecutionResult(boundWorkerResult(JSON.parse(raw)));
    return { kind: 'result', result: { outputs } };
  } catch (error) {
    return { kind: 'harness-error', error: boundedErrorMessage(error) };
  }
}

if (parentPort) {
  try {
    const runtime = await import(workerData.runtimeUrl);
    runtime.initSync({ module: workerData.module });
    parentPort.on('message', async (request) => parentPort.postMessage(await runRustTestRequest(runtime, request)));
    parentPort.postMessage({ kind: 'ready' });
  } catch (error) {
    parentPort.postMessage({ kind: 'harness-error', error: boundedErrorMessage(error) });
  }
}
