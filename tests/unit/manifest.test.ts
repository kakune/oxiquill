import { beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeEach(() => {
  document.body.replaceChildren();
  applyGeneratedSnapshot({ cells: [], version: 'test-runtime-version' });
  vi.restoreAllMocks();
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

    await refreshGeneratedManifest({ fetchImpl, hasHotRuntime: true, now: () => 123, windowObject: window });

    expect(fetchImpl).toHaveBeenCalledWith(expect.stringMatching(/oxiquill-fresh=123-\d+$/u), {
      cache: 'no-store'
    });
    expect(getManifestSnapshot()).toEqual({ cells: [firstCell], version: 'fresh-version' });

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refreshGeneratedManifest({
      fetchImpl: vi.fn(async () => new Response('', { status: 503 })),
      hasHotRuntime: true,
      windowObject: window
    });
    expect(warning).toHaveBeenCalledWith(
      'Oxiquill could not refresh the generated interactive cell manifest.',
      expect.objectContaining({ message: expect.stringContaining('503') })
    );
  });

  it('ignores unavailable hot runtimes and transient network errors', async () => {
    const fetchImpl = vi.fn();
    await refreshGeneratedManifest({ fetchImpl, hasHotRuntime: false, windowObject: window });
    expect(fetchImpl).not.toHaveBeenCalled();

    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await refreshGeneratedManifest({
      fetchImpl: vi.fn(async () => {
        throw new TypeError('network changed during HMR');
      }),
      hasHotRuntime: true,
      windowObject: window
    });
    expect(warning).not.toHaveBeenCalled();
  });

  it('schedules bounded refresh attempts and skips missing documents', () => {
    const refresh = vi.fn(async () => undefined);
    const setTimeout = vi.fn((callback: TimerHandler, delay?: number) => {
      void delay;
      if (typeof callback === 'function') callback();
      return 1;
    });

    scheduleGeneratedManifestRefresh({
      refresh,
      windowObject: { setTimeout } as unknown as Window
    });

    expect(setTimeout.mock.calls.map(([, delay]) => delay)).toEqual([0, 250, 1_000, 2_500, 5_000]);
    expect(refresh).toHaveBeenCalledTimes(5);
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
