import { BarChart, HeatmapChart, LineChart, ScatterChart } from 'echarts/charts';
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent
} from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'preact/hooks';
import type { ChartSpec } from '../../lib/doc-runtime/types';

echarts.use([
  BarChart,
  HeatmapChart,
  LineChart,
  ScatterChart,
  GridComponent,
  LegendComponent,
  TitleComponent,
  TooltipComponent,
  VisualMapComponent,
  DataZoomComponent,
  CanvasRenderer
]);

interface ChartOutputProps {
  spec: ChartSpec;
}

type EChartsInstance = ReturnType<typeof echarts.init>;
export type EChartsOptions = Record<string, unknown> & {
  series: readonly Record<string, unknown>[];
};

const palette = ['#0f766e', '#2563eb', '#9333ea', '#dc2626', '#ca8a04', '#4b5563'];

export default function ChartOutput({ spec }: ChartOutputProps) {
  const element = useRef<HTMLDivElement>(null);
  const chart = useRef<EChartsInstance>();

  useEffect(() => {
    const chartElement = element.current!;
    const nextChart = echarts.init(chartElement, undefined, { renderer: 'canvas' });
    chart.current = nextChart;

    const resizeObserver = new ResizeObserver(() => nextChart.resize());
    resizeObserver.observe(chartElement);

    return () => {
      resizeObserver.disconnect();
      nextChart.dispose();
      chart.current = undefined;
    };
  }, []);

  useEffect(() => {
    chart.current!.setOption(chartSpecToEChartsOptions(spec), true);
  }, [spec]);

  return <div ref={element} class="doc-plot" data-testid="doc-plot" />;
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
