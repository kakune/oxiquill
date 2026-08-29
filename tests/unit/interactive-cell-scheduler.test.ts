import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLatestRequestScheduler,
  createRunOnceCache
} from '../../packages/oxiquill/src/lib/doc-runtime/interactive-cell-scheduler';

function createDeferred<Result>() {
  let reject!: (reason: Error) => void;
  let resolve!: (result: Result) => void;
  const promise = new Promise<Result>((resolvePromise, rejectPromise) => {
    reject = rejectPromise;
    resolve = resolvePromise;
  });

  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

afterEach(() => {
  vi.useRealTimers();
});

describe('interactive cell request scheduler', () => {
  it('keeps one active request and only the newest delayed replacement', async () => {
    vi.useFakeTimers();
    const executions: number[] = [];
    const pending: Array<ReturnType<typeof createDeferred<string>>> = [];
    const onResult = vi.fn();
    const scheduler = createLatestRequestScheduler<number, string>({
      execute: (request) => {
        executions.push(request);
        const deferred = createDeferred<string>();
        pending.push(deferred);
        return deferred.promise;
      },
      onError: vi.fn(),
      onResult,
      onScheduled: vi.fn()
    });

    scheduler.schedule(0);
    await flushMicrotasks();

    for (let value = 1; value <= 10; value += 1) {
      scheduler.schedule(value, 150);
    }
    await vi.advanceTimersByTimeAsync(150);

    expect(executions).toEqual([0]);

    pending[0].resolve('obsolete');
    await flushMicrotasks();

    expect(executions).toEqual([0, 10]);
    expect(onResult).not.toHaveBeenCalled();

    pending[1].resolve('latest');
    await flushMicrotasks();

    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith('latest');
  });

  it('suppresses stale failures and continues with the ready replacement', async () => {
    const pending: Array<ReturnType<typeof createDeferred<string>>> = [];
    const onError = vi.fn();
    const onResult = vi.fn();
    const scheduler = createLatestRequestScheduler<string, string>({
      execute: () => {
        const deferred = createDeferred<string>();
        pending.push(deferred);
        return deferred.promise;
      },
      onError,
      onResult,
      onScheduled: vi.fn()
    });

    scheduler.schedule('old');
    await flushMicrotasks();
    scheduler.schedule('new');
    pending[0].reject(new Error('obsolete failure'));
    await flushMicrotasks();

    expect(pending).toHaveLength(2);
    expect(onError).not.toHaveBeenCalled();

    pending[1].resolve('new result');
    await flushMicrotasks();

    expect(onResult).toHaveBeenCalledWith('new result');
  });

  it('drops delayed work and callbacks when disposed while consuming active failures', async () => {
    vi.useFakeTimers();
    const deferred = createDeferred<string>();
    const execute = vi.fn(() => deferred.promise);
    const onError = vi.fn();
    const onResult = vi.fn();
    const scheduler = createLatestRequestScheduler<string, string>({
      execute,
      onError,
      onResult,
      onScheduled: vi.fn()
    });

    scheduler.schedule('active');
    await flushMicrotasks();
    scheduler.schedule('delayed', 150);
    scheduler.dispose();
    await vi.advanceTimersByTimeAsync(150);
    deferred.reject(new Error('failure after disposal'));
    await flushMicrotasks();

    expect(execute).toHaveBeenCalledOnce();
    expect(onError).not.toHaveBeenCalled();
    expect(onResult).not.toHaveBeenCalled();
  });

  it('shares successful and failed executions by key', async () => {
    const cache = createRunOnceCache<string, string>();
    const execute = vi.fn(async () => 'result');
    const first = cache.getOrCreate('same', execute);
    const second = cache.getOrCreate('same', execute);

    expect(second).toBe(first);
    await expect(first).resolves.toBe('result');
    expect(execute).toHaveBeenCalledOnce();

    const failure = new Error('cached failure');
    const failedExecute = vi.fn(async () => Promise.reject(failure));
    const failed = cache.getOrCreate('failed', failedExecute);

    await expect(failed).rejects.toBe(failure);
    await expect(cache.getOrCreate('failed', failedExecute)).rejects.toBe(failure);
    expect(failedExecute).toHaveBeenCalledOnce();
  });
});
