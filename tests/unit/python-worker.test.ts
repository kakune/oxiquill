import { describe, expect, it } from 'vitest';
import { createSerialRequestQueue } from '../../src/lib/doc-runtime/python-worker';

function createDeferred() {
  let reject!: (reason: Error) => void;
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise, rejectPromise) => {
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

describe('python worker request queue', () => {
  it('processes queued requests one at a time', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    expect(events).toEqual(['start:first']);

    first.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'finish:first', 'start:second', 'finish:second']);
  });

  it('continues draining after a request rejects', async () => {
    const first = createDeferred();
    const second = createDeferred();
    const events: string[] = [];
    const queue = createSerialRequestQueue(async (request: string) => {
      events.push(`start:${request}`);
      await (request === 'first' ? first.promise : second.promise);
      events.push(`finish:${request}`);
    });

    queue.enqueue('first');
    queue.enqueue('second');
    await flushMicrotasks();

    first.reject(new Error('failed'));
    await first.promise.catch(() => undefined);
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second']);

    second.resolve();
    await flushMicrotasks();

    expect(events).toEqual(['start:first', 'start:second', 'finish:second']);
  });
});
