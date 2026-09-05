import type {
  CellLanguage,
  CellManifest,
  InputValues,
  RuntimeWorkerRequest,
  PythonWorkerResponse,
  RuntimeExecutionPhase
} from './types.js';
import { ExecutionCancellationError } from './execution-cancellation.js';
import { assertValidInputValues, completeInputValues } from './interactive-input-validation.js';
import { normalizeCellExecutionResult, type NormalizedCellExecutionResult } from './output-artifacts.js';
import { boundedErrorMessage } from './output-limits.mjs';
import { markRuntimeEvent } from './runtime-timing.js';

type PendingRequest = {
  reject: (reason: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
  worker: Worker;
  removeAbortListener: () => void;
} & (
  | {
      type: 'execute';
      resolve: (value: NormalizedCellExecutionResult) => void;
      onPhase?: (phase: RuntimeExecutionPhase) => void;
    }
  | { type: 'prepare'; resolve: () => void }
);

export type PythonPreparationState = 'idle' | 'preparing' | 'ready';

type RuntimeClientDependencies = {
  clearTimeout: (timeout: ReturnType<typeof setTimeout>) => void;
  createWorker: (language: CellLanguage) => Worker;
  setTimeout: (handler: () => void, timeout: number) => ReturnType<typeof setTimeout>;
};

export function runInteractiveCell(
  cell: CellManifest,
  inputs: InputValues,
  runtimeVersion?: string,
  signal?: AbortSignal,
  onPhase?: (phase: RuntimeExecutionPhase) => void
): Promise<NormalizedCellExecutionResult> {
  /* v8 ignore next -- the factory is unit-tested; this delegates to browser Worker adapters. */
  return defaultRuntimeClient.runInteractiveCell(cell, inputs, runtimeVersion, signal, onPhase);
}

export function preparePythonRuntime(packages: readonly string[], timeoutMs?: number): Promise<void> {
  return defaultRuntimeClient.preparePythonRuntime(packages, timeoutMs);
}

export function getPythonPreparationState(): PythonPreparationState {
  return defaultRuntimeClient.getPythonPreparationState();
}

export function subscribePythonPreparation(listener: () => void): () => void {
  return defaultRuntimeClient.subscribePythonPreparation(listener);
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
  let preparation: { worker: Worker; key: string; promise: Promise<void> } | undefined;
  let preparationState: PythonPreparationState = 'idle';
  const preparationListeners = new Set<() => void>();
  function setPreparationState(state: PythonPreparationState): void {
    if (state === preparationState) return;
    preparationState = state;
    for (const listener of preparationListeners) listener();
  }

  function preparePythonRuntime(packages: readonly string[], timeoutMs = 120_000): Promise<void> {
    let worker: Worker;
    try {
      worker = getWorker('python');
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const names = [...new Set(packages)].sort();
    const key = JSON.stringify(names);
    if (preparation?.worker === worker && preparation.key === key) return preparation.promise;
    const requestId = nextRequestId++;
    setPreparationState('preparing');
    const promise = new Promise<void>((resolve, reject) => {
      const timeout = dependencies.setTimeout(
        () => failWorker(worker, new Error('Python preparation timed out after ' + timeoutMs + 'ms')),
        timeoutMs
      );
      pending.set(requestId, {
        type: 'prepare',
        resolve,
        reject,
        timeout,
        worker,
        removeAbortListener: () => undefined
      });
      try {
        worker.postMessage({ type: 'prepare', requestId, packages: names });
      } catch (error) {
        failWorker(worker, toError(error));
      }
    });
    const attempt = { worker, key, promise };
    preparation = attempt;
    void promise.then(
      () => {
        if (preparation === attempt) setPreparationState('ready');
      },
      () => {
        if (preparation === attempt) {
          preparation = undefined;
          setPreparationState('idle');
        }
      }
    );
    return promise;
  }

  function runCell(
    cell: CellManifest,
    inputs: InputValues,
    runtimeVersion?: string,
    signal?: AbortSignal,
    onPhase?: (phase: RuntimeExecutionPhase) => void
  ): Promise<NormalizedCellExecutionResult> {
    const completeValues = completeInputValues(cell, inputs);
    try {
      assertValidInputValues(cell, completeValues);
    } catch (error) {
      return Promise.reject(toError(error));
    }
    if (signal?.aborted) return Promise.reject(new ExecutionCancellationError());

    const requestId = nextRequestId++;
    const request = createWorkerRequest(requestId, cell, completeValues, runtimeVersion);

    return new Promise((resolve, reject) => {
      let worker: Worker | undefined;

      try {
        worker = getWorker(cell.language);
        const ownedWorker = worker;
        const timeout = dependencies.setTimeout(() => {
          failWorker(ownedWorker, new Error(`${cell.title} timed out after ${cell.timeoutMs}ms`));
        }, cell.timeoutMs);

        const abort = () => failWorker(ownedWorker, new ExecutionCancellationError());
        signal?.addEventListener('abort', abort, { once: true });
        pending.set(requestId, {
          type: 'execute',
          onPhase,
          resolve,
          reject,
          timeout,
          worker,
          removeAbortListener: () => signal?.removeEventListener('abort', abort)
        });

        if (signal?.aborted) {
          abort();
          return;
        }

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

    markRuntimeEvent('worker-start', language);
    const worker = dependencies.createWorker(language);

    try {
      worker.addEventListener('message', (event: MessageEvent<PythonWorkerResponse>) => {
        if (workers.get(language) !== worker) return;
        if (!isRuntimeWorkerResponse(event.data) || (language !== 'python' && 'type' in event.data)) {
          failWorker(worker, new Error(`${language} worker sent an invalid message`));
          return;
        }

        const request = pending.get(event.data.requestId);
        if (!request || request.worker !== worker) return;
        if ('type' in event.data && event.data.type === 'progress') {
          if (request.type === 'execute') request.onPhase?.(event.data.phase);
          return;
        }
        const ready = 'type' in event.data && event.data.type === 'ready';
        if (event.data.ok && (request.type === 'prepare') !== ready) {
          failWorker(worker, new Error(language + ' worker sent an unexpected response'));
          return;
        }

        pending.delete(event.data.requestId);
        dependencies.clearTimeout(request.timeout);
        request.removeAbortListener();

        if (!event.data.ok) {
          request.reject(toError(event.data.error));
          return;
        }

        try {
          if (request.type === 'prepare') request.resolve();
          else if ('result' in event.data) request.resolve(normalizeCellExecutionResult(event.data.result));
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
    const boundedError = toError(error);
    let ownsWorker = false;

    for (const [language, current] of workers) {
      if (current !== worker) continue;

      ownsWorker = true;
      workers.delete(language);
      if (language === 'python') {
        preparation = undefined;
        setPreparationState('idle');
      }
    }

    const ownedRequests = Array.from(pending.entries()).filter(([, request]) => request.worker === worker);
    if (!ownsWorker && ownedRequests.length === 0) return;

    worker.terminate();

    for (const [requestId, request] of ownedRequests) {
      dependencies.clearTimeout(request.timeout);
      request.removeAbortListener();
      pending.delete(requestId);
      request.reject(boundedError);
    }
  }

  return {
    runInteractiveCell: runCell,
    preparePythonRuntime,
    getPythonPreparationState: () => preparationState,
    subscribePythonPreparation: (listener: () => void) => {
      preparationListeners.add(listener);
      return () => {
        preparationListeners.delete(listener);
      };
    },
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
    integerInputNames:
      cell.language === 'python'
        ? cell.inputs.filter((input) => input.type === 'integer' || input.integer).map((input) => input.name)
        : undefined,
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

function isRuntimeWorkerResponse(value: unknown): value is PythonWorkerResponse {
  if (!isRecord(value) || !Number.isSafeInteger(value.requestId)) return false;
  if (value.type === 'progress') return value.phase === 'preparing' || value.phase === 'executing';
  if (value.type === 'ready') return value.ok === true;
  if (typeof value.ok !== 'boolean') return false;
  return value.ok ? isRecord(value.result) : typeof value.error === 'string';
}

function toError(value: unknown): Error {
  const message = boundedErrorMessage(value);
  try {
    return value instanceof Error && value.name === 'AbortError'
      ? new ExecutionCancellationError(message)
      : new Error(message);
  } catch {
    return new Error(message);
  }
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
