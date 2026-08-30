import { useEffect, useRef, useState } from 'preact/hooks';
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
    palette: ['#5eead4', '#60a5fa', '#c084fc', '#fb7185', '#facc15', '#d1d5db'],
    splitLine: '#4b5563',
    text: '#f3f4f6',
    tooltipBackground: '#111827'
  },
  light: {
    axis: '#374151',
    border: '#9ca3af',
    palette: ['#0f766e', '#1d4ed8', '#7e22ce', '#be123c', '#a16207', '#374151'],
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
  const { spec } = artifact;
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance>();
  const latestSpec = useRef(spec);
  const [theme, setTheme] = useState<ChartTheme>(() => currentChartTheme());
  const [renderError, setRenderError] = useState<Error>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  latestSpec.current = spec;

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
    let nextChart: EChartsInstance | undefined;
    let resizeObserver: ResizeObserver | undefined;

    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;

        nextChart = echarts.init(chartElement, chartThemeDefinition(theme), { renderer: 'canvas' });
        chart.current = nextChart;
        nextChart.setOption(chartSpecToEChartsOptions(latestSpec.current, theme), true);
        resizeObserver = new ResizeObserver(() => nextChart?.resize());
        resizeObserver.observe(chartElement);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRenderError(toError(error));
      });

    return () => {
      cancelled = true;
      resizeObserver?.disconnect();
      nextChart?.dispose();
      chart.current = undefined;
    };
  }, [renderAttempt, theme]);

  useEffect(() => {
    try {
      chart.current?.setOption(chartSpecToEChartsOptions(spec, theme), true);
    } catch (error) {
      setRenderError(toError(error));
    }
  }, [spec, theme]);

  if (renderError) {
    return (
      <div class="doc-chart-output__error">
        <p class="error-state" data-testid="artifact-error" role="alert">
          {labels.chartLoadError(renderError.message)}
        </p>
        <button
          type="button"
          onClick={() => {
            setRenderError(undefined);
            setRenderAttempt((attempt) => attempt + 1);
          }}
        >
          {labels.chartRetry}
        </button>
      </div>
    );
  }

  const titleId = `${idPrefix}-title`;
  const captionId = artifact.caption ? `${idPrefix}-caption` : undefined;
  const descriptionId = `${idPrefix}-description`;
  const title = artifact.title ?? spec.title ?? labels.chartTitle(spec.kind);

  return (
    <figure
      class="doc-chart-output"
      aria-labelledby={titleId}
      aria-describedby={[captionId, descriptionId].filter(Boolean).join(' ')}
    >
      <figcaption>
        <strong id={titleId}>{title}</strong>
        {artifact.caption ? <span id={captionId}>{artifact.caption}</span> : null}
      </figcaption>
      <div ref={element} class="doc-plot" aria-hidden="true" data-chart-theme={theme} data-testid="doc-plot" />
      <p id={descriptionId} class="doc-chart-output__summary">
        <span class="doc-visually-hidden">{labels.chartCaption}: </span>
        {chartDataSummary(spec, labels)}
      </p>
    </figure>
  );
}

function toError(value: unknown): Error {
  return new Error(boundedErrorMessage(value));
}

export function currentChartTheme(): ChartTheme {
  return globalThis.document?.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function chartSpecToEChartsOptions(spec: ChartSpec, theme: ChartTheme = 'light'): EChartsOptions {
  const series = chartSeries(spec);
  const colors = chartColors[theme];
  const axisStyle = {
    axisLabel: { color: colors.axis },
    axisLine: { lineStyle: { color: colors.border } },
    nameTextStyle: { color: colors.text },
    splitLine: { lineStyle: { color: colors.splitLine } }
  };
  const base = {
    animation: false,
    backgroundColor: 'transparent',
    color: colors.palette,
    grid: { left: 56, right: 24, top: spec.title || shouldShowLegend(spec, series) ? 48 : 24, bottom: 56 },
    tooltip:
      spec.tooltip === false
        ? undefined
        : {
            trigger: tooltipTrigger(spec),
            backgroundColor: colors.tooltipBackground,
            borderColor: colors.border,
            textStyle: { color: colors.text }
          },
    legend: shouldShowLegend(spec, series) ? { top: 4, textStyle: { color: colors.text } } : undefined,
    textStyle: { color: colors.text },
    title: spec.title
      ? { text: spec.title, left: 'center', textStyle: { color: colors.text, fontSize: 14, fontWeight: 600 } }
      : undefined,
    xAxis: { ...xAxis(spec), ...axisStyle },
    yAxis: { ...yAxis(spec), ...axisStyle },
    dataZoom: spec.dataZoom === false ? undefined : [{ type: 'inside' }],
    series
  };

  if (spec.kind === 'heatmap') {
    const valueRange = numericBounds(spec.data, (item) => item[2]);
    return {
      ...base,
      dataZoom: undefined,
      visualMap: {
        calculable: true,
        orient: 'horizontal',
        left: 'center',
        bottom: 0,
        min: valueRange?.minimum ?? 0,
        max: valueRange?.maximum ?? 1,
        textStyle: { color: colors.text }
      }
    };
  }

  return base;
}

function chartThemeDefinition(theme: ChartTheme): Record<string, unknown> {
  const colors = chartColors[theme];
  return {
    color: colors.palette,
    backgroundColor: 'transparent',
    textStyle: { color: colors.text },
    title: { textStyle: { color: colors.text } },
    legend: { textStyle: { color: colors.text } },
    categoryAxis: {
      axisLabel: { color: colors.axis },
      axisLine: { lineStyle: { color: colors.border } },
      splitLine: { lineStyle: { color: colors.splitLine } }
    },
    valueAxis: {
      axisLabel: { color: colors.axis },
      axisLine: { lineStyle: { color: colors.border } },
      splitLine: { lineStyle: { color: colors.splitLine } }
    }
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
    case 'heatmap':
      return {
        dataCount: spec.data.length,
        seriesCount: 1,
        seriesNames: '',
        xRange: range(
          spec.data.map((item) => item[0]),
          spec.xCategories ? 'category' : spec.xType
        ),
        yRange: range(
          spec.data.map((item) => item[1]),
          spec.yCategories ? 'category' : spec.yType
        ),
        valueRange: numericRange(
          spec.data.map((item) => item[2]),
          numberFormat
        )
      };
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

function chartSeries(spec: ChartSpec): readonly Record<string, unknown>[] {
  switch (spec.kind) {
    case 'line':
      return spec.series.map((series) => ({
        type: 'line',
        name: series.name,
        showSymbol: false,
        data: series.points
      }));
    case 'scatter':
      return spec.series.map((series) => ({
        type: 'scatter',
        name: series.name,
        symbolSize: 6,
        data: series.points
      }));
    case 'bar':
      return spec.series.map((series) => ({
        type: 'bar',
        name: series.name,
        data: series.values
      }));
    case 'histogram':
      return [
        {
          type: 'bar',
          barCategoryGap: '8%',
          data: spec.bins.map((bin) => bin[2])
        }
      ];
    case 'area':
      return spec.series.map((series) => ({
        type: 'line',
        name: series.name,
        showSymbol: false,
        areaStyle: { opacity: 0.18 },
        data: series.points
      }));
    case 'heatmap':
      return [{ type: 'heatmap', data: spec.data }];
    default:
      return [];
  }
}

function xAxis(spec: ChartSpec): Record<string, unknown> {
  if (spec.kind === 'bar') {
    return categoryAxis(spec.categories, spec.xLabel);
  }

  if (spec.kind === 'histogram') {
    return categoryAxis(
      spec.bins.map((bin) => `${bin[0]}-${bin[1]}`),
      spec.xLabel
    );
  }

  if (spec.kind === 'heatmap' && spec.xCategories) {
    return categoryAxis(spec.xCategories, spec.xLabel);
  }

  return valueAxis(spec.xType ?? 'value', spec.xLabel);
}

function yAxis(spec: ChartSpec): Record<string, unknown> {
  if (spec.kind === 'heatmap' && spec.yCategories) {
    return categoryAxis(spec.yCategories, spec.yLabel);
  }

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

function shouldShowLegend(spec: ChartSpec, series: readonly Record<string, unknown>[]): boolean {
  if (spec.legend != null) return spec.legend;
  return series.filter((item) => typeof item.name === 'string' && item.name.length > 0).length > 1;
}
