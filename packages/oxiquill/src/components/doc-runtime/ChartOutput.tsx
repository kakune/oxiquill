import { useEffect, useRef, useState } from 'preact/hooks';
import type { ChartSpec } from '../../lib/doc-runtime/types';

interface ChartOutputProps {
  spec: ChartSpec;
}

type EChartsCore = typeof import('echarts/core');
type EChartsInstance = ReturnType<EChartsCore['init']>;
export type EChartsOptions = Record<string, unknown> & {
  series: readonly Record<string, unknown>[];
};

const palette = ['#0f766e', '#2563eb', '#9333ea', '#dc2626', '#ca8a04', '#4b5563'];
let echartsModule: Promise<EChartsCore> | undefined;

function loadECharts(): Promise<EChartsCore> {
  echartsModule ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ]).then(([echarts, charts, components, renderers]) => {
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
  });

  return echartsModule;
}

export default function ChartOutput({ spec }: ChartOutputProps) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance>();
  const latestSpec = useRef(spec);
  const [renderError, setRenderError] = useState<Error>();
  latestSpec.current = spec;

  if (renderError) throw renderError;

  useEffect(() => {
    const chartElement = element.current!;
    let cancelled = false;
    let nextChart: EChartsInstance | undefined;
    let resizeObserver: ResizeObserver | undefined;

    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;

        nextChart = echarts.init(chartElement, undefined, { renderer: 'canvas' });
        chart.current = nextChart;
        nextChart.setOption(chartSpecToEChartsOptions(latestSpec.current), true);
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
  }, []);

  useEffect(() => {
    try {
      chart.current?.setOption(chartSpecToEChartsOptions(spec), true);
    } catch (error) {
      setRenderError(toError(error));
    }
  }, [spec]);

  return <div ref={element} class="doc-plot" data-testid="doc-plot" />;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

export function chartSpecToEChartsOptions(spec: ChartSpec): EChartsOptions {
  const series = chartSeries(spec);
  const base = {
    animation: false,
    color: palette,
    grid: { left: 56, right: 24, top: spec.title || shouldShowLegend(spec, series) ? 48 : 24, bottom: 56 },
    tooltip: spec.tooltip === false ? undefined : { trigger: tooltipTrigger(spec) },
    legend: shouldShowLegend(spec, series) ? { top: 4 } : undefined,
    title: spec.title ? { text: spec.title, left: 'center', textStyle: { fontSize: 14, fontWeight: 600 } } : undefined,
    xAxis: xAxis(spec),
    yAxis: yAxis(spec),
    dataZoom: spec.dataZoom === false ? undefined : [{ type: 'inside' }],
    series
  };

  if (spec.kind === 'heatmap') {
    return {
      ...base,
      dataZoom: undefined,
      visualMap: { calculable: true, orient: 'horizontal', left: 'center', bottom: 0 }
    };
  }

  return base;
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
    return categoryAxis(spec.bins.map((bin) => `${bin[0]}-${bin[1]}`), spec.xLabel);
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
