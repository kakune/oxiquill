import type { CellLanguage, CellManifest, InputValues, RuntimeWorkerRequest, RuntimeWorkerResponse } from './types.js';
import { normalizeCellExecutionResult, type NormalizedCellExecutionResult } from './output-artifacts.js';

type PendingRequest = {
  reject: (reason: Error) => void;
  resolve: (value: NormalizedCellExecutionResult) => void;
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
  inputs: InputValues,
  runtimeVersion?: string
): Promise<NormalizedCellExecutionResult> {
  /* v8 ignore next -- the factory is unit-tested; this delegates to browser Worker adapters. */
  return defaultRuntimeClient.runInteractiveCell(cell, inputs, runtimeVersion);
}

export function resetInteractiveRuntime(language?: CellLanguage): void {
  if (language) {
    defaultRuntimeClient.resetWorker(language);
    return;
  }

  defaultRuntimeClient.resetWorker('rust');
  defaultRuntimeClient.resetWorker('python');
  defaultRuntimeClient.resetWorker('haskell');
}

export function createInteractiveCellRunner(dependencies: RuntimeClientDependencies) {
  let nextRequestId = 1;
  const workers = new Map<CellLanguage, Worker>();
  const pending = new Map<number, PendingRequest>();

  function runCell(
    cell: CellManifest,
    inputs: InputValues,
    runtimeVersion?: string
  ): Promise<NormalizedCellExecutionResult> {
    const requestId = nextRequestId++;
    const request = createWorkerRequest(requestId, cell, inputs, runtimeVersion);

    return new Promise((resolve, reject) => {
      let worker: Worker | undefined;

      try {
        worker = getWorker(cell.language);
        const ownedWorker = worker;
        const timeout = dependencies.setTimeout(() => {
          failWorker(ownedWorker, new Error(`${cell.title} timed out after ${cell.timeoutMs}ms`));
        }, cell.timeoutMs);

        pending.set(requestId, { resolve, reject, timeout, worker });

        try {
          worker.postMessage(request);
        } catch (error) {
          failWorker(worker, toError(error));
        }
      } catch (error) {
        if (worker && pending.has(requestId)) {
          failWorker(worker, toError(error));
        } else {
          reject(toError(error));
        }
      }
    });
  }

  function getWorker(language: CellLanguage): Worker {
    const current = workers.get(language);
    if (current) return current;

    const worker = dependencies.createWorker(language);

    try {
      worker.addEventListener('message', (event: MessageEvent<RuntimeWorkerResponse>) => {
        const request = pending.get(event.data.requestId);
        if (!request || request.worker !== worker) return;

        pending.delete(event.data.requestId);
        dependencies.clearTimeout(request.timeout);

        if (!event.data.ok) {
          request.reject(new Error(event.data.error));
          return;
        }

        try {
          request.resolve(normalizeCellExecutionResult(event.data.result));
        } catch (error) {
          request.reject(toError(error));
        }
      });

      worker.addEventListener('error', (event) => {
        failWorker(worker, new Error(event.message || `${language} worker failed`));
      });
      worker.addEventListener('messageerror', () => {
        failWorker(worker, new Error(`${language} worker sent an unreadable message`));
      });
    } catch (error) {
      worker.terminate();
      throw error;
    }

    workers.set(language, worker);
    return worker;
  }

  function resetWorker(language: CellLanguage): void {
    const worker = workers.get(language);
    if (!worker) return;

    failWorker(worker, new Error(`${language} worker was reset`));
  }

  function failWorker(worker: Worker, error: Error): void {
    let ownsWorker = false;

    for (const [language, current] of workers) {
      if (current !== worker) continue;

      ownsWorker = true;
      workers.delete(language);
    }

    const ownedRequests = Array.from(pending.entries()).filter(([, request]) => request.worker === worker);
    if (!ownsWorker && ownedRequests.length === 0) return;

    worker.terminate();

    for (const [requestId, request] of ownedRequests) {
      dependencies.clearTimeout(request.timeout);
      pending.delete(requestId);
      request.reject(error);
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
  inputs: InputValues,
  runtimeVersion?: string
): RuntimeWorkerRequest {
  return {
    requestId,
    cellId: cell.id,
    ...(cell.language === 'haskell' ? { haskellFingerprintHash: runtimeHaskellFingerprintHash(runtimeVersion) } : {}),
    inputArgs: cell.language === 'haskell' ? cell.inputs.map((input) => inputArgument(input, inputs)) : undefined,
    inputs,
    source: cell.language === 'python' ? cell.source : undefined,
    packages: cell.language === 'python' ? cell.packages : undefined
  };
}

export function runtimeHaskellFingerprintHash(runtimeVersion: string | undefined): string | undefined {
  if (!runtimeVersion) return undefined;

  try {
    const parsed = JSON.parse(runtimeVersion) as unknown;
    if (isRecord(parsed) && typeof parsed.haskell === 'string') return parsed.haskell;
  } catch {
    return undefined;
  }

  return undefined;
}

function createDefaultWorker(language: CellLanguage): Worker {
  /* v8 ignore next -- covered by browser integration and E2E tests. */
  switch (language) {
    case 'rust':
      return new Worker(new URL('./rust-worker.js', import.meta.url), { type: 'module' });
    case 'python':
      return new Worker(new URL('./python-worker.js', import.meta.url), { type: 'module' });
    case 'haskell':
      return new Worker(new URL('./haskell-worker.js', import.meta.url), { type: 'module' });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

function inputArgument(input: CellManifest['inputs'][number], inputs: InputValues): string {
  const value = inputs[input.name] ?? input.value;
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

const defaultRuntimeClient = createInteractiveCellRunner({
  clearTimeout: (timeout) => globalThis.clearTimeout(timeout),
  createWorker: createDefaultWorker,
  setTimeout: (handler, timeout) => globalThis.setTimeout(handler, timeout)
});
