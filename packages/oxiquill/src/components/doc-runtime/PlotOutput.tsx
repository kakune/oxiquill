import type { ChartSpec, PlotSpec } from '../../lib/doc-runtime/types';
import ChartOutput from './ChartOutput';

interface PlotOutputProps {
  plot: PlotSpec;
}

export default function PlotOutput({ plot }: PlotOutputProps) {
  return <ChartOutput spec={legacyPlotToChartSpec(plot)} />;
}

function legacyPlotToChartSpec(plot: PlotSpec): ChartSpec {
  return {
    kind: 'line',
    xLabel: plot.x_label,
    yLabel: plot.y_label,
    xType: 'value',
    yType: 'value',
    tooltip: true,
    dataZoom: true,
    series: [{ points: plot.points }]
  };
}
