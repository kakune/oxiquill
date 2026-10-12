import { fieldSeries } from './chart-field.js';
import { bubbleSizeMapping } from './chart-bubble.js';
import { heatmapColorScale } from './chart-color-scale.js';
import { chartAnnotationSeries, annotationDescription } from './chart-annotations.js';
import { intervalSeries } from './chart-intervals.js';
import { histogramLabel, histogramSeries } from './chart-histogram.js';
import { chartAxisType, chartIncludesZero } from './chart-axes.js';
import type { ChartSpec, ChartNumberFormat } from './types.js';
import { normalizeHeatmapSpec } from './heatmap-normalization.js';
import { labelsForLanguage, type RuntimeLabels, type RuntimeLocale } from './runtime-localization.js';
import { chartCoordinateFormatter, chartCoordinates, chartNumberFormatter, numericBounds } from './chart-format.js';
import {
  categoryLabelLayout,
  chartHeight,
  chartLayout,
  truncateChartLabel,
  hasChartColorScale
} from './chart-layout.js';
import { chartPalette, heatmapPalette, divergingPalette } from './chart-palette.js';

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

export function showLegend(spec: ChartSpec): boolean {
  return spec.legend ?? ('series' in spec && spec.series.length > 1);
}

export function chartSeriesPresentation(spec: ChartSpec, index: number, theme: ChartTheme) {
  const palette = spec.style?.palette?.[theme] ?? chartPalette;
  const cycle = Math.floor(index / palette.length);
  const authored = 'series' in spec ? spec.series[index].style : undefined;
  const line = spec.kind === 'line' || spec.kind === 'area' ? spec.series[index].style : undefined;
  return {
    color:
      (typeof authored?.color === 'string' ? authored.color : authored?.color?.[theme]) ??
      palette[index % palette.length],
    lineType: line?.lineType ?? (['solid', 'dashed', 'dotted'] as const)[cycle % 3],
    symbol:
      spec.kind === 'scatter' || spec.kind === 'bubble'
        ? (spec.series[index].style?.symbol ?? (['circle', 'rect', 'triangle', 'diamond'] as const)[cycle % 4])
        : (line?.symbol ?? 'emptyCircle')
  };
}

export function chartStructuralSignature(spec: ChartSpec): string {
  return JSON.stringify([
    spec.kind,
    chartAxisType(spec, 'x'),
    chartAxisType(spec, 'y'),
    spec.tooltip !== false,
    spec.kind !== 'heatmap' && spec.dataZoom !== false,
    hasChartColorScale(spec)
  ]);
}

function seriesNames(spec: ChartSpec, locale: RuntimeLocale): string[] {
  return 'series' in spec
    ? spec.series.map((series, index) =>
        series.name?.trim()
          ? series.name
          : spec.series.length > 1 || showLegend(spec)
            ? labelsForLanguage(locale).chartSeriesName(index + 1)
            : ''
      )
    : [''];
}

export function chartSeriesId(spec: ChartSpec, index: number): string {
  const id = 'series' in spec ? spec.series[index].id : undefined;
  return id === undefined ? spec.kind + ':' + index : spec.kind + ':id:' + id;
}

function seriesLabels(spec: ChartSpec, names: readonly string[]): Map<string, string> {
  return new Map(names.map((name, index) => [chartSeriesId(spec, index), name]));
}

function legendFormatter(spec: ChartSpec, locale: RuntimeLocale, width: number) {
  const names = seriesLabels(spec, seriesNames(spec, locale));
  return (id: string) => truncateChartLabel(names.get(id) ?? '', Math.max(36, Math.min(220, width - 180)));
}

function escapeChartText(text: string): string {
  return text.replace(
    /[&<>"']/gu,
    (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character] ?? character
  );
}

export function chartSpecToEChartsOptions(
  spec: ChartSpec,
  theme: ChartTheme = 'light',
  {
    reducedMotion = false,
    chrome = defaultChartChrome(theme),
    width = 720,
    height = chartHeight(spec),
    locale = 'en',
    canvasLegend = true
  }: {
    reducedMotion?: boolean;
    chrome?: ChartChrome;
    width?: number;
    height?: number;
    locale?: RuntimeLocale;
    canvasLegend?: boolean;
  } = {}
): EChartsOptions {
  const style = spec.style;
  const labels = labelsForLanguage(locale);
  const palette = style?.palette?.[theme] ?? chartPalette;
  const legend = canvasLegend && showLegend(spec);
  const layout = chartLayout(spec, width, height, legend);
  const values = chartCoordinates(spec);
  const names = seriesNames(spec, locale);
  const nameById = seriesLabels(spec, names);
  const heatmap = spec.kind === 'heatmap' ? normalizeHeatmapSpec(spec) : undefined;
  const horizontalBar = spec.kind === 'bar' && spec.orientation === 'horizontal';
  const xType = chartAxisType(spec, 'x');
  const yType = chartAxisType(spec, 'y');
  const xData = values.x;
  const axis = (horizontal: boolean) => {
    const coordinates = horizontal ? xData : values.y;
    const type = horizontal ? xType : yType;
    const format = horizontal ? style?.xFormat : style?.yFormat;
    const edges = spec.kind === 'field' ? (horizontal ? spec.xEdges : spec.yEdges) : undefined;
    const zero = chartIncludesZero(spec, horizontal ? 'x' : 'y');
    const pointerFormat = chartCoordinateFormatter(coordinates, type, locale, false, format);
    return {
      type,
      inverse: !horizontal && horizontalBar,
      name: horizontal ? spec.xLabel : spec.kind === 'histogram' ? histogramLabel(spec, labels) : spec.yLabel,
      nameLocation: 'middle',
      nameGap: horizontal ? 36 : 32,
      nameMoveOverlap: true,
      nameTruncate: { maxWidth: horizontal ? layout.plotWidth : layout.plotHeight, ellipsis: '…' },
      nameTextStyle: { color: chrome.text },
      ...(type === 'category' ? { data: coordinates } : {}),
      min: (horizontal ? spec.xMin : spec.yMin) ?? (edges?.length ? (zero ? Math.min(0, edges[0]) : edges[0]) : null),
      max:
        (horizontal ? spec.xMax : spec.yMax) ??
        (edges?.length ? (zero ? Math.max(0, edges[edges.length - 1]) : edges[edges.length - 1]) : null),
      scale: !chartIncludesZero(spec, horizontal ? 'x' : 'y'),
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
          : { formatter: chartCoordinateFormatter(coordinates, type, locale, true, format) })
      },
      axisPointer: {
        label: {
          formatter: ({ value }: { value: unknown }) => pointerFormat(value)
        }
      },
      axisLine: {
        show: false,
        onZero: true,
        lineStyle: { color: chrome.axis, width: 1.5 }
      },
      axisTick: { show: false },
      splitLine: { show: style?.showGrid !== false, lineStyle: { color: chrome.splitLine, opacity: 0.45 } }
    };
  };
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
            trigger:
              ['scatter', 'bubble', 'histogram', 'errorbar', 'band', 'boxplot', 'field'].includes(spec.kind) || heatmap
                ? 'item'
                : 'axis',
            confine: true,
            padding: [10, 12],
            borderWidth: 1,
            backgroundColor: chrome.tooltipBackground,
            borderColor: chrome.border,
            textStyle: { color: chrome.text, fontFamily: chrome.fontFamily },
            extraCssText: tooltipCss(width),
            formatter: chartTooltipFormatter(spec, locale, names)
          },
    legend: {
      show: legend,
      data: [...nameById.keys()],
      type: 'scroll',
      top: 8,
      left: 16,
      right: 16,
      height: 24,
      textStyle: { color: chrome.text },
      pageTextStyle: { color: chrome.text },
      pageIconColor: chrome.text,
      pageIconInactiveColor: chrome.border,
      tooltip: {
        show: true,
        confine: true,
        formatter: ({ name }: { name: string }) => escapeChartText(nameById.get(name) ?? '')
      },
      formatter: legendFormatter(spec, locale, width)
    },
    dataZoom:
      spec.dataZoom === false || heatmap
        ? undefined
        : [
            {
              type: 'inside',
              ...(horizontalBar ? { yAxisIndex: 0 } : { xAxisIndex: 0 }),
              filterMode: ['histogram', 'errorbar', 'band', 'field'].includes(spec.kind) ? 'weakFilter' : 'filter',
              start: 0,
              end: 100,
              startValue: null,
              endValue: null
            }
          ],
    series: chartSeries(spec).map((item, index) => {
      const { color, lineType, symbol } = chartSeriesPresentation(spec, index, theme);
      return {
        ...item,
        id: chartSeriesId(spec, index),
        name: chartSeriesId(spec, index),
        itemStyle: { ...(item.itemStyle as Record<string, unknown>), color },
        ...(spec.kind === 'line' || spec.kind === 'area'
          ? {
              lineStyle: {
                ...(item.lineStyle as Record<string, unknown>),
                color,
                type: lineType
              }
            }
          : {}),
        ...(spec.kind === 'scatter' || spec.kind === 'bubble'
          ? {
              symbol,
              itemStyle: { color, borderColor: chrome.tooltipBackground, borderWidth: 1 }
            }
          : {}),
        ...(heatmap ? { itemStyle: { borderColor: chrome.background, borderWidth: 1 } } : {})
      };
    })
  };
  if (spec.kind === 'heatmap') {
    const scale = heatmapColorScale(spec);
    options.visualMap = {
      calculable: true,
      ...layout.visualMap,
      min: scale.visualMin,
      max: scale.visualMax,
      dimension: spec.colorScale === 'diverging' ? 3 : 2,
      seriesIndex: 0,
      formatter: (value: number) =>
        chartNumberFormatter(values.value, locale, false, style?.valueFormat)(scale.unmap(value)),
      textStyle: { color: chrome.text },
      inRange: {
        color:
          style?.palette?.[theme] ?? (spec.colorScale === 'diverging' ? divergingPalette[theme] : heatmapPalette[theme])
      }
    };
  }
  if (spec.kind === 'field') {
    const range = numericBounds(values.value);
    options.visualMap = {
      calculable: true,
      ...layout.visualMap,
      min: range?.minimum ?? 0,
      max: range?.maximum ?? 1,
      dimension: 4,
      seriesIndex: 0,
      formatter: chartNumberFormatter(values.value, locale, false, style?.valueFormat),
      textStyle: { color: chrome.text },
      inRange: { color: style?.palette?.[theme] ?? heatmapPalette[theme] }
    };
    if (spec.dataZoom !== false)
      options.dataZoom = [
        { type: 'inside', xAxisIndex: 0, filterMode: 'weakFilter', start: 0, end: 100 },
        { type: 'inside', yAxisIndex: 0, filterMode: 'weakFilter', start: 0, end: 100 }
      ];
  }
  if (spec.kind === 'bubble' && spec.colorMapping) {
    options.visualMap = {
      calculable: true,
      ...layout.visualMap,
      min: spec.colorMapping.min,
      max: spec.colorMapping.max,
      dimension: 3,
      seriesIndex: spec.series.map((_, index) => index),
      formatter: chartNumberFormatter(values.value, locale, false, style?.valueFormat),
      textStyle: { color: chrome.text },
      inRange: { color: spec.colorMapping.palette?.[theme] ?? heatmapPalette[theme] }
    };
  }
  const annotations = chartAnnotationSeries(spec, chrome, labels, values);
  if (annotations) options.series = [...options.series, annotations];
  return options;
}

function tooltipCss(width: number): string {
  return `border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.12);white-space:normal;overflow-wrap:anywhere;max-width:${Math.max(80, width - 40)}px;`;
}

/** Resize patches contain neither data nor interactive state. */
export function chartResizeOptions(
  spec: ChartSpec,
  counts: { x: number; y: number },
  width: number,
  height: number,
  locale: RuntimeLocale = 'en',
  canvasLegend = true
) {
  const legend = canvasLegend && showLegend(spec);
  const layout = chartLayout(spec, width, height, legend);
  const axis = (horizontal: boolean) => {
    const category = horizontal ? chartAxisType(spec, 'x') === 'category' : chartAxisType(spec, 'y') === 'category';
    return {
      nameTruncate: { maxWidth: horizontal ? layout.plotWidth : layout.plotHeight, ellipsis: '…' },
      ...(category
        ? {
            axisLabel: categoryLabelLayout(
              horizontal ? counts.x : counts.y,
              horizontal ? layout.plotWidth : layout.plotHeight,
              horizontal,
              width
            )
          }
        : {})
    };
  };
  return {
    grid: layout.grid,
    xAxis: axis(true),
    yAxis: axis(false),
    ...(legend ? { legend: { formatter: legendFormatter(spec, locale, width) } } : {}),
    ...(spec.tooltip !== false ? { tooltip: { extraCssText: tooltipCss(width) } } : {}),
    ...(hasChartColorScale(spec) ? { visualMap: layout.visualMap } : {})
  };
}

function chartSeries(spec: ChartSpec): readonly Record<string, unknown>[] {
  switch (spec.kind) {
    case 'line':
    case 'area':
      return spec.series.map((series) => ({
        type: 'line',
        stack: 'stack' in series ? (series.stack ?? '') : '',
        stackStrategy: 'samesign',
        showSymbol: series.style?.showSymbol ?? series.points.length === 1,
        symbol: series.style?.symbol ?? 'emptyCircle',
        smooth: series.style?.smooth ?? false,
        step: series.style?.step ?? false,
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
        stack: series.stack ?? '',
        stackStrategy: 'samesign',
        barMaxWidth: 40,
        itemStyle: { borderRadius: series.stack ? 0 : spec.orientation === 'horizontal' ? [0, 3, 3, 0] : [3, 3, 0, 0] },
        data: series.stack ? series.values : barData(series.values, spec.orientation === 'horizontal')
      }));
    case 'errorbar':
    case 'band':
      return spec.series.map((series) => intervalSeries(spec, series) as Record<string, unknown>);
    case 'field':
      return [fieldSeries(spec) as Record<string, unknown>];
    case 'bubble': {
      const mapping = bubbleSizeMapping(spec);
      return spec.series.map((series) => ({
        type: 'scatter',
        large: false,
        symbolSize: (value: readonly number[]) => mapping.diameter(value[2]),
        data: series.points.map((point) =>
          point[3] == null ? { value: [...point.slice(0, 3), null], visualMap: false } : point
        )
      }));
    }
    case 'boxplot':
      return spec.series.map((series) => ({
        type: 'boxplot',
        data: series.values.map((value) => value ?? ['-', '-', '-', '-', '-'])
      }));
    case 'histogram':
      return [histogramSeries(spec) as Record<string, unknown>];
    case 'heatmap': {
      const scale = heatmapColorScale(spec);
      const data = normalizeHeatmapSpec(spec).data;
      return [
        {
          type: 'heatmap',
          data: spec.colorScale === 'diverging' ? data.map((point) => [...point, scale.map(point[2])]) : data
        }
      ];
    }
    default:
      return [];
  }
}

function barData(values: readonly (number | null)[], horizontal: boolean) {
  if (!values.some((value) => value !== null && value < 0)) return values;
  return values.map((value) =>
    value !== null && value < 0
      ? { value, itemStyle: { borderRadius: horizontal ? [3, 0, 0, 3] : [0, 0, 3, 3] } }
      : value
  );
}

function chartTooltipFormatter(spec: ChartSpec, locale: RuntimeLocale, names: readonly string[]) {
  const horizontalBar = spec.kind === 'bar' && spec.orientation === 'horizontal';
  const labels = labelsForLanguage(locale);
  const values = chartCoordinates(spec);
  const style = spec.style;
  const xType = chartAxisType(spec, 'x');
  const yType = chartAxisType(spec, 'y');
  const x = chartCoordinateFormatter(values.x, xType, locale, false, style?.xFormat);
  const y = chartCoordinateFormatter(values.y, yType, locale, false, style?.yFormat);
  const value = chartNumberFormatter(values.value, locale, false, style?.valueFormat);
  const nameById = seriesLabels(spec, names);
  return (input: unknown): string => {
    const axisTooltip = Array.isArray(input);
    const parameters = axisTooltip ? input : [input];
    const rows: string[] = [];
    let heading: string | undefined;
    for (const parameter of parameters) {
      if (!parameter || typeof parameter !== 'object') continue;
      const item = parameter as {
        value?: unknown;
        name?: string;
        seriesIndex?: number;
        seriesId?: string;
        marker?: unknown;
      };
      const tuple = Array.isArray(item.value) ? item.value : undefined;
      const name = item.seriesId === undefined ? names[item.seriesIndex ?? 0] : nameById.get(item.seriesId);
      const coordinate = tuple ? x(tuple[0]) : (item.name ?? '');
      const amount = tuple ? tuple[1] : item.value;
      const formatted = amount == null || amount === '-' ? '-' : horizontalBar ? x(amount) : y(amount);
      // ECharts generates the marker; authored labels and values are always escaped.
      const marker = typeof item.marker === 'string' ? item.marker : '';
      if (spec.kind === 'field' && tuple) {
        rows.push(
          marker +
            escapeChartText(
              'X: [' +
                x(tuple[0]) +
                ', ' +
                x(tuple[1]) +
                '), Y: [' +
                y(tuple[2]) +
                ', ' +
                y(tuple[3]) +
                '): ' +
                value(Number(tuple[4]))
            )
        );
      } else if (spec.kind === 'bubble' && tuple) {
        rows.push(
          marker +
            [
              name,
              x(tuple[0]),
              y(tuple[1]),
              labels.chartSize + ': ' + chartNumberFormatter([], locale)(Number(tuple[2])),
              ...(tuple[3] == null ? [] : [labels.chartValue + ': ' + value(Number(tuple[3]))])
            ]
              .filter(Boolean)
              .map((part) => escapeChartText(String(part)))
              .join(': ')
        );
      } else if (spec.kind === 'boxplot' && tuple) {
        const stats = tuple.length === 6 ? tuple.slice(1) : tuple;
        rows.push(
          marker +
            [name, item.name, ...stats.map((value, index) => labels.chartBoxStatistics[index] + ': ' + y(value))]
              .filter(Boolean)
              .map((part) => escapeChartText(String(part)))
              .join(': ')
        );
      } else if ((spec.kind === 'errorbar' || spec.kind === 'band') && tuple) {
        rows.push(
          marker +
            [
              name,
              x(tuple[0]),
              labels.chartValue + ': ' + y(tuple[1]),
              labels.chartBinLower + ': ' + y(tuple[2]),
              labels.chartBinUpper + ': ' + y(tuple[3])
            ]
              .filter(Boolean)
              .map((part) => escapeChartText(String(part)))
              .join(': ')
        );
      } else if (spec.kind === 'histogram' && tuple) {
        rows.push(
          marker +
            escapeChartText(
              `[${x(tuple[0])}, ${x(tuple[1])}): ${spec.mode === 'density' ? labels.chartHistogramDensity : labels.chartHistogramCount}: ${y(tuple[2])}`
            )
        );
      } else if (axisTooltip) {
        heading ??= escapeChartText(coordinate);
        rows.push(
          marker +
            [name, formatted]
              .filter((part) => part != null && part !== '')
              .map((part) => escapeChartText(String(part)))
              .join(': ')
        );
      } else {
        const details =
          spec.kind === 'heatmap' && tuple
            ? [coordinate + ' / ' + y(tuple[1]), tuple[2] == null ? '-' : value(Number(tuple[2]))]
            : [coordinate, formatted];
        rows.push(marker + [...(name ? [name] : []), ...details].map(escapeChartText).join(': '));
      }
    }
    return [...(heading ? [heading] : []), ...rows].join('<br/>');
  };
}

export function chartDataSummary(spec: ChartSpec, labels: RuntimeLabels): string {
  const values = chartCoordinates(spec);
  const range = (coordinates: readonly unknown[], type: ChartSpec['xType'], formatSpec?: ChartNumberFormat) => {
    if (type === 'category') return undefined;
    const bounds = numericBounds(
      type === 'time'
        ? coordinates.map((value) => (typeof value === 'number' ? value : Date.parse(String(value))))
        : coordinates
    );
    if (!bounds) return undefined;
    const format = chartCoordinateFormatter(coordinates, type, labels.locale, false, formatSpec);
    return bounds.minimum === bounds.maximum
      ? format(bounds.minimum)
      : format(bounds.minimum) + '–' + format(bounds.maximum);
  };
  const dataCount =
    spec.kind === 'field'
      ? spec.values.reduce((sum, row) => sum + row.length, 0)
      : spec.kind === 'errorbar' || spec.kind === 'band'
        ? spec.series.reduce((sum, series) => sum + series.points.length, 0)
        : spec.kind === 'heatmap'
          ? spec.data.length
          : spec.kind === 'bar' || spec.kind === 'boxplot'
            ? spec.series.reduce((count, series) => count + series.values.length, 0)
            : values.y.length;
  const summary = labels.chartSummary({
    xLabel: spec.xLabel,
    yLabel: spec.kind === 'histogram' ? histogramLabel(spec, labels) : spec.yLabel,
    dataCount,
    seriesCount: 'series' in spec ? spec.series.length : 1,
    seriesNames: seriesNames(spec, labels.locale).filter(Boolean).join(', ').slice(0, 1000),
    xRange: range(values.x, chartAxisType(spec, 'x'), spec.style?.xFormat),
    yRange: range(values.y, chartAxisType(spec, 'y'), spec.style?.yFormat),
    ...(spec.kind === 'field' ? { valueRange: range(values.value, 'value', spec.style?.valueFormat) } : {}),
    ...(spec.kind === 'heatmap'
      ? {
          xCategoryCount: values.x.length,
          yCategoryCount: values.y.length,
          valueRange: range(values.value, 'value', spec.style?.valueFormat)
        }
      : {})
  });
  const text =
    dataCount === 0
      ? [spec.xLabel, spec.yLabel, labels.noChartData].filter(Boolean).join(labels.locale === 'ja' ? '。' : '. ')
      : summary;
  return [
    text,
    ...(spec.kind === 'bubble'
      ? [
          labels.chartSize +
            ' (' +
            (spec.sizeMapping?.scale ?? 'area') +
            '): 0–' +
            chartNumberFormatter([], labels.locale)(bubbleSizeMapping(spec).maximum)
        ]
      : []),
    ...(spec.annotations ?? []).map((item) => annotationDescription(spec, item, labels, values))
  ].join(labels.locale === 'ja' ? '。' : '. ');
}
