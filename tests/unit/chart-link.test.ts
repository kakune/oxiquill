import { describe, expect, it, vi } from 'vitest';
import {
  acquirePageChartLinks,
  chartLinkConflict,
  chartLinkIdentity,
  createChartLinkCoordinator,
  intersectChartRange,
  type ChartLinkMember
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-link';
import {
  chartDomain,
  chartNavigationAxis,
  chartZoomable,
  keyboardChartRange
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-navigation';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartFixtures } from '../fixtures/chart-specs';

const linked = (patch = {}) => ({ kind: 'chart', spec: { kind: 'line', link: { group: 'g' }, series: [], ...patch } });
const member = (patch: Partial<ChartLinkMember> = {}): ChartLinkMember => ({
  link: { group: 'g' },
  xType: 'value',
  domain: [0, 100],
  viewport: vi.fn(),
  cursor: vi.fn(),
  status: vi.fn(),
  ...patch
});

describe('link output validation', () => {
  it.each(['line', 'scatter', 'area', 'band', 'errorbar', 'xy'])('accepts %s and applies defaults', (kind) => {
    const spec = kind === 'xy' ? { kind, layers: [] } : { kind, series: [] };
    expect(validateOutputArtifacts([linked(spec)])[0]).toMatchObject({
      status: 'valid',
      artifact: { spec: { link: { group: 'g', zoom: true, cursor: true } } }
    });
  });
  it.each(['', 'x'.repeat(65), 'bad name', '日本語', 'a.b', 'a\n', 1, null])('rejects group %j locally', (group) => {
    const results = validateOutputArtifacts([
      linked({ link: { group } }),
      { kind: 'text', stream: 'stdout', content: 'ok' }
    ]);
    expect(results[0]).toMatchObject({ status: 'error', index: 0, message: expect.stringContaining('group') });
    expect(results[1].status).toBe('valid');
  });
  it.each([null, [], { group: 'g', zoom: 1 }, { group: 'g', cursor: 'yes' }, { group: 'g', other: true }])(
    'rejects malformed link %j',
    (link) => {
      expect(validateOutputArtifacts([linked({ link })])[0].status).toBe('error');
    }
  );
  it('accepts bounded ASCII names and explicit opt-outs', () => {
    expect(
      validateOutputArtifacts([linked({ link: { group: 'Ab_9-'.repeat(12), zoom: false, cursor: false } })])[0]
    ).toMatchObject({ status: 'valid', artifact: { spec: { link: { zoom: false, cursor: false } } } });
  });
  it.each([{ xType: 'category' }, { dataZoom: false }, { kind: 'bar', categories: [] }, { kind: 'heatmap', data: [] }])(
    'rejects ineligible charts %j',
    (patch) => {
      expect(validateOutputArtifacts([linked(patch)])[0]).toMatchObject({
        status: 'error',
        message: expect.stringContaining('link')
      });
    }
  );
  it('defers compatibility to page registration so an invalid member cannot reject healthy siblings', () => {
    const results = validateOutputArtifacts([
      linked(),
      linked({ style: { xFormat: { unit: 's' } } }),
      linked({ style: { xFormat: { unit: 'm' } } }),
      linked({ xType: 'time' }),
      linked({ link: { group: 'other' }, xType: 'log' })
    ]);
    expect(results.every(({ status }) => status === 'valid')).toBe(true);
  });
  it('never infers units from labels', () => {
    expect(
      validateOutputArtifacts([linked({ xLabel: 'seconds' }), linked({ xLabel: 'meters' })]).every(
        ({ status }) => status === 'valid'
      )
    ).toBe(true);
  });
});

describe('page coordinator', () => {
  it('intersects domain ranges, retains disjoint peers, isolates groups, and resets independently', () => {
    const coordinator = createChartLinkCoordinator();
    const source = {};
    const overlap = member({ domain: [50, 150] });
    const disjoint = member({ domain: [200, 300] });
    const other = member({ link: { group: 'other' } });
    coordinator.register(source, member());
    coordinator.register({}, overlap);
    coordinator.register({}, disjoint);
    coordinator.register({}, other);
    coordinator.viewport(source, [20, 80]);
    expect(overlap.viewport).toHaveBeenCalledExactlyOnceWith([50, 80]);
    expect(disjoint.viewport).not.toHaveBeenCalled();
    expect(disjoint.status).toHaveBeenLastCalledWith(true);
    expect(other.viewport).not.toHaveBeenCalled();
    coordinator.viewport(source);
    expect(overlap.viewport).toHaveBeenLastCalledWith(undefined);
    expect(disjoint.viewport).toHaveBeenLastCalledWith(undefined);
    expect(disjoint.status).toHaveBeenLastCalledWith(false);
  });
  it('keeps the group range for late joins and stable reactive membership, then forgets empty groups', () => {
    const coordinator = createChartLinkCoordinator();
    const source = {};
    coordinator.register(source, member());
    coordinator.viewport(source, [20, 40]);
    const late = member();
    const identity = {};
    coordinator.register(identity, late);
    expect(late.viewport).toHaveBeenCalledExactlyOnceWith([20, 40]);
    coordinator.register(identity, late);
    expect(late.viewport).toHaveBeenCalledTimes(1);
    expect(coordinator.size).toBe(2);
    coordinator.unregister(source);
    coordinator.unregister(identity);
    coordinator.register({}, late);
    expect(late.viewport).toHaveBeenCalledTimes(1);
    coordinator.clear();
    expect(coordinator.size).toBe(0);
  });
  it('prevents echoes, even if callbacks emit synchronously', () => {
    const coordinator = createChartLinkCoordinator();
    const a = {},
      b = {};
    const first = member();
    const second = member({
      viewport: (range) => coordinator.viewport(b, range),
      cursor: (x) => coordinator.cursor(b, x)
    });
    coordinator.register(a, first);
    coordinator.register(b, second);
    coordinator.viewport(a, [1, 2]);
    coordinator.cursor(a, 1.5);
    expect(first.viewport).not.toHaveBeenCalled();
    expect(first.cursor).not.toHaveBeenCalled();
    coordinator.unregister(b);
    coordinator.viewport(b, [3, 4]);
    coordinator.cursor(b, 2);
  });
  it('clears remote cursors when their source unmounts without hiding another member’s cursor', () => {
    const coordinator = createChartLinkCoordinator();
    const a = {},
      b = {},
      c = {};
    const first = member(),
      second = member(),
      third = member();
    coordinator.register(a, first);
    coordinator.register(b, second);
    coordinator.register(c, third);
    coordinator.cursor(a, 43);
    coordinator.unregister(c);
    expect(second.cursor).toHaveBeenCalledExactlyOnceWith(43);
    coordinator.cursor(b, 52);
    coordinator.cursor(a);
    expect(first.cursor).toHaveBeenCalledExactlyOnceWith(52);
    coordinator.unregister(b);
    expect(first.cursor).toHaveBeenLastCalledWith(undefined);
  });
  it('honors independent sending and receiving opt-outs and propagates cursor leave', () => {
    const coordinator = createChartLinkCoordinator();
    const a = {},
      b = {},
      c = {};
    const zoom = member({ link: { group: 'g', cursor: false } });
    const cursor = member({ link: { group: 'g', zoom: false } });
    const both = member();
    coordinator.register(a, zoom);
    coordinator.register(b, cursor);
    coordinator.register(c, both);
    coordinator.viewport(a, [1, 2]);
    expect(cursor.viewport).not.toHaveBeenCalled();
    coordinator.viewport(b, [3, 4]);
    expect(zoom.viewport).not.toHaveBeenCalled();
    coordinator.cursor(b, 1.5);
    expect(both.cursor).toHaveBeenLastCalledWith(1.5);
    expect(zoom.cursor).not.toHaveBeenCalled();
    coordinator.cursor(a, 2);
    expect(cursor.cursor).not.toHaveBeenCalled();
    coordinator.cursor(b);
    expect(both.cursor).toHaveBeenLastCalledWith(undefined);
  });
  it('validates live members, including metadata updates and group changes', () => {
    const coordinator = createChartLinkCoordinator();
    const a = {},
      b = {};
    coordinator.register(a, member({ unit: 's' }));
    expect(() => coordinator.register(b, member({ xType: 'time' }))).toThrow('xType');
    expect(() => coordinator.register(b, member({ unit: 'm' }))).toThrow('unit');
    coordinator.register(b, member({ unit: 's' }));
    expect(() => coordinator.register(b, member({ unit: 'm' }))).toThrow('unit');
    coordinator.register(b, member({ link: { group: 'other' }, unit: 'm' }));
    expect(coordinator.size).toBe(2);
  });
  it('checks all explicit units even when the first member has no unit', () => {
    const coordinator = createChartLinkCoordinator();
    coordinator.register({}, member());
    coordinator.register({}, member({ unit: 's' }));
    expect(() => coordinator.register({}, member({ unit: 'm' }))).toThrow('unit');
    expect(coordinator.size).toBe(2);
  });
  it('releases navigation listeners and isolates new page instances from delayed old cleanup', () => {
    const add = vi.spyOn(document, 'addEventListener');
    const remove = vi.spyOn(document, 'removeEventListener');
    const a = acquirePageChartLinks(document),
      b = acquirePageChartLinks(document);
    expect(a.coordinator).toBe(b.coordinator);
    a.coordinator.register({}, member());
    a.release();
    a.release();
    expect(b.coordinator.size).toBe(1);
    document.dispatchEvent(new Event('astro:before-swap'));
    expect(b.coordinator.size).toBe(0);
    const next = acquirePageChartLinks(document);
    expect(next.coordinator).not.toBe(b.coordinator);
    b.release();
    const nextPeer = acquirePageChartLinks(document);
    expect(nextPeer.coordinator).toBe(next.coordinator);
    // Release both references acquired for the replacement page.
    next.release();
    nextPeer.release();
    expect(add.mock.calls.filter(([event]) => event === 'astro:before-swap')).toHaveLength(2);
    expect(remove.mock.calls.filter(([event]) => event === 'astro:before-swap')).toHaveLength(2);
    add.mockRestore();
    remove.mockRestore();
  });
  it('isolates distinct documents and releases the last page owner', () => {
    const first = acquirePageChartLinks(document);
    const second = acquirePageChartLinks(document.implementation.createHTMLDocument());
    expect(first.coordinator).not.toBe(second.coordinator);
    first.release();
    second.release();
    const next = acquirePageChartLinks(document);
    expect(next.coordinator).not.toBe(first.coordinator);
    next.release();
  });
});

describe('pure viewport calculations', () => {
  it('handles exact contact, empty domains, and disjoint ranges', () => {
    expect(intersectChartRange([0, 10], [10, 20])).toEqual([10, 10]);
    expect(intersectChartRange([0, 10], undefined)).toBeUndefined();
    expect(intersectChartRange([0, 10], [11, 20])).toBeUndefined();
    expect(chartLinkIdentity({ kind: 'line', series: [] })).toBeUndefined();
    expect(chartLinkConflict(member(), [member({ link: { group: 'other' }, xType: 'time' })])).toBeUndefined();
  });
  it('derives numeric, time, log, category, authored, and empty domains', () => {
    expect(
      chartDomain({
        kind: 'line',
        series: [
          {
            points: [
              [10, 1],
              [20, 2]
            ]
          }
        ]
      })
    ).toEqual([10, 20]);
    expect(
      chartDomain({ kind: 'line', xType: 'time', xMin: 0, series: [{ points: [['2026-01-01T00:00:00Z', 1]] }] })
    ).toEqual([0, Date.parse('2026-01-01T00:00:00Z')]);
    expect(
      chartDomain({
        kind: 'line',
        xType: 'log',
        series: [
          {
            points: [
              [1, 1],
              [100, 1]
            ]
          }
        ]
      })
    ).toEqual([1, 100]);
    expect(
      chartDomain({
        kind: 'line',
        xIncludeZero: true,
        series: [
          {
            points: [
              [10, 1],
              [20, 2]
            ]
          }
        ]
      })
    ).toEqual([0, 20]);
    expect(chartDomain({ kind: 'line', xMin: 2, xMax: 8, series: [] })).toEqual([2, 8]);
    expect(chartDomain({ kind: 'line', series: [] })).toBeUndefined();
    expect(chartDomain({ kind: 'bar', categories: ['a', 'b', 'a'], series: [] })).toEqual([0, 2]);
    expect(chartDomain({ kind: 'bar', categories: [], series: [] })).toBeUndefined();
    expect(
      chartDomain(
        {
          kind: 'area',
          series: [
            {
              points: [
                [0, -2],
                [1, -1]
              ]
            }
          ]
        },
        'y'
      )
    ).toEqual([-2, 0]);
  });
  it.each([
    ['+', [0, 100], [10, 90]],
    ['=', [0, 100], [10, 90]],
    ['-', [10, 90], [0, 100]],
    ['ArrowLeft', [20, 80], [14, 74]],
    ['ArrowRight', [20, 80], [26, 86]],
    ['ArrowRight', [40, 100], [40, 100]]
  ] as const)('computes %s navigation', (key, visible, expected) => {
    expect(keyboardChartRange(key, visible, [0, 100], 'value')).toEqual(expected);
  });
  it('uses logarithmic scale space and stable category steps', () => {
    const range = keyboardChartRange('+', [1, 100], [1, 100], 'log');
    expect(range?.[0]).toBeCloseTo(10 ** 0.2);
    expect(range?.[1]).toBeCloseTo(10 ** 1.8);
    expect(keyboardChartRange('+', [0, 9], [0, 9], 'category')).toEqual([1, 8]);
    expect(keyboardChartRange('+', [0, 1], [0, 1], 'category')).toEqual([0, 1]);
    expect(keyboardChartRange('ArrowRight', [1, 3], [0, 5], 'category')).toEqual([2, 4]);
    expect(keyboardChartRange('+', [0, 1], [0, 1], 'log')).toBeUndefined();
    expect(keyboardChartRange('+', [1, 1], [1, 1], 'value')).toBeUndefined();
    expect(keyboardChartRange('Escape', [0, 1], [0, 1], 'value')).toBeUndefined();
    expect(keyboardChartRange('+', [-1e308, 1e308], [-1e308, 1e308], 'value')).toBeUndefined();
  });
  it('recognizes existing zoom axes without adding zoom to disabled charts', () => {
    Object.values(chartFixtures).forEach((spec) =>
      expect(chartZoomable(spec)).toBe(spec.kind !== 'heatmap' && spec.dataZoom !== false)
    );
    expect(chartNavigationAxis({ kind: 'bar', orientation: 'horizontal', categories: [], series: [] })).toBe('y');
    expect(chartNavigationAxis({ kind: 'line', series: [] })).toBe('x');
  });
});
