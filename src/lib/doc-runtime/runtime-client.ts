import type {
  CellExecutionResult,
  CellLanguage,
  CellManifest,
  InputValues,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse
} from './types';

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (value: CellExecutionResult) => void;
  timeout: ReturnType<typeof setTimeout>;
  worker: Worker;
};

type RuntimeClientDependencies = {
  clearTimeout: (timeout: ReturnType<typeof setTimeout>) => void;
  createWorker: (language: CellLanguage) => Worker;
  setTimeout: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
};

export function runInteractiveCell(
  cell: CellManifest,
  inputs: InputValues
): Promise<CellExecutionResult> {
  /* v8 ignore next -- the factory is unit-tested; this delegates to browser Worker adapters. */
  return defaultRuntimeClient.runInteractiveCell(cell, inputs);
}

export function resetInteractiveRuntime(language?: CellLanguage): void {
  if (language) {
    defaultRuntimeClient.resetWorker(language);
    return;
  }

  defaultRuntimeClient.resetWorker('rust');
  defaultRuntimeClient.resetWorker('python');
}

export function createInteractiveCellRunner(dependencies: RuntimeClientDependencies) {
  let nextRequestId = 1;
  const workers = new Map<CellLanguage, Worker>();
  const pending = new Map<number, PendingRequest>();

  function runCell(cell: CellManifest, inputs: InputValues): Promise<CellExecutionResult> {
    const requestId = nextRequestId++;
    const worker = getWorker(cell.language);
    const request = createWorkerRequest(requestId, cell, inputs);

    return new Promise((resolve, reject) => {
      const timeout = dependencies.setTimeout(() => {
        pending.delete(requestId);
        resetWorker(cell.language);
        reject(new Error(`${cell.title} timed out after ${cell.timeoutMs}ms`));
      }, cell.timeoutMs);

      pending.set(requestId, { resolve, reject, timeout, worker });
      worker.postMessage(request);
    });
  }

  function getWorker(language: CellLanguage): Worker {
    const current = workers.get(language);
    if (current) return current;

    const worker = dependencies.createWorker(language);

    worker.addEventListener('message', (event: MessageEvent<RuntimeWorkerResponse>) => {
      const request = pending.get(event.data.requestId);
      if (!request) return;

      pending.delete(event.data.requestId);
      dependencies.clearTimeout(request.timeout);

      if (event.data.ok) {
        request.resolve(event.data.result);
      } else {
        request.reject(new Error(event.data.error));
      }
    });

    worker.addEventListener('error', (event) => {
      rejectAllForWorker(worker, new Error(event.message));
    });

    workers.set(language, worker);
    return worker;
  }

  function resetWorker(language: CellLanguage): void {
    const worker = workers.get(language);
    if (!worker) return;

    worker.terminate();
    workers.delete(language);
    rejectAllForWorker(worker, new Error(`${language} worker was reset`));
  }

  function rejectAllForWorker(worker: Worker, error: Error): void {
    for (const [requestId, request] of pending) {
      if (request.worker !== worker) continue;

      dependencies.clearTimeout(request.timeout);
      pending.delete(requestId);
      request.reject(error);
    }

    for (const [language, current] of workers) {
      if (current === worker) {
        workers.delete(language);
      }
    }
  }

  return {
    runInteractiveCell: runCell,
    resetWorker
  };
}

function createWorkerRequest(
  requestId: number,
  cell: CellManifest,
  inputs: InputValues
): RuntimeWorkerRequest {
  return {
    requestId,
    cellId: cell.id,
    inputs,
    source: cell.language === 'python' ? cell.source : undefined,
    packages: cell.language === 'python' ? cell.packages : undefined
  };
}

function createDefaultWorker(language: CellLanguage): Worker {
  /* v8 ignore next -- covered by browser integration and E2E tests. */
  return language === 'rust'
    ? new Worker(new URL('./rust-worker.ts', import.meta.url), { type: 'module' })
    : new Worker(new URL('./python-worker.ts', import.meta.url), { type: 'module' });
}

const defaultRuntimeClient = createInteractiveCellRunner({
  clearTimeout: (timeout) => globalThis.clearTimeout(timeout),
  createWorker: createDefaultWorker,
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout)
});
