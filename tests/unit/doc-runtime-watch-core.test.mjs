import { describe, expect, it } from 'vitest';
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
    const queue = createSerialTaskQueue(
      async () => {
        if (shouldFail) {
          shouldFail = false;
          throw new Error('failed');
        }
      },
      { onError: (error) => errors.push(error.message) }
    );

    queue.enqueue();
    await Promise.resolve();
    await Promise.resolve();
    queue.enqueue();
    await Promise.resolve();

    expect(errors).toEqual(['failed']);
    expect(queue.isRunning()).toBe(false);
  });
});
