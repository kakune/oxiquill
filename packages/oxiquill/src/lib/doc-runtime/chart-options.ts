import type { ChartSpec } from './types.js';
import { normalizeHeatmapSpec } from './heatmap-normalization.js';
import { labelsForLanguage, type RuntimeLabels, type RuntimeLocale } from './runtime-localization.js';
import { chartCoordinateFormatter, chartCoordinates, chartNumberFormatter, numericBounds } from './chart-format.js';
import { categoryLabelLayout, chartHeight, chartLayout, truncateChartLabel } from './chart-layout.js';
import { chartPalette, heatmapPalette } from './chart-palette.js';

export type ChartTheme = 'light' | 'dark';
export type EChartsOptions = Record<string, unknown> & { series: readonly Record<string, unknown>[] };
export type ChartChrome = {
  axis: string;
  background: string;
  border: string;
  splitLine: string;
  text: string;
  tooltipBackground: string;
  fontFamily: string;
};

export function defaultChartChrome(theme: ChartTheme): ChartChrome {
  return theme === 'dark'
    ? {
        axis: '#d1d5db',
        background: '#181a1e',
        border: '#6b7280',
        splitLine: '#4b5563',
        text: '#f3f4f6',
        tooltipBackground: '#111827',
        fontFamily: 'system-ui, sans-serif'
      }
    : {
        axis: '#374151',
        background: '#fefefe',
        border: '#9ca3af',
        splitLine: '#d1d5db',
        text: '#111827',
        tooltipBackground: '#ffffff',
        fontFamily: 'system-ui, sans-serif'
      };
}

function showLegend(spec: ChartSpec): boolean {
  return spec.legend ?? ('series' in spec && spec.series.length > 1);
}

export function chartStructuralSignature(spec: ChartSpec): string {
  const categorical = ['bar', 'histogram', 'heatmap'].includes(spec.kind);
  return JSON.stringify([
    spec.kind,
    categorical ? 'category' : (spec.xType ?? 'value'),
    spec.kind === 'heatmap' ? 'category' : (spec.yType ?? 'value'),
    showLegend(spec),
    spec.tooltip !== false,
    spec.kind !== 'heatmap' && spec.dataZoom !== false
  ]);
}

function seriesNames(spec: ChartSpec, locale: RuntimeLocale): string[] {
  return 'series' in spec
    ? spec.series.map((series, index) =>
        series.name?.trim()
          ? series.name
          : spec.series.length > 1
            ? labelsForLanguage(locale).chartSeriesName(index + 1)
            : ''
      )
    : [''];
}

export function chartSpecToEChartsOptions(
  spec: ChartSpec,
  theme: ChartTheme = 'light',
  {
    reducedMotion = false,
    chrome = defaultChartChrome(theme),
    width = 720,
    height = chartHeight(spec),
    locale = 'en'
  }: { reducedMotion?: boolean; chrome?: ChartChrome; width?: number; height?: number; locale?: RuntimeLocale } = {}
): EChartsOptions {
  const style = spec.style;
  const palette = style?.palette?.[theme] ?? chartPalette;
  const legend = showLegend(spec);
  const layout = chartLayout(spec, width, height, legend);
  const values = chartCoordinates(spec);
  const names = seriesNames(spec, locale);
  const heatmap = spec.kind === 'heatmap' ? normalizeHeatmapSpec(spec) : undefined;
  const xType = ['bar', 'histogram', 'heatmap'].includes(spec.kind) ? 'category' : (spec.xType ?? 'value');
  const yType = spec.kind === 'heatmap' ? 'category' : (spec.yType ?? 'value');
  const xData = spec.kind === 'histogram' ? spec.bins.map((bin) => `${bin[0]}-${bin[1]}`) : values.x;
  const axis = (horizontal: boolean) => {
    const coordinates = horizontal ? xData : values.y;
    const type = horizontal ? xType : yType;
    return {
      type,
      name: horizontal ? spec.xLabel : spec.yLabel,
      nameLocation: 'middle',
      nameGap: horizontal ? 36 : 32,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: horizontal ? layout.plotWidth : layout.plotHeight, ellipsis: '…' },
      nameTextStyle: { color: chrome.text },
      ...(type === 'category' ? { data: coordinates } : {}),
      scale: horizontal || !['bar', 'histogram', 'area'].includes(spec.kind) || type !== 'value',
      axisLabel: {
        color: chrome.axis,
        hideOverlap: true,
        ...(type === 'category'
          ? categoryLabelLayout(
              coordinates.length,
              horizontal ? layout.plotWidth : layout.plotHeight,
              horizontal,
              width
            )
          : { formatter: chartCoordinateFormatter(coordinates, type, locale, true) })
      },
      axisPointer: {
        label: {
          formatter: ({ value }: { value: unknown }) => chartCoordinateFormatter(coordinates, type, locale)(value)
        }
      },
      axisLine: { show: false },
      axisTick: { show: false },
      splitLine: { show: style?.showGrid !== false, lineStyle: { color: chrome.splitLine, opacity: 0.45 } }
    };
  };
  const yBounds = numericBounds(values.y);
  const baseline = yType === 'value' && yBounds && yBounds.minimum < 0 && yBounds.maximum > 0;
  const animation = !reducedMotion && style?.animation !== false;
  const duration = animation ? (style?.animationDurationMs ?? 180) : 0;
  const options: EChartsOptions = {
    useUTC: true,
    animation,
    animationDuration: duration,
    animationDurationUpdate: duration,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    backgroundColor: 'transparent',
    color: palette,
    grid: layout.grid,
    textStyle: { color: chrome.text, fontFamily: chrome.fontFamily },
    xAxis: axis(true),
    yAxis: axis(false),
    tooltip:
      spec.tooltip === false
        ? undefined
        : {
            trigger: spec.kind === 'scatter' || heatmap ? 'item' : 'axis',
            confine: true,
            padding: [10, 12],
            borderWidth: 1,
            backgroundColor: chrome.tooltipBackground,
            borderColor: chrome.border,
            textStyle: { color: chrome.text, fontFamily: chrome.fontFamily },
            extraCssText: `border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.12);white-space:normal;overflow-wrap:anywhere;max-width:${Math.max(80, width - 40)}px;`,
            valueFormatter: chartNumberFormatter(values.y, locale),
            formatter: chartTooltipFormatter(spec, locale, names)
          },
    legend: legend
      ? {
          type: 'scroll',
          top: 8,
          left: 16,
          right: 16,
          height: 24,
          textStyle: { color: chrome.text },
          pageTextStyle: { color: chrome.text },
          pageIconColor: chrome.text,
          pageIconInactiveColor: chrome.border,
          tooltip: { show: true, confine: true },
          formatter: (name: string) => truncateChartLabel(name, Math.max(36, Math.min(220, width - 180)))
        }
      : undefined,
    dataZoom: spec.dataZoom === false || heatmap ? undefined : [{ type: 'inside' }],
    series: chartSeries(spec).map((item, index) => {
      const cycle = Math.floor(index / palette.length);
      return {
        ...item,
        id: spec.kind + ':' + index,
        name: names[index],
        ...(spec.kind === 'line' || spec.kind === 'area'
          ? {
              lineStyle: {
                ...(item.lineStyle as Record<string, unknown>),
                type: ['solid', 'dashed', 'dotted'][cycle % 3]
              }
            }
          : {}),
        ...(spec.kind === 'scatter'
          ? {
              symbol: ['circle', 'rect', 'triangle', 'diamond'][cycle % 4],
              itemStyle: { borderColor: chrome.tooltipBackground, borderWidth: 1 }
            }
          : {}),
        ...(heatmap ? { itemStyle: { borderColor: chrome.background, borderWidth: 1 } } : {}),
        markLine: {
          silent: true,
          animation: false,
          symbol: 'none',
          label: { show: false },
          lineStyle: { color: chrome.axis, width: 1.5, type: 'solid' },
          data: baseline && index === 0 ? [{ yAxis: 0 }] : []
        }
      };
    })
  };
  if (heatmap) {
    const range = numericBounds(values.value);
    options.visualMap = {
      calculable: true,
      ...layout.visualMap,
      min: range?.minimum ?? 0,
      max: range?.maximum ?? 1,
      formatter: chartNumberFormatter(values.value, locale),
      textStyle: { color: chrome.text },
      inRange: { color: style?.palette?.[theme] ?? heatmapPalette[theme] }
    };
  }
  return options;
}

function chartSeries(spec: ChartSpec): readonly Record<string, unknown>[] {
  switch (spec.kind) {
    case 'line':
    case 'area':
      return spec.series.map((series) => ({
        type: 'line',
        showSymbol: series.points.length === 1,
        lineStyle: { width: spec.style?.lineWidth ?? 2.25, cap: 'round', join: 'round' },
        data: series.points,
        ...(spec.kind === 'area' ? { areaStyle: { opacity: 0.14, origin: spec.yType === 'log' ? 'start' : 0 } } : {})
      }));
    case 'scatter':
      return spec.series.map((series) => ({
        type: 'scatter',
        symbolSize: spec.style?.symbolSize ?? 7,
        data: series.points
      }));
    case 'bar':
      return spec.series.map((series) => ({
        type: 'bar',
        barMaxWidth: 40,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        data: barData(series.values)
      }));
    case 'histogram':
      return [
        {
          type: 'bar',
          barMaxWidth: 40,
          barCategoryGap: '8%',
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          data: spec.bins.map((bin) => bin[2])
        }
      ];
    case 'heatmap':
      return [{ type: 'heatmap', data: normalizeHeatmapSpec(spec).data }];
    default:
      return [];
  }
}

function barData(values: readonly (number | null)[]) {
  if (!values.some((value) => value !== null && value < 0)) return values;
  return values.map((value) =>
    value !== null && value < 0 ? { value, itemStyle: { borderRadius: [0, 0, 3, 3] } } : value
  );
}

function chartTooltipFormatter(spec: ChartSpec, locale: RuntimeLocale, names: readonly string[]) {
  const values = chartCoordinates(spec);
  const xType = ['bar', 'histogram', 'heatmap'].includes(spec.kind) ? 'category' : spec.xType;
  const yType = spec.kind === 'heatmap' ? 'category' : spec.yType;
  const x = chartCoordinateFormatter(values.x, xType, locale);
  const y = chartCoordinateFormatter(values.y, yType, locale);
  const value = chartNumberFormatter(values.value, locale);
  const escape = (text: string) =>
    text.replace(
      /[&<>"']/gu,
      (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
    );
  return (input: unknown): string => {
    const parameters = Array.isArray(input) ? input : [input];
    return parameters
      .flatMap((parameter) => {
        if (!parameter || typeof parameter !== 'object') return [];
        const item = parameter as { value?: unknown; name?: string; seriesIndex?: number };
        const tuple = Array.isArray(item.value) ? item.value : undefined;
        const name = names[item.seriesIndex ?? 0];
        const details =
          spec.kind === 'heatmap' && tuple
            ? [x(tuple[0]) + ' / ' + y(tuple[1]), value(Number(tuple[2]))]
            : tuple
              ? [x(tuple[0]), y(tuple[1])]
              : [item.name ?? '', y(item.value)];
        return [[...(name ? [name] : []), ...details].map(escape).join(': ')];
      })
      .join('<br/>');
  };
}

export function chartDataSummary(spec: ChartSpec, labels: RuntimeLabels): string {
  const values = chartCoordinates(spec);
  const range = (coordinates: readonly unknown[], type: ChartSpec['xType']) => {
    if (type === 'category') return undefined;
    const bounds = numericBounds(
      type === 'time'
        ? coordinates.map((value) => (typeof value === 'number' ? value : Date.parse(String(value))))
        : coordinates
    );
    if (!bounds) return undefined;
    const format = chartCoordinateFormatter(coordinates, type, labels.locale);
    return bounds.minimum === bounds.maximum
      ? format(bounds.minimum)
      : format(bounds.minimum) + '–' + format(bounds.maximum);
  };
  const dataCount = spec.kind === 'heatmap' ? spec.data.length : values.y.length;
  const summary = labels.chartSummary({
    xLabel: spec.xLabel,
    yLabel: spec.yLabel,
    dataCount,
    seriesCount: 'series' in spec ? spec.series.length : 1,
    seriesNames: seriesNames(spec, labels.locale).filter(Boolean).join(', ').slice(0, 1000),
    xRange: range(values.x, spec.kind === 'bar' || spec.kind === 'heatmap' ? 'category' : spec.xType),
    yRange: range(values.y, spec.kind === 'heatmap' ? 'category' : spec.yType),
    ...(spec.kind === 'heatmap'
      ? { xCategoryCount: values.x.length, yCategoryCount: values.y.length, valueRange: range(values.value, 'value') }
      : {})
  });
  const text = dataCount === 0 ? [spec.xLabel, spec.yLabel, labels.noChartData].filter(Boolean).join('. ') : summary;
  return text;
}
