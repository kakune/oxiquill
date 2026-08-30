import { ExecutionCancellationError, isExecutionCancellation } from './execution-cancellation.js';

type SchedulerTimer = ReturnType<typeof setTimeout>;

type ScheduledRequest<Request> = {
  generation: number;
  ready: boolean;
  request: Request;
};

type LatestRequestSchedulerOptions<Request, Result> = {
  execute: (request: Request, signal: AbortSignal) => Promise<Result>;
  onCancelled?: () => void;
  onError: (error: unknown) => void;
  onResult: (result: Result) => void;
  onScheduled: () => void;
};

type SchedulerDependencies = {
  clearTimeout: (timer: SchedulerTimer) => void;
  setTimeout: (handler: () => void, delayMs: number) => SchedulerTimer;
};

export function createLatestRequestScheduler<Request, Result>(
  callbacks: LatestRequestSchedulerOptions<Request, Result>,
  dependencies: SchedulerDependencies = defaultSchedulerDependencies
): {
  dispose: () => void;
  cancel: () => void;
  schedule: (request: Request, delayMs?: number) => void;
} {
  let activeController: AbortController | undefined;
  let activeGeneration: number | undefined;
  let generation = 0;
  let listeners: LatestRequestSchedulerOptions<Request, Result> | undefined = callbacks;
  let pending: ScheduledRequest<Request> | undefined;
  let timer: SchedulerTimer | undefined;

  function schedule(request: Request, delayMs = 0): void {
    if (!listeners) return;

    generation += 1;
    clearPendingTimer();
    pending = { generation, ready: delayMs <= 0, request };
    listeners.onScheduled();
    activeController?.abort();

    if (delayMs > 0) {
      const scheduledGeneration = generation;
      timer = dependencies.setTimeout(() => {
        timer = undefined;
        if (!pending || pending.generation !== scheduledGeneration) return;

        pending.ready = true;
        drain();
      }, delayMs);
      return;
    }

    drain();
  }

  function drain(): void {
    if (!listeners || activeGeneration !== undefined || !pending?.ready) return;

    const active = pending;
    const controller = new AbortController();
    pending = undefined;
    activeGeneration = active.generation;
    activeController = controller;

    void executeWithCancellation(active.request, controller)
      .then(
        (result) => {
          if (listeners && generation === active.generation) {
            listeners.onResult(result);
          }
        },
        (error: unknown) => {
          if (listeners && generation === active.generation) {
            if (isExecutionCancellation(error)) {
              listeners.onCancelled?.();
            } else {
              listeners.onError(error);
            }
          }
        }
      )
      .finally(() => {
        if (activeController === controller) {
          activeController = undefined;
          activeGeneration = undefined;
        }
        drain();
      })
      .catch(() => undefined);
  }

  function executeWithCancellation(request: Request, controller: AbortController): Promise<Result> {
    const execution = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ExecutionCancellationError();
      return callbacks.execute(request, controller.signal);
    });
    const cancellation = new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new ExecutionCancellationError()), { once: true });
    });
    return Promise.race([execution, cancellation]);
  }

  function clearPendingTimer(): void {
    if (timer === undefined) return;

    dependencies.clearTimeout(timer);
    timer = undefined;
  }

  function cancel(): void {
    generation += 1;
    clearPendingTimer();
    pending = undefined;
    activeController?.abort();
  }

  function dispose(): void {
    cancel();
    listeners = undefined;
  }

  return { cancel, dispose, schedule };
}

export function createRunOnceCache<Key, Result>(): {
  getOrCreate: (key: Key, execute: () => Promise<Result>) => Promise<Result>;
} {
  const requests = new Map<Key, Promise<Result>>();

  return {
    getOrCreate(key, execute) {
      const existing = requests.get(key);
      if (existing) return existing;

      const request = Promise.resolve().then(execute);
      requests.set(key, request);
      void request.catch((error: unknown) => {
        if (isExecutionCancellation(error) && requests.get(key) === request) requests.delete(key);
      });
      return request;
    }
  };
}

const defaultSchedulerDependencies: SchedulerDependencies = {
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs)
};
