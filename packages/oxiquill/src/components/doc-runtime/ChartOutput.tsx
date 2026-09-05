import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { normalizeHeatmapSpec, type NormalizedHeatmapSpec } from '../../lib/doc-runtime/heatmap-normalization.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { ChartArtifact, ChartSpec } from '../../lib/doc-runtime/types.js';

interface ChartOutputProps {
  artifact: ChartArtifact;
  idPrefix: string;
  labels: RuntimeLabels;
}

type EChartsCore = typeof import('echarts/core');
type EChartsInstance = ReturnType<EChartsCore['init']>;
export type EChartsOptions = Record<string, unknown> & {
  series: readonly Record<string, unknown>[];
};

export type ChartTheme = 'dark' | 'light';

const chartColors = {
  dark: {
    axis: '#d1d5db',
    border: '#6b7280',
    palette: ['#5eead4', '#60a5fa', '#c4b5fd', '#f9a8d4', '#fbbf24', '#cbd5e1'],
    splitLine: '#4b5563',
    text: '#f3f4f6',
    tooltipBackground: '#111827'
  },
  light: {
    axis: '#374151',
    border: '#9ca3af',
    palette: ['#0f766e', '#2563eb', '#7c3aed', '#be185d', '#b45309', '#475569'],
    splitLine: '#d1d5db',
    text: '#111827',
    tooltipBackground: '#ffffff'
  }
} as const;
let echartsModule: Promise<EChartsCore> | undefined;

function loadECharts(): Promise<EChartsCore> {
  echartsModule ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ])
    .then(([echarts, charts, components, renderers]) => {
      echarts.use([
        charts.BarChart,
        charts.HeatmapChart,
        charts.LineChart,
        charts.ScatterChart,
        components.GridComponent,
        components.LegendComponent,
        components.TitleComponent,
        components.TooltipComponent,
        components.VisualMapComponent,
        components.DataZoomComponent,
        renderers.CanvasRenderer
      ]);
      return echarts;
    })
    .catch((error: unknown) => {
      echartsModule = undefined;
      throw error;
    });

  return echartsModule;
}

export default function ChartOutput({ artifact, idPrefix, labels }: ChartOutputProps) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<{
    instance: EChartsInstance;
    signature?: string;
    spec?: ChartSpec;
    reducedMotion?: boolean;
    replace?: boolean;
  }>();
  const reducedMotion = useReducedMotion();
  const latest = useRef({ artifact, reducedMotion });
  latest.current = { artifact, reducedMotion };
  const [displayed, setDisplayed] = useState(artifact);
  const [theme, setTheme] = useState<ChartTheme>(() => currentChartTheme());
  const [renderError, setRenderError] = useState<{ message: string; initialization: boolean }>();
  const [renderAttempt, setRenderAttempt] = useState(0);

  function applyLatest(force = false): void {
    const current = chart.current;
    if (!current) return;
    const { artifact: next, reducedMotion: motion } = latest.current;
    try {
      if (force || current.spec !== next.spec || current.reducedMotion !== motion || current.replace) {
        const signature = chartStructuralSignature(next.spec);
        const notMerge = force || current.replace || current.signature !== signature;
        const options = chartSpecToEChartsOptions(next.spec, theme, {
          reducedMotion: motion,
          chrome: resolveChartChrome(theme, element.current ?? undefined)
        });
        // Leaving the dataZoom component out of a merge retains the reader's current window.
        if (!notMerge) delete options.dataZoom;
        current.instance.setOption(
          options,
          notMerge
            ? { notMerge: true }
            : {
                notMerge: false,
                lazyUpdate: true,
                replaceMerge: ['series']
              }
        );
        current.signature = signature;
        current.spec = next.spec;
        current.reducedMotion = motion;
        current.replace = false;
      }
      setDisplayed(next);
      setRenderError(undefined);
    } catch (error) {
      current.replace = true;
      setRenderError({ message: boundedErrorMessage(error), initialization: current.spec === undefined });
    }
  }

  useEffect(() => {
    const root = globalThis.document?.documentElement;
    if (!root) return undefined;
    const observer = new MutationObserver(() => setTheme(currentChartTheme()));
    observer.observe(root, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const chartElement = element.current;
    if (!chartElement) return undefined;
    let cancelled = false;
    let instance: EChartsInstance | undefined;
    let resizeObserver: ResizeObserver | undefined;
    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;
        instance = echarts.init(chartElement, chartThemeDefinition(theme, resolveChartChrome(theme, chartElement)), {
          renderer: 'canvas'
        });
        chart.current = { instance };
        resizeObserver = new ResizeObserver(() => instance?.resize());
        resizeObserver.observe(chartElement);
        applyLatest(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRenderError({ message: boundedErrorMessage(error), initialization: true });
      });
    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      instance?.dispose();
      chart.current = undefined;
    };
  }, [renderAttempt, theme]);

  useEffect(() => {
    applyLatest();
  }, [artifact, reducedMotion]);

  const titleId = idPrefix + '-title';
  const captionId = displayed.caption ? idPrefix + '-caption' : undefined;
  const descriptionId = idPrefix + '-description';
  const title = displayed.title ?? displayed.spec.title ?? labels.chartTitle(displayed.spec.kind);
  return (
    <figure
      class="doc-chart-output"
      aria-labelledby={titleId}
      aria-describedby={[captionId, descriptionId].filter(Boolean).join(' ')}
    >
      <figcaption>
        <strong id={titleId}>{title}</strong>
        {displayed.caption ? <span id={captionId}>{displayed.caption}</span> : null}
      </figcaption>
      <div
        ref={element}
        class="doc-plot"
        aria-hidden="true"
        data-chart-theme={theme}
        data-chart-motion={reducedMotion ? 'reduced' : 'full'}
        data-testid="doc-plot"
      />
      <p id={descriptionId} class="doc-chart-output__summary">
        <span class="doc-visually-hidden">{labels.chartCaption}: </span>
        {chartDataSummary(displayed.spec, labels)}
      </p>
      {renderError ? (
        <div class="doc-chart-output__error">
          <p class="error-state" data-testid="artifact-error" role="alert">
            {renderError.initialization
              ? labels.chartLoadError(renderError.message)
              : labels.chartUpdateError(renderError.message)}
          </p>
          <button
            type="button"
            onClick={() => {
              if (renderError.initialization) {
                setRenderError(undefined);
                setRenderAttempt((attempt) => attempt + 1);
              } else applyLatest(true);
            }}
          >
            {labels.chartRetry}
          </button>
        </div>
      ) : null}
    </figure>
  );
}

function useReducedMotion(): boolean {
  const media = useMemo(() => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)'), []);
  const [reduced, setReduced] = useState(media?.matches ?? false);
  useEffect(() => {
    if (!media) return;
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener('change', update);
    return () => media.removeEventListener('change', update);
  }, [media]);
  return reduced;
}

export function currentChartTheme(): ChartTheme {
  return globalThis.document?.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export type ChartChrome = {
  axis: string;
  border: string;
  splitLine: string;
  text: string;
  tooltipBackground: string;
  fontFamily: string;
};

export function resolveChartChrome(theme: ChartTheme, element?: Element): ChartChrome {
  const fallback = chartColors[theme];
  const computed = element ? getComputedStyle(element) : undefined;
  const property = (name: string, defaultValue: string) => computed?.getPropertyValue(name).trim() || defaultValue;
  return {
    axis: property('--sl-color-gray-2', fallback.axis),
    border: property('--sl-color-gray-5', fallback.border),
    splitLine: property('--sl-color-gray-5', fallback.splitLine),
    text: property('--sl-color-text', fallback.text),
    tooltipBackground: property('--sl-color-bg', fallback.tooltipBackground),
    fontFamily: computed?.fontFamily || 'system-ui, sans-serif'
  };
}

export function chartStructuralSignature(spec: ChartSpec): string {
  const categorical = spec.kind === 'bar' || spec.kind === 'histogram' || spec.kind === 'heatmap';
  return JSON.stringify([
    spec.kind,
    categorical ? 'category' : (spec.xType ?? 'value'),
    spec.kind === 'heatmap' ? 'category' : (spec.yType ?? 'value'),
    Boolean(spec.title),
    shouldShowLegend(spec, 'series' in spec ? spec.series : []),
    spec.tooltip !== false,
    spec.kind !== 'heatmap' && spec.dataZoom !== false,
    spec.kind === 'heatmap'
  ]);
}

export function chartSpecToEChartsOptions(
  spec: ChartSpec,
  theme: ChartTheme = 'light',
  { reducedMotion = false, chrome = resolveChartChrome(theme) }: { reducedMotion?: boolean; chrome?: ChartChrome } = {}
): EChartsOptions {
  const structure = chartStructure(spec);
  const { series } = structure;
  const style = spec.style;
  const palette = style?.palette?.[theme];
  const legend = shouldShowLegend(spec, series);
  const animation = !reducedMotion && style?.animation !== false;
  const duration = animation ? (style?.animationDurationMs ?? 180) : 0;
  const axisStyle = {
    axisLabel: { color: chrome.axis },
    axisLine: { show: false },
    axisTick: { show: false },
    nameTextStyle: { color: chrome.text },
    splitLine: { show: style?.showGrid !== false, lineStyle: { color: chrome.splitLine, opacity: 0.45 } }
  };
  const base = {
    animation,
    animationDuration: duration,
    animationDurationUpdate: duration,
    animationEasing: 'cubicOut',
    animationEasingUpdate: 'cubicOut',
    backgroundColor: 'transparent',
    color: palette ?? chartColors[theme].palette,
    grid: {
      containLabel: true,
      left: 16,
      right: 20,
      top: spec.title && legend ? 72 : spec.title || legend ? 48 : 20,
      bottom: 36
    },
    tooltip:
      spec.tooltip === false
        ? undefined
        : {
            trigger: tooltipTrigger(spec),
            confine: true,
            padding: [10, 12],
            borderWidth: 1,
            backgroundColor: chrome.tooltipBackground,
            borderColor: chrome.border,
            textStyle: { color: chrome.text, fontFamily: chrome.fontFamily },
            extraCssText: 'border-radius:8px;box-shadow:0 4px 18px rgba(0,0,0,0.12);'
          },
    legend: legend ? { top: spec.title ? 32 : 8, textStyle: { color: chrome.text } } : undefined,
    textStyle: { color: chrome.text, fontFamily: chrome.fontFamily },
    title: spec.title
      ? { text: spec.title, left: 'center', top: 8, textStyle: { color: chrome.text, fontSize: 14, fontWeight: 600 } }
      : undefined,
    xAxis: { ...structure.xAxis, ...axisStyle },
    yAxis: { ...structure.yAxis, ...axisStyle },
    dataZoom: spec.dataZoom === false ? undefined : [{ type: 'inside' }],
    series: series.map((series, index) => ({
      ...series,
      id: spec.kind + ':' + index,
      ...(spec.kind === 'scatter' ? { itemStyle: { borderColor: chrome.tooltipBackground, borderWidth: 1 } } : {})
    }))
  };
  if (structure.heatmap) {
    const valueRange = numericBounds(structure.heatmap.data, (item) => item[2]);
    return {
      ...base,
      grid: { ...base.grid, bottom: 64 },
      dataZoom: undefined,
      visualMap: {
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 8,
        min: valueRange?.minimum ?? 0,
        max: valueRange?.maximum ?? 1,
        textStyle: { color: chrome.text },
        inRange: { color: palette ?? (theme === 'dark' ? ['#173c3b', '#5eead4'] : ['#e6f4f1', '#0f766e']) }
      }
    };
  }
  return base;
}

function chartThemeDefinition(theme: ChartTheme, chrome: ChartChrome): Record<string, unknown> {
  return {
    color: chartColors[theme].palette,
    backgroundColor: 'transparent',
    textStyle: { color: chrome.text, fontFamily: chrome.fontFamily }
  };
}

export function chartDataSummary(spec: ChartSpec, labels: RuntimeLabels): string {
  const details = chartSummaryDetails(spec, labels);
  return boundedSummary(details.dataCount === 0 ? labels.noChartData : labels.chartSummary(details));
}

function chartSummaryDetails(spec: ChartSpec, labels: RuntimeLabels) {
  const numberFormat = new Intl.NumberFormat(labels.locale === 'ja' ? 'ja-JP' : 'en-US', {
    maximumSignificantDigits: 6
  });
  const dateFormat = new Intl.DateTimeFormat(labels.locale === 'ja' ? 'ja-JP' : 'en-US', {
    dateStyle: 'medium',
    timeStyle: 'medium',
    timeZone: 'UTC'
  });
  const range = (values: readonly unknown[], axisType: ChartSpec['xType']) =>
    coordinateRange(values, axisType ?? 'value', numberFormat, dateFormat);

  switch (spec.kind) {
    case 'line':
    case 'scatter':
    case 'area': {
      const points = spec.series.flatMap((series) => series.points);
      return {
        dataCount: points.length,
        seriesCount: spec.series.length,
        seriesNames: seriesNames(spec.series),
        xRange: range(
          points.map((point) => point[0]),
          spec.xType
        ),
        yRange: range(
          points.map((point) => point[1]),
          spec.yType
        )
      };
    }
    case 'bar': {
      const values = spec.series.flatMap((series) => series.values);
      return {
        dataCount: values.length,
        seriesCount: spec.series.length,
        seriesNames: seriesNames(spec.series),
        yRange: range(values, spec.yType)
      };
    }
    case 'histogram':
      return {
        dataCount: spec.bins.length,
        seriesCount: 1,
        seriesNames: '',
        xRange: range(
          spec.bins.flatMap((bin) => [bin[0], bin[1]]),
          'value'
        ),
        yRange: range(
          spec.bins.map((bin) => bin[2]),
          spec.yType
        )
      };
    case 'heatmap': {
      const heatmap = normalizeHeatmapSpec(spec);
      return {
        dataCount: spec.data.length,
        seriesCount: 1,
        seriesNames: '',
        xCategoryCount: heatmap.xCategories.length,
        yCategoryCount: heatmap.yCategories.length,
        valueRange: numericRange(
          heatmap.data.map((item) => item[2]),
          numberFormat
        )
      };
    }
  }
}

function seriesNames(series: readonly { name?: string }[]): string {
  return boundedSummary(series.flatMap((item) => (item.name ? [item.name] : [])).join(', '), 1_000);
}

function numericRange(values: readonly unknown[], numberFormat: Intl.NumberFormat): string | undefined {
  const bounds = numericBounds(values, (value) => value);
  if (!bounds) return undefined;
  const { maximum, minimum } = bounds;
  return minimum === maximum
    ? numberFormat.format(minimum)
    : `${numberFormat.format(minimum)}–${numberFormat.format(maximum)}`;
}

function coordinateRange(
  values: readonly unknown[],
  axisType: NonNullable<ChartSpec['xType']>,
  numberFormat: Intl.NumberFormat,
  dateFormat: Intl.DateTimeFormat
): string | undefined {
  if (axisType === 'category') return undefined;
  if (axisType !== 'time') return numericRange(values, numberFormat);
  const bounds = numericBounds(values, (value) => {
    if (typeof value === 'number') return value;
    return typeof value === 'string' ? Date.parse(value) : Number.NaN;
  });
  if (!bounds) return undefined;
  const minimum = dateFormat.format(bounds.minimum);
  const maximum = dateFormat.format(bounds.maximum);
  return bounds.minimum === bounds.maximum ? minimum : `${minimum}–${maximum}`;
}

function numericBounds<Value>(
  values: readonly Value[],
  numberFromValue: (value: Value) => unknown
): { maximum: number; minimum: number } | undefined {
  let minimum = Number.POSITIVE_INFINITY;
  let maximum = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    const candidate = numberFromValue(value);
    if (typeof candidate !== 'number' || !Number.isFinite(candidate)) continue;
    const number = Object.is(candidate, -0) ? 0 : candidate;
    if (number < minimum) minimum = number;
    if (number > maximum) maximum = number;
  }
  return minimum === Number.POSITIVE_INFINITY ? undefined : { maximum, minimum };
}

function boundedSummary(value: string, maximumLength = 4_000): string {
  return value.length <= maximumLength ? value : `${value.slice(0, maximumLength - 1)}…`;
}

function chartStructure(spec: ChartSpec): {
  heatmap?: NormalizedHeatmapSpec;
  series: readonly Record<string, unknown>[];
  xAxis: Record<string, unknown>;
  yAxis: Record<string, unknown>;
} {
  if (spec.kind === 'heatmap') {
    const heatmap = normalizeHeatmapSpec(spec);
    return {
      heatmap,
      series: [{ type: 'heatmap', data: heatmap.data }],
      xAxis: categoryAxis(heatmap.xCategories, spec.xLabel),
      yAxis: categoryAxis(heatmap.yCategories, spec.yLabel)
    };
  }

  return {
    series: chartSeries(spec),
    xAxis: xAxis(spec),
    yAxis: yAxis(spec)
  };
}

function chartSeries(spec: Exclude<ChartSpec, { kind: 'heatmap' }>): readonly Record<string, unknown>[] {
  switch (spec.kind) {
    case 'line':
      return spec.series.map((series) => ({
        type: 'line',
        name: series.name,
        showSymbol: false,
        lineStyle: { width: spec.style?.lineWidth ?? 2.25, cap: 'round', join: 'round' },
        data: series.points
      }));
    case 'scatter':
      return spec.series.map((series) => ({
        type: 'scatter',
        name: series.name,
        symbolSize: spec.style?.symbolSize ?? 7,
        data: series.points
      }));
    case 'bar':
      return spec.series.map((series) => ({
        type: 'bar',
        barMaxWidth: 40,
        itemStyle: { borderRadius: [3, 3, 0, 0] },
        name: series.name,
        data: series.values
      }));
    case 'histogram':
      return [
        {
          type: 'bar',
          barMaxWidth: 40,
          itemStyle: { borderRadius: [3, 3, 0, 0] },
          barCategoryGap: '8%',
          data: spec.bins.map((bin) => bin[2])
        }
      ];
    case 'area':
      return spec.series.map((series) => ({
        type: 'line',
        name: series.name,
        showSymbol: false,
        lineStyle: { width: spec.style?.lineWidth ?? 2.25, cap: 'round', join: 'round' },
        areaStyle: { opacity: 0.14 },
        data: series.points
      }));
    default:
      return [];
  }
}

function xAxis(spec: Exclude<ChartSpec, { kind: 'heatmap' }>): Record<string, unknown> {
  if (spec.kind === 'bar') {
    return categoryAxis(spec.categories, spec.xLabel);
  }

  if (spec.kind === 'histogram') {
    return categoryAxis(
      spec.bins.map((bin) => `${bin[0]}-${bin[1]}`),
      spec.xLabel
    );
  }

  return valueAxis(spec.xType ?? 'value', spec.xLabel);
}

function yAxis(spec: Exclude<ChartSpec, { kind: 'heatmap' }>): Record<string, unknown> {
  return valueAxis(spec.yType ?? 'value', spec.yLabel);
}

function categoryAxis(data: readonly string[], name?: string): Record<string, unknown> {
  return { type: 'category', data, name, nameLocation: 'middle', nameGap: 34 };
}

function valueAxis(type: NonNullable<ChartSpec['xType']>, name?: string): Record<string, unknown> {
  return { type, name, nameLocation: 'middle', nameGap: 34, scale: true };
}

function tooltipTrigger(spec: ChartSpec): 'axis' | 'item' {
  return spec.kind === 'scatter' || spec.kind === 'heatmap' ? 'item' : 'axis';
}

function shouldShowLegend(spec: ChartSpec, series: readonly { name?: unknown }[]): boolean {
  if (spec.legend != null) return spec.legend;
  return series.filter((item) => typeof item.name === 'string' && item.name.length > 0).length > 1;
}
