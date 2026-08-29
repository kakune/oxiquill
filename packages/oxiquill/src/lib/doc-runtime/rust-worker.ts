import init, { run_rust_cell } from 'virtual:oxiquill/rust-wasm';
import type { CellExecutionResult, RuntimeWorkerRequest, RuntimeWorkerResponse } from './types.js';

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
    const result = JSON.parse(run_rust_cell(request.cellId, JSON.stringify(request.inputs))) as CellExecutionResult;

    worker.postMessage({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function ensureWasm(): Promise<void> {
  return (wasmReady ??= init().then(() => undefined));
}
