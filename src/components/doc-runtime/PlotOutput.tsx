import { LineChart } from 'echarts/charts';
import { DataZoomComponent, GridComponent, TooltipComponent } from 'echarts/components';
import * as echarts from 'echarts/core';
import { CanvasRenderer } from 'echarts/renderers';
import { useEffect, useRef } from 'preact/hooks';
import type { PlotSpec } from '../../lib/doc-runtime/types';

echarts.use([LineChart, GridComponent, TooltipComponent, DataZoomComponent, CanvasRenderer]);

interface PlotOutputProps {
  plot: PlotSpec;
}

type EChartsInstance = ReturnType<typeof echarts.init>;

export default function PlotOutput({ plot }: PlotOutputProps) {
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
    chart.current!.setOption(
      {
        animation: false,
        color: ['#0f766e'],
        grid: { left: 48, right: 18, top: 18, bottom: 48 },
        tooltip: { trigger: 'axis' },
        xAxis: { type: 'value', name: plot.x_label },
        yAxis: { type: 'value', name: plot.y_label },
        dataZoom: [{ type: 'inside' }],
        series: [
          {
            type: 'line',
            showSymbol: false,
            data: plot.points
          }
        ]
      },
      true
    );
  }, [plot]);

  return <div ref={element} class="doc-plot" data-testid="doc-plot" />;
}
