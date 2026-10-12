type EChartsCore = typeof import('echarts/core');
export type EChartsInstance = ReturnType<EChartsCore['init']>;
let echartsModule: Promise<EChartsCore> | undefined;

export function loadECharts(): Promise<EChartsCore> {
  echartsModule ??= Promise.all([
    import('echarts/core'),
    import('echarts/charts'),
    import('echarts/components'),
    import('echarts/renderers')
  ])
    .then(([echarts, charts, components, renderers]) => {
      echarts.use([
        charts.BarChart,
        charts.BoxplotChart,
        charts.CustomChart,
        charts.HeatmapChart,
        charts.LineChart,
        charts.ScatterChart,
        components.GridComponent,
        components.MarkLineComponent,
        components.MarkAreaComponent,
        components.LegendComponent,
        components.TooltipComponent,
        components.VisualMapComponent,
        components.DataZoomComponent,
        renderers.CanvasRenderer,
        renderers.SVGRenderer
      ]);
      return echarts;
    })
    .catch((error: unknown) => {
      echartsModule = undefined;
      throw error;
    });
  return echartsModule;
}
