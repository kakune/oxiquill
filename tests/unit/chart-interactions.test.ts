import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachChartInteractions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-interactions';
import { chartZoomRange } from '../../packages/oxiquill/src/lib/doc-runtime/chart-viewport';
import type { EChartsInstance } from '../../packages/oxiquill/src/lib/doc-runtime/echarts-runtime';
import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const spec = (patch: Partial<Extract<ChartSpec, { kind: 'line' }>> = {}): ChartSpec => ({
  kind: 'line',
  link: { group: 'g' },
  series: [
    {
      points: [
        [0, 1],
        [100, 2]
      ]
    }
  ],
  ...patch
});

function harness() {
  const events = new Map<string, (params?: unknown) => void>();
  const zr = {
    on: vi.fn((event: string, callback: () => void) => events.set(event, callback)),
    off: vi.fn((event: string) => events.delete(event))
  };
  let range = [0, 100];
  const instance = {
    on: vi.fn((event: string, callback: () => void) => events.set(event, callback)),
    off: vi.fn((event: string) => events.delete(event)),
    getZr: () => zr,
    getHeight: () => 360,
    convertToPixel: vi.fn(() => 120),
    getModel: () => ({ getComponent: () => ({ getValueRange: () => range }) }),
    dispatchAction: vi.fn(
      (action: {
        type: string;
        startValue?: number;
        endValue?: number;
        dispatchAction?: (action: { type: string }) => void;
      }) => {
        if (action.type === 'dataZoom') {
          range = [action.startValue ?? 0, action.endValue ?? 100];
          // Deliberately emit even silent actions to exercise echo prevention.
          events.get('datazoom')?.();
        }
        if (action.type === 'updateAxisPointer') {
          events.get('updateAxisPointer')?.({ axesInfo: [{ axisDim: 'x', value: 40 }] });
          action.dispatchAction?.({ type: 'showTip' });
          action.dispatchAction?.({ type: 'hideTip' });
        }
      }
    )
  };
  const status = vi.fn(),
    changed = vi.fn();
  const controls = attachChartInteractions(
    instance as unknown as EChartsInstance,
    document.createElement('div'),
    status,
    changed
  );
  return { instance, status, changed, controls, events, zr, range: () => range };
}

afterEach(() => document.dispatchEvent(new Event('astro:before-swap')));

describe('ECharts interaction boundary', () => {
  it('propagates pointer zoom and keyboard actions without echoing or cloning options', () => {
    const a = harness(),
      b = harness();
    a.controls.update(spec());
    b.controls.update(spec());
    a.instance.dispatchAction({ type: 'dataZoom', startValue: 20, endValue: 80 });
    expect(b.range()).toEqual([20, 80]);
    expect(a.instance.dispatchAction).toHaveBeenCalledTimes(1);
    expect(b.instance.dispatchAction).toHaveBeenCalledTimes(1);
    expect(b.changed).toHaveBeenCalled();
    expect(a.controls.key('=')).toBe(true);
    expect(a.range()).toEqual([26, 74]);
    expect(b.range()).toEqual([26, 74]);
    a.controls.key('0');
    expect(a.range()).toEqual([0, 100]);
    expect(b.range()).toEqual([0, 100]);
    expect(a.controls.key('Escape')).toBe(false);
    a.controls.dispose();
    b.controls.dispose();
    expect(a.events.size).toBe(0);
    expect(b.events.size).toBe(0);
    expect(a.instance.off).toHaveBeenCalledTimes(2);
    expect(a.zr.off).toHaveBeenCalledExactlyOnceWith('globalout', expect.any(Function));
  });
  it('positions exact peer cursor values, suppresses tooltip creation, and handles pointer leave', () => {
    const a = harness(),
      b = harness();
    a.controls.update(spec());
    b.controls.update(spec());
    a.events.get('updateAxisPointer')?.({ axesInfo: [{ axisDim: 'x', value: 43 }] });
    expect(b.instance.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'updateAxisPointer',
        axesInfo: [{ axisDim: 'x', axisIndex: 0, value: 43 }],
        x: 120,
        y: 180,
        currTrigger: 'mousemove'
      }),
      { silent: true }
    );
    expect(b.instance.dispatchAction).not.toHaveBeenCalledWith({ type: 'showTip' }, expect.anything());
    expect(a.instance.dispatchAction).not.toHaveBeenCalled();
    a.events.get('globalout')?.();
    expect(b.instance.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'updateAxisPointer', currTrigger: 'leave' }),
      { silent: true }
    );
    a.events.get('updateAxisPointer')?.({ axesInfo: [{ axisDim: 'x', value: 200 }] });
    expect(b.instance.dispatchAction).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'updateAxisPointer', currTrigger: 'leave' }),
      { silent: true }
    );
    a.events.get('updateAxisPointer')?.();
    a.controls.dispose();
    b.controls.dispose();
  });
  it('updates memberships, detaches unlinked outputs, and cleans repeated mounts', () => {
    for (let index = 0; index < 3; index++) {
      const a = harness(),
        b = harness();
      a.controls.update(spec());
      b.controls.update(spec());
      a.controls.key('+');
      b.controls.update(spec({ link: undefined }));
      b.instance.dispatchAction.mockClear();
      a.controls.key('-');
      expect(b.instance.dispatchAction).not.toHaveBeenCalled();
      a.controls.update(spec({ dataZoom: false, link: undefined }));
      expect(a.controls.key('+')).toBe(false);
      a.controls.dispose();
      b.controls.dispose();
      expect(a.events.size + b.events.size).toBe(0);
    }
  });
  it('handles uninitialized, empty, and horizontal-category charts', () => {
    const a = harness();
    expect(a.controls.key('0')).toBe(false);
    a.controls.update(spec({ series: [], link: undefined }));
    expect(a.controls.key('+')).toBe(true);
    expect(a.instance.dispatchAction).not.toHaveBeenCalled();
    a.controls.update({ kind: 'bar', orientation: 'horizontal', categories: ['a', 'b', 'c'], series: [] });
    a.controls.key('ArrowLeft');
    expect(a.instance.dispatchAction).toHaveBeenCalledWith(expect.objectContaining({ type: 'dataZoom' }), {
      silent: true
    });
    a.controls.dispose();
  });
  it('reads dataZoom windows and safely falls back to axis scales', () => {
    expect(chartZoomRange({})).toBeUndefined();
    const axis = { scale: { getExtent: () => [1, 9], parse: Number } };
    expect(
      chartZoomRange({ getModel: () => ({ getComponent: () => ({ axis, getValueRange: () => ['-', '-'] }) }) })
    ).toEqual([1, 9]);
  });
});
