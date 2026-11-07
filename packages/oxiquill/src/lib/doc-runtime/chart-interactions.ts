import { chartAxisType } from './chart-axes.js';
import { acquirePageChartLinks, chartLinkIdentity, type ChartRange } from './chart-link.js';
import { chartDomain, chartNavigationAxis, chartZoomable, keyboardChartRange } from './chart-navigation.js';
import { chartZoomRange } from './chart-viewport.js';
import type { EChartsInstance } from './echarts-runtime.js';
import type { ChartSpec } from './types.js';

/** ECharts effects live here; the coordinator only knows domain values and callbacks. */
export function attachChartInteractions(
  instance: EChartsInstance,
  element: HTMLElement,
  status: (disjoint: boolean) => void,
  changed: () => void = () => {}
) {
  const identity = {};
  let spec: ChartSpec | undefined;
  let domain: ChartRange | undefined;
  let page: ReturnType<typeof acquirePageChartLinks> | undefined;
  let applying = false;

  function silently(action: Record<string, unknown> & { type: string }) {
    applying = true;
    try {
      instance.dispatchAction(action, { silent: true });
      if (action.type === 'dataZoom') changed();
    } finally {
      applying = false;
    }
  }

  function viewport(range: ChartRange | undefined) {
    silently(
      range
        ? { type: 'dataZoom', dataZoomIndex: 0, startValue: range[0], endValue: range[1] }
        : { type: 'dataZoom', start: 0, end: 100 }
    );
  }

  function cursor(value: number | undefined) {
    const range = chartZoomRange(instance);
    const visible = value !== undefined && range && value >= range[0] && value <= range[1];
    // ECharts requires a point inside this peer's grid even when axesInfo supplies a value.
    const x = visible ? instance.convertToPixel({ xAxisIndex: 0 }, value) : 0;
    silently({
      type: 'updateAxisPointer',
      currTrigger: visible ? 'mousemove' : 'leave',
      x,
      y: instance.getHeight() / 2,
      axesInfo: [{ axisDim: 'x', axisIndex: 0, value }],
      // Remote pointers must never create a tooltip. Local pointer behavior remains intact.
      dispatchAction: (action: { type: string }) => {
        if (action.type !== 'showTip') instance.dispatchAction(action, { silent: true });
      }
    });
    silently({ type: 'hideTip' });
  }

  function zoomed() {
    if (applying || !spec) return;
    changed();
    status(false);
    const range = chartZoomRange(instance);
    if (range) page?.coordinator.viewport(identity, range);
  }

  function pointed(params: unknown) {
    if (applying) return;
    const axes = (params as { axesInfo?: { axisDim: string; value: number }[] } | undefined)?.axesInfo;
    const x = axes?.find((axis) => axis.axisDim === 'x')?.value;
    page?.coordinator.cursor(identity, typeof x === 'number' && Number.isFinite(x) ? x : undefined);
  }

  function leave() {
    if (!applying) page?.coordinator.cursor(identity);
  }

  instance.on('datazoom', zoomed);
  instance.on('updateAxisPointer', pointed);
  instance.getZr().on('globalout', leave);

  function reset() {
    viewport(undefined);
    status(false);
    page?.coordinator.viewport(identity);
  }

  return {
    update(next: ChartSpec) {
      if (next !== spec) domain = chartZoomable(next) ? chartDomain(next, chartNavigationAxis(next)) : undefined;
      spec = next;
      const link = chartLinkIdentity(next);
      if (!link) {
        page?.coordinator.unregister(identity);
        page?.release();
        page = undefined;
        status(false);
        return;
      }
      page ??= acquirePageChartLinks(element.ownerDocument);
      page.coordinator.register(identity, { ...link, domain, viewport, cursor, status });
    },
    reset,
    key(key: string): boolean {
      if (!spec || !chartZoomable(spec)) return false;
      if (key === '0') {
        reset();
        return true;
      }
      if (!['+', '=', '-', 'ArrowLeft', 'ArrowRight'].includes(key)) return false;
      const axis = chartNavigationAxis(spec);
      const visible = chartZoomRange(instance, axis);
      const range = domain && visible && keyboardChartRange(key, visible, domain, chartAxisType(spec, axis));
      if (range) {
        silently({ type: 'dataZoom', dataZoomIndex: 0, startValue: range[0], endValue: range[1] });
        status(false);
        page?.coordinator.viewport(identity, range);
      }
      return true;
    },
    dispose() {
      page?.coordinator.unregister(identity);
      page?.release();
      page = undefined;
      instance.off('datazoom', zoomed);
      instance.off('updateAxisPointer', pointed);
      instance.getZr().off('globalout', leave);
    }
  };
}
