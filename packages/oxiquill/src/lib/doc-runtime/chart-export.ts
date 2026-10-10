import { loadECharts, type EChartsInstance } from './echarts-runtime.js';
import { chartSpecToEChartsOptions, type ChartChrome, type ChartTheme, type EChartsOptions } from './chart-options.js';
import type { ChartSpec } from './types.js';
import type { RuntimeLocale } from './runtime-localization.js';

export interface ChartViewState {
  dataZoom?: { start?: number; end?: number; startValue?: number | string; endValue?: number | string }[];
  legend?: { selected?: Record<string, boolean>; scrollDataIndex?: number }[];
  visualMap?: { range?: number[] }[];
  symbols?: Record<string, boolean>;
}

export function chartViewState(instance: EChartsInstance): ChartViewState {
  const options = instance.getOption() as ChartViewState & { series?: { id: string; showSymbol?: boolean }[] };
  return {
    dataZoom: options.dataZoom?.map(({ start, end, startValue, endValue }) => ({ start, end, startValue, endValue })),
    legend: options.legend?.map(({ selected, scrollDataIndex }) => ({ selected: { ...selected }, scrollDataIndex })),
    visualMap: options.visualMap?.map(({ range }) => ({ ...(range ? { range: [...range] } : {}) })),
    symbols: Object.fromEntries(
      options.series?.flatMap(({ id, showSymbol }) => (typeof showSymbol === 'boolean' ? [[id, showSymbol]] : [])) ?? []
    )
  };
}

export function applyChartViewState(options: EChartsOptions, state: ChartViewState): void {
  if (state.symbols)
    options.series = options.series.map((series) =>
      typeof series.id === 'string' && Object.hasOwn(state.symbols ?? {}, series.id)
        ? { ...series, showSymbol: state.symbols?.[series.id] }
        : series
    );
  if (options.dataZoom && state.dataZoom) {
    const zoom = options.dataZoom as Record<string, unknown>[];
    options.dataZoom = zoom.map((item, index) => ({ ...item, ...state.dataZoom?.[index] }));
  }
  if (options.legend && state.legend?.[0]) options.legend = { ...options.legend, ...state.legend[0] };
  if (options.visualMap && state.visualMap?.[0]) options.visualMap = { ...options.visualMap, ...state.visualMap[0] };
}

export async function exportChartImage({
  spec,
  theme,
  chrome,
  locale,
  width,
  height,
  state,
  format
}: {
  spec: ChartSpec;
  theme: ChartTheme;
  chrome: ChartChrome;
  locale: RuntimeLocale;
  width: number;
  height: number;
  state: ChartViewState;
  format: 'png' | 'svg';
}): Promise<Blob> {
  const echarts = await loadECharts();
  const container = document.createElement('div');
  const instance = echarts.init(container, undefined, {
    renderer: format === 'svg' ? 'svg' : 'canvas',
    width,
    height,
    ssr: format === 'svg'
  });
  try {
    const options = chartSpecToEChartsOptions(spec, theme, { width, height, chrome, locale, reducedMotion: true });
    options.backgroundColor = chrome.background;
    options.series = options.series.map((series) => ({ ...series, progressive: 0 }));
    applyChartViewState(options, state);
    instance.setOption(options, { notMerge: true });
    if (format === 'svg') return new Blob([instance.renderToSVGString()], { type: 'image/svg+xml;charset=utf-8' });
    const canvas = instance.renderToCanvas({ pixelRatio: 2, backgroundColor: chrome.background });
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Unable to encode chart PNG.'))), 'image/png');
    });
  } finally {
    instance.dispose();
    container.remove();
  }
}
