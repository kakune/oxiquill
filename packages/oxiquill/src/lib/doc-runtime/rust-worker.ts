import init, { run_rust_cell } from 'virtual:oxiquill/rust-wasm';
import { boundedErrorMessage } from './output-limits.mjs';
import type { CellExecutionResult, RuntimeWorkerRequest, RuntimeWorkerResponse } from './types.js';
import { boundWorkerResult } from './worker-output.js';

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

const worker = self as unknown as WorkerScope;
let wasmReady: Promise<void> | undefined;

worker.addEventListener('message', (event) => {
  void handleRequest(event.data);
});

async function handleRequest(request: RuntimeWorkerRequest): Promise<void> {
  try {
    await ensureWasm();
    const result = boundWorkerResult(
      JSON.parse(run_rust_cell(request.cellId, JSON.stringify(request.inputs))) as CellExecutionResult
    );

    worker.postMessage({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: boundedErrorMessage(error)
    });
  }
}

function ensureWasm(): Promise<void> {
  return (wasmReady ??= init().then(() => undefined));
}
