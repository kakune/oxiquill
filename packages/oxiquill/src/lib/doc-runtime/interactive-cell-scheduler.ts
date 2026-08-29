type SchedulerTimer = ReturnType<typeof setTimeout>;

type ScheduledRequest<Request> = {
  generation: number;
  ready: boolean;
  request: Request;
};

type LatestRequestSchedulerOptions<Request, Result> = {
  execute: (request: Request) => Promise<Result>;
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
  schedule: (request: Request, delayMs?: number) => void;
} {
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
    pending = undefined;
    activeGeneration = active.generation;

    void Promise.resolve()
      .then(() => callbacks.execute(active.request))
      .then(
        (result) => {
          if (listeners && generation === active.generation) {
            listeners.onResult(result);
          }
        },
        (error: unknown) => {
          if (listeners && generation === active.generation) {
            listeners.onError(error);
          }
        }
      )
      .finally(() => {
        activeGeneration = undefined;
        drain();
      })
      .catch(() => undefined);
  }

  function clearPendingTimer(): void {
    if (timer === undefined) return;

    dependencies.clearTimeout(timer);
    timer = undefined;
  }

  function dispose(): void {
    generation += 1;
    clearPendingTimer();
    pending = undefined;
    listeners = undefined;
  }

  return { dispose, schedule };
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
      return request;
    }
  };
}

const defaultSchedulerDependencies: SchedulerDependencies = {
  clearTimeout: (timer) => globalThis.clearTimeout(timer),
  setTimeout: (handler, delayMs) => globalThis.setTimeout(handler, delayMs)
};
