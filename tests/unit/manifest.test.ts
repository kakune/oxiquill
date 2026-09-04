import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyCellsSnapshot,
  applyGeneratedSnapshot,
  applyRuntimeVersionSnapshot,
  freshManifestUrl,
  getCell,
  getManifestSnapshot,
  refreshGeneratedManifest,
  scheduleGeneratedManifestRefresh,
  subscribeManifest,
  syncRenderedSourceBlocks
} from '../../packages/oxiquill/src/lib/doc-runtime/manifest';
import type { CellManifest } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const firstCell = makeCell('first', '<pre>first</pre>');
const secondCell = makeCell('second', '<pre>second</pre>');
let disposeRefresh: (() => void) | undefined;

beforeEach(() => {
  document.body.replaceChildren();
  applyGeneratedSnapshot({ cells: [], version: 'test-runtime-version' });
  vi.restoreAllMocks();
});

afterEach(() => {
  disposeRefresh?.();
  disposeRefresh = undefined;
  vi.useRealTimers();
});

describe('generated manifest state', () => {
  it('tracks cells, versions, subscriptions, and rendered source blocks', () => {
    document.body.innerHTML = [
      '<div class="doc-cell" data-cell-id="first">',
      '  <div data-testid="cell-source">stale</div>',
      '</div>'
    ].join('');
    const listener = vi.fn();
    const unsubscribe = subscribeManifest(listener);

    applyCellsSnapshot([firstCell]);
    expect(getCell('first')).toBe(firstCell);
    expect(getCell('missing')).toBeUndefined();
    expect(getManifestSnapshot()).toEqual({ cells: [firstCell], version: 'test-runtime-version' });
    expect(document.querySelector('[data-testid="cell-source"]')?.innerHTML).toBe(firstCell.sourceHtml);
    expect(listener).toHaveBeenCalledTimes(1);

    applyCellsSnapshot(getManifestSnapshot().cells);
    applyRuntimeVersionSnapshot('test-runtime-version');
    expect(listener).toHaveBeenCalledTimes(1);

    applyRuntimeVersionSnapshot('next-runtime-version');
    expect(getManifestSnapshot().version).toBe('next-runtime-version');
    expect(listener).toHaveBeenCalledTimes(2);

    unsubscribe();
    applyGeneratedSnapshot({ cells: [secondCell], version: 'final-runtime-version' });
    expect(listener).toHaveBeenCalledTimes(2);
    expect(getManifestSnapshot()).toEqual({ cells: [secondCell], version: 'final-runtime-version' });
  });

  it('refreshes changed snapshots and reports actionable server errors', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ cells: [firstCell], runtimeVersion: 'fresh-version' }), {
          headers: { 'content-type': 'application/json' },
          status: 200
        })
    );

    await expect(
      refreshGeneratedManifest({ fetchImpl, hasHotRuntime: true, now: () => 123, windowObject: window })
    ).resolves.toEqual({
      snapshot: { cells: [firstCell], version: 'fresh-version' },
      status: 'success'
    });

    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/oxiquill-fresh=123-\d+$/u), {
      cache: 'no-store'
    });

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      refreshGeneratedManifest({
        fetchImpl: vi.fn(async () => new Response('', { status: 503 })),
        hasHotRuntime: true,
        windowObject: window
      })
    ).resolves.toEqual({ status: 'failure' });
    expect(warning).toHaveBeenCalledWith(
      'Oxiquill could not refresh the generated interactive cell manifest.',
      expect.objectContaining({ message: expect.stringContaining('503') })
    );
  });

  it('ignores unavailable hot runtimes and transient network errors', async () => {
    const fetchImpl = vi.fn();
    await expect(refreshGeneratedManifest({ fetchImpl, hasHotRuntime: false, windowObject: window })).resolves.toEqual({
      status: 'failure'
    });
    expect(fetchImpl).not.toHaveBeenCalled();

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(
      refreshGeneratedManifest({
        fetchImpl: vi.fn(async () => {
          throw new TypeError('network changed during HMR');
        }),
        hasHotRuntime: true,
        windowObject: window
      })
    ).resolves.toEqual({ status: 'failure' });
    expect(warning).not.toHaveBeenCalled();
  });

  it('coalesces many refresh triggers into one shared successful retry stream', async () => {
    vi.useFakeTimers();
    const setTimeout = vi.spyOn(window, 'setTimeout');
    const refresh = vi.fn(async () => successfulRefresh([firstCell], 'shared-version'));

    for (let index = 0; index < 24; index += 1) {
      disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    }

    expect(vi.getTimerCount()).toBe(5);
    expect(setTimeout.mock.calls.slice(-5).map(([, delay]) => delay)).toEqual([0, 250, 1_000, 2_500, 5_000]);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(getManifestSnapshot()).toEqual({ cells: [firstCell], version: 'shared-version' });

    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('aborts obsolete generations and rejects their late responses', async () => {
    vi.useFakeTimers();
    const obsolete = createDeferred<TestManifestRefreshResult>();
    const current = createDeferred<TestManifestRefreshResult>();
    const refresh = vi
      .fn<TestManifestRefresh>()
      .mockImplementationOnce(() => obsolete.promise)
      .mockImplementationOnce(() => current.promise);

    disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    await vi.advanceTimersByTimeAsync(0);
    const obsoleteSignal = refresh.mock.calls[0]?.[0]?.signal;

    scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    expect(obsoleteSignal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(5);

    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(2);

    current.resolve(successfulRefresh([secondCell], 'current-version'));
    await flushMicrotasks();
    expect(getManifestSnapshot()).toEqual({ cells: [secondCell], version: 'current-version' });

    obsolete.resolve(successfulRefresh([firstCell], 'obsolete-version'));
    await flushMicrotasks();
    expect(getManifestSnapshot()).toEqual({ cells: [secondCell], version: 'current-version' });
  });

  it('runs one attempt at a time within a generation and coalesces elapsed retries', async () => {
    vi.useFakeTimers();
    const firstAttempt = createDeferred<TestManifestRefreshResult>();
    const secondAttempt = createDeferred<TestManifestRefreshResult>();
    const refresh = vi
      .fn<TestManifestRefresh>()
      .mockImplementationOnce(() => firstAttempt.promise)
      .mockImplementationOnce(() => secondAttempt.promise);

    disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refresh).toHaveBeenCalledOnce();

    firstAttempt.resolve({ status: 'failure' });
    await flushMicrotasks();
    expect(refresh).toHaveBeenCalledTimes(2);

    secondAttempt.resolve(successfulRefresh([firstCell], 'retry-version'));
    await flushMicrotasks();
    expect(getManifestSnapshot()).toEqual({ cells: [firstCell], version: 'retry-version' });
  });

  it('retries a failed attempt at the next delay and cancels later retries after success', async () => {
    vi.useFakeTimers();
    const listener = vi.fn();
    const unsubscribe = subscribeManifest(listener);
    const refresh = vi
      .fn<TestManifestRefresh>()
      .mockResolvedValueOnce({ status: 'failure' })
      .mockResolvedValueOnce(successfulRefresh([firstCell], 'recovered-version'));

    disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledOnce();
    expect(listener).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(250);
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenCalledOnce();

    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledTimes(2);
    unsubscribe();
  });

  it('clears pending retries and aborts in-flight work when disposed', async () => {
    vi.useFakeTimers();
    const attempt = createDeferred<TestManifestRefreshResult>();
    const refresh = vi.fn<TestManifestRefresh>(() => attempt.promise);

    disposeRefresh = scheduleGeneratedManifestRefresh({ refresh, windowObject: window });
    await vi.advanceTimersByTimeAsync(0);
    const signal = refresh.mock.calls[0]?.[0]?.signal;

    disposeRefresh();
    expect(signal?.aborted).toBe(true);
    await vi.runAllTimersAsync();
    expect(refresh).toHaveBeenCalledOnce();

    attempt.resolve(successfulRefresh([firstCell], 'disposed-version'));
    await flushMicrotasks();
    expect(getManifestSnapshot()).toEqual({ cells: [], version: 'test-runtime-version' });
  });

  it('skips missing documents when synchronizing rendered source blocks', () => {
    expect(() => syncRenderedSourceBlocks(undefined)).not.toThrow();
    expect(freshManifestUrl(() => 456)).toMatch(/oxiquill-fresh=456-\d+$/u);
  });
});

function makeCell(id: string, sourceHtml: string): CellManifest {
  return {
    id,
    crates: [],
    inputs: [],
    language: 'rust',
    packages: [],
    pagePath: 'page.mdx',
    run: 'button',
    showSource: true,
    source: 'println!("ok");',
    sourceHtml,
    timeoutMs: 1_000,
    title: id
  };
}

type TestManifestRefreshResult = ReturnType<typeof successfulRefresh> | { status: 'failure' };
type TestManifestRefresh = (options?: { signal?: AbortSignal }) => Promise<TestManifestRefreshResult>;

function successfulRefresh(cells: readonly CellManifest[], version: string) {
  return {
    snapshot: { cells, version },
    status: 'success' as const
  };
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });

  return { promise, resolve };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
