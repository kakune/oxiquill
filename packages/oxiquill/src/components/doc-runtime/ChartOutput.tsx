import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { ChartArtifact, ChartSpec } from '../../lib/doc-runtime/types.js';
import {
  chartDataSummary,
  chartResizeOptions,
  chartSpecToEChartsOptions,
  chartStructuralSignature,
  chartSeriesId,
  defaultChartChrome,
  type ChartChrome,
  type ChartTheme
} from '../../lib/doc-runtime/chart-options.js';
import { chartRangeSignature } from '../../lib/doc-runtime/chart-axes.js';
import { chartHeight } from '../../lib/doc-runtime/chart-layout.js';
import { chartAxes, chartPointIndexes, hasIsolatedPoint } from '../../lib/doc-runtime/chart-viewport.js';

export { chartDataSummary, chartSpecToEChartsOptions, chartStructuralSignature };
export type { ChartChrome, ChartTheme, EChartsOptions } from '../../lib/doc-runtime/chart-options.js';

interface ChartOutputProps {
  artifact: ChartArtifact;
  idPrefix: string;
  labels: RuntimeLabels;
}
type EChartsCore = typeof import('echarts/core');
type EChartsInstance = ReturnType<EChartsCore['init']>;
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
        charts.CustomChart,
        charts.HeatmapChart,
        charts.LineChart,
        charts.ScatterChart,
        components.GridComponent,
        components.LegendComponent,
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
    theme?: ChartTheme;
    replace?: boolean;
    width?: number;
    height?: number;
    locale?: string;
    symbols?: string;
    indexes?: ReturnType<typeof chartPointIndexes>;
    counts?: { x: number; y: number };
    baseline?: boolean;
    zeroLine?: boolean;
    updateViewport?: () => void;
  }>();
  const reducedMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(artifact);
  const [theme, setTheme] = useState<ChartTheme>(() => currentChartTheme());
  const latest = useRef({ artifact, reducedMotion, labels, theme });
  latest.current = { artifact, reducedMotion, labels, theme };
  const [renderError, setRenderError] = useState<{ message: string; initialization: boolean }>();
  const [renderAttempt, setRenderAttempt] = useState(0);

  function applyLatest(force = false): void {
    const current = chart.current;
    if (!current) return;
    const { artifact: next, reducedMotion: motion, labels: nextLabels, theme: nextTheme } = latest.current;
    const width = element.current?.clientWidth || 720;
    const height = chartHeight(next.spec);
    try {
      if (
        force ||
        current.spec !== next.spec ||
        current.reducedMotion !== motion ||
        current.theme !== nextTheme ||
        current.replace ||
        current.locale !== nextLabels.locale
      ) {
        const signature = chartStructuralSignature(next.spec);
        const notMerge = force || current.replace || current.signature !== signature;
        const options = chartSpecToEChartsOptions(next.spec, nextTheme, {
          reducedMotion: motion,
          width,
          height,
          locale: nextLabels.locale,
          chrome: resolveChartChrome(nextTheme, element.current ?? undefined)
        });
        // Omit interactive state when merging a compatible chart.
        if (!notMerge && current.spec && chartRangeSignature(current.spec) === chartRangeSignature(next.spec))
          delete options.dataZoom;
        current.instance.setOption(
          options,
          notMerge ? { notMerge: true } : { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] }
        );
        current.signature = signature;
        current.spec = next.spec;
        current.reducedMotion = motion;
        current.theme = nextTheme;
        current.replace = false;
        current.width = width;
        current.height = height;
        current.locale = nextLabels.locale;
        current.symbols = undefined;
        current.indexes = undefined;
        const xAxis = options.xAxis as { data?: readonly unknown[]; axisLine: { show: boolean } };
        const yAxis = options.yAxis as { data?: readonly unknown[] };
        current.counts = { x: xAxis.data?.length ?? 0, y: yAxis.data?.length ?? 0 };
        current.baseline = current.zeroLine = xAxis.axisLine.show;
        current.updateViewport?.();
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
    if (!root) return;
    const observer = new MutationObserver(() => setTheme(currentChartTheme()));
    observer.observe(root, { attributeFilter: ['data-theme'], attributes: true });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const chartElement = element.current;
    if (!chartElement) return;
    let cancelled = false;
    let instance: EChartsInstance | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame: number | undefined;
    let resizePending = false;
    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;
        instance = echarts.init(chartElement, undefined, { renderer: 'canvas' });
        chart.current = { instance };
        const updateViewport = () => {
          if (frame !== undefined) return;
          frame = requestAnimationFrame(() => {
            frame = undefined;
            const current = chart.current;
            const spec = current?.spec;
            if (!current || !spec) return;
            try {
              if (resizePending) {
                resizePending = false;
                const width = chartElement.clientWidth || 720;
                const height = chartElement.clientHeight || current.height || 360;
                if (current.instance.getWidth() !== width || current.instance.getHeight() !== height) {
                  current.instance.resize();
                }
                if (current.width !== width || current.height !== height) {
                  current.instance.setOption(
                    chartResizeOptions(
                      spec,
                      current.counts ?? { x: 0, y: 0 },
                      width,
                      height,
                      latest.current.labels.locale
                    )
                  );
                  current.width = width;
                  current.height = height;
                }
              }
              const axes = chartAxes(current.instance);
              if (!axes) return;
              const x = axes.x.getExtent();
              const y = axes.y.getExtent();
              const patch: Record<string, unknown> = {};
              const zeroLine = Boolean(current.baseline && y[0] <= 0 && y[1] >= 0);
              if (zeroLine !== current.zeroLine) {
                current.zeroLine = zeroLine;
                patch.xAxis = { axisLine: { show: zeroLine } };
              }
              if (spec.kind === 'line' || spec.kind === 'area') {
                current.indexes ??= chartPointIndexes(spec, axes);
                const visible = current.indexes.map(
                  (index, seriesIndex) => spec.series[seriesIndex].style?.showSymbol ?? hasIsolatedPoint(index, x, y)
                );
                const signature = JSON.stringify(visible);
                if (current.symbols !== signature) {
                  const initial =
                    current.symbols === undefined &&
                    visible.every(
                      (show, index) =>
                        show === (spec.series[index].style?.showSymbol ?? spec.series[index].points.length === 1)
                    );
                  current.symbols = signature;
                  if (!initial)
                    patch.series = visible.map((showSymbol, index) => ({ id: chartSeriesId(spec, index), showSymbol }));
                }
              }
              if (Object.keys(patch).length) current.instance.setOption(patch);
            } catch (error) {
              current.replace = true;
              setRenderError({ message: boundedErrorMessage(error), initialization: false });
            }
          });
        };
        chart.current.updateViewport = updateViewport;
        instance.on('datazoom', updateViewport);
        for (const event of [
          'legendselectchanged',
          'legendselected',
          'legendunselected',
          'legendselectall',
          'legendinverseselect'
        ]) {
          instance.on(event, updateViewport);
        }
        resizeObserver = new ResizeObserver(() => {
          resizePending = true;
          updateViewport();
        });
        resizeObserver.observe(chartElement);
        applyLatest(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRenderError({ message: boundedErrorMessage(error), initialization: true });
      });
    return () => {
      cancelled = true;
      if (frame !== undefined) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      instance?.dispose();
      chart.current = undefined;
    };
  }, [renderAttempt]);

  useEffect(() => {
    applyLatest();
  }, [artifact, reducedMotion, labels, theme]);
  const titleId = idPrefix + '-title';
  const captionId = displayed.caption ? idPrefix + '-caption' : undefined;
  const descriptionId = idPrefix + '-description';
  const title = displayed.title ?? displayed.spec.title ?? labels.chartTitle(displayed.spec.kind);
  const subtitle =
    displayed.title && displayed.spec.title && displayed.title !== displayed.spec.title
      ? displayed.spec.title
      : undefined;
  return (
    <figure
      class="doc-chart-output"
      aria-labelledby={titleId}
      aria-describedby={[captionId, descriptionId].filter(Boolean).join(' ')}
    >
      <figcaption>
        <strong id={titleId}>{title}</strong>
        {subtitle ? <span>{subtitle}</span> : null}
        {displayed.caption ? <span id={captionId}>{displayed.caption}</span> : null}
      </figcaption>
      <div
        ref={element}
        class="doc-plot"
        style={{ height: chartHeight(displayed.spec) }}
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

export function resolveChartChrome(theme: ChartTheme, element?: Element): ChartChrome {
  const fallback = defaultChartChrome(theme);
  const computed = element ? getComputedStyle(element) : undefined;
  const property = (name: string, defaultValue: string) => computed?.getPropertyValue(name).trim() || defaultValue;
  return {
    background:
      computed?.backgroundColor && computed.backgroundColor !== 'rgba(0, 0, 0, 0)'
        ? computed.backgroundColor
        : fallback.background,
    axis: property('--sl-color-gray-2', fallback.axis),
    border: property('--sl-color-gray-5', fallback.border),
    splitLine: property('--sl-color-gray-5', fallback.splitLine),
    text: property('--sl-color-text', fallback.text),
    tooltipBackground: property('--sl-color-bg', fallback.tooltipBackground),
    fontFamily: computed?.fontFamily || fallback.fontFamily
  };
}
