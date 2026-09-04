import { describe, expect, it } from 'vitest';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import {
  classifyChangedPath,
  createRuntimeWatchPaths,
  createSerialTaskQueue,
  describeChangeKinds,
  mergeChangeKinds,
  shouldSyncRuntime,
  toRelativePath,
  toWatchEventRelativePath
} from '../../packages/oxiquill/src/generator/doc-runtime-watch-core.mjs';

describe('doc runtime watch core', () => {
  it('classifies paths that affect runtime generation', () => {
    expect(classifyChangedPath('content/docs/index.mdx')).toBe('docs');
    expect(classifyChangedPath('content/docs/page.md')).toBe('docs');
    expect(classifyChangedPath('crates/doc-rust/src/lib.rs')).toBe('crate');
    expect(classifyChangedPath('crates/doc-rust/Cargo.toml')).toBe('crate');
    expect(classifyChangedPath('crates/Cargo.toml')).toBe('crate');
    expect(classifyChangedPath('Cargo.toml')).toBe('other');
    expect(classifyChangedPath('src/styles/custom.css')).toBe('other');
  });

  it('merges, describes, and filters change kinds', () => {
    expect(shouldSyncRuntime(new Set())).toBe(false);
    expect(shouldSyncRuntime(new Set(['other']))).toBe(false);
    expect(shouldSyncRuntime(new Set(['docs']))).toBe(true);
    expect(shouldSyncRuntime(new Set(['crate']))).toBe(true);

    const kinds = mergeChangeKinds(new Set(['docs']), 'crate');
    expect(mergeChangeKinds(kinds, 'other')).toEqual(kinds);
    expect(describeChangeKinds(new Set())).toBe('no runtime changes');
    expect(describeChangeKinds(kinds)).toBe('crate, docs');
  });

  it('normalizes absolute paths to root-relative slash paths', () => {
    expect(toRelativePath('/repo', '/repo/content/docs/index.mdx')).toBe('content/docs/index.mdx');
  });

  it('uses non-glob watch roots and normalizes chokidar event paths', () => {
    expect(createRuntimeWatchPaths()).toEqual(['content/docs', 'crates']);
    expect(toWatchEventRelativePath('/repo', 'content/docs/index.mdx')).toBe('content/docs/index.mdx');
    expect(toWatchEventRelativePath('/repo', '/repo/crates/doc-rust/src/lib.rs')).toBe('crates/doc-rust/src/lib.rs');
  });

  it('classifies and watches the resolved custom docs and crates directories', () => {
    const paths = createOxiquillPaths({
      cratesDir: 'helper crates',
      docsDir: 'written docs',
      workspaceRoot: '/repo'
    });

    expect(createRuntimeWatchPaths(paths)).toEqual([paths.docsDir, paths.cratesDir]);
    expect(classifyChangedPath('written docs/guide.mdx', paths)).toBe('docs');
    expect(classifyChangedPath('helper crates/example/src/lib.rs', paths)).toBe('crate');
    expect(classifyChangedPath('content/docs/guide.mdx', paths)).toBe('other');
  });

  it('serializes tasks and coalesces pending enqueues', async () => {
    const events = [];
    let releaseFirst = () => undefined;
    const firstRun = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const queue = createSerialTaskQueue(async () => {
      events.push('run');
      if (events.length === 1) await firstRun;
    });

    queue.enqueue();
    queue.enqueue();
    expect(queue.isRunning()).toBe(true);
    releaseFirst();
    await Promise.resolve();
    await Promise.resolve();

    expect(events).toEqual(['run', 'run']);
  });

  it('reports task errors and allows later tasks', async () => {
    const errors = [];
    let shouldFail = true;
    let runs = 0;
    const queue = createSerialTaskQueue(
      async () => {
        runs += 1;
        if (shouldFail) {
          shouldFail = false;
          throw new Error('failed');
        }
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    await waitForQueueIdle(queue);
    queue.enqueue();
    await waitForQueueIdle(queue);

    expect(runs).toBe(2);
    expect(errors).toEqual(['failed']);
    expect(queue.isRunning()).toBe(false);
  });

  it('runs a pending task after the active task fails', async () => {
    const firstRun = createDeferred();
    const errors = [];
    let runs = 0;
    const queue = createSerialTaskQueue(
      async () => {
        runs += 1;
        if (runs === 1) await firstRun.promise;
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    queue.enqueue();
    firstRun.reject(new Error('first failed'));
    await waitForQueueIdle(queue);

    expect(runs).toBe(2);
    expect(errors).toEqual(['first failed']);
    expect(queue.isRunning()).toBe(false);
  });

  it('coalesces multiple pending enqueues after an active task fails', async () => {
    const firstRun = createDeferred();
    const errors = [];
    let runs = 0;
    const queue = createSerialTaskQueue(
      async () => {
        runs += 1;
        if (runs === 1) await firstRun.promise;
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    queue.enqueue();
    queue.enqueue();
    queue.enqueue();
    firstRun.reject(new Error('first failed'));
    await waitForQueueIdle(queue);

    expect(runs).toBe(2);
    expect(errors).toEqual(['first failed']);
  });

  it('reports a failure without a pending enqueue and leaves the queue idle', async () => {
    const activeRun = createDeferred();
    const errors = [];
    let runs = 0;
    const queue = createSerialTaskQueue(
      async () => {
        runs += 1;
        await activeRun.promise;
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    activeRun.reject(new Error('failed'));
    await waitForQueueIdle(queue);

    expect(runs).toBe(1);
    expect(errors).toEqual(['failed']);
    expect(queue.isRunning()).toBe(false);
  });

  it('reports consecutive failures once without overlapping tasks', async () => {
    const firstRun = createDeferred();
    const errors = [];
    let active = 0;
    let maximumActive = 0;
    let runs = 0;
    const queue = createSerialTaskQueue(
      async () => {
        runs += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);

        try {
          if (runs === 1) await firstRun.promise;
          throw new Error('second failed');
        } finally {
          active -= 1;
        }
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    queue.enqueue();
    firstRun.reject(new Error('first failed'));
    await waitForQueueIdle(queue);

    expect(runs).toBe(2);
    expect(maximumActive).toBe(1);
    expect(errors).toEqual(['first failed', 'second failed']);
    expect(queue.isRunning()).toBe(false);
  });
});

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return { promise, reject, resolve };
}

async function waitForQueueIdle(queue) {
  while (queue.isRunning()) await Promise.resolve();
}
