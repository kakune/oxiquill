import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import type { RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import type { ChartArtifact, ChartSpec } from '../../lib/doc-runtime/types.js';
import {
  chartDataSummary,
  chartSpecToEChartsOptions,
  chartStructuralSignature,
  defaultChartChrome,
  type ChartChrome,
  type ChartTheme
} from '../../lib/doc-runtime/chart-options.js';
import { chartHeight } from '../../lib/doc-runtime/chart-layout.js';
import { chartPalette } from '../../lib/doc-runtime/chart-palette.js';

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
        charts.HeatmapChart,
        charts.LineChart,
        charts.ScatterChart,
        components.GridComponent,
        components.LegendComponent,
        components.MarkLineComponent,
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
    width?: number;
    height?: number;
    locale?: string;
    symbols?: string;
    updateSymbols?: () => void;
  }>();
  const reducedMotion = useReducedMotion();
  const latest = useRef({ artifact, reducedMotion, labels });
  latest.current = { artifact, reducedMotion, labels };
  const [displayed, setDisplayed] = useState(artifact);
  const [theme, setTheme] = useState<ChartTheme>(() => currentChartTheme());
  const [renderError, setRenderError] = useState<{ message: string; initialization: boolean }>();
  const [renderAttempt, setRenderAttempt] = useState(0);

  function applyLatest(force = false): void {
    const current = chart.current;
    if (!current) return;
    const { artifact: next, reducedMotion: motion, labels: nextLabels } = latest.current;
    const width = element.current?.clientWidth || 720;
    const height = chartHeight(next.spec);
    try {
      if (
        force ||
        current.spec !== next.spec ||
        current.reducedMotion !== motion ||
        current.replace ||
        current.width !== width ||
        current.height !== height ||
        current.locale !== nextLabels.locale
      ) {
        const signature = chartStructuralSignature(next.spec);
        const notMerge = force || current.replace || current.signature !== signature;
        const options = chartSpecToEChartsOptions(next.spec, theme, {
          reducedMotion: motion,
          width,
          height,
          locale: nextLabels.locale,
          chrome: resolveChartChrome(theme, element.current ?? undefined)
        });
        // Omit interactive state when merging a compatible chart.
        if (!notMerge) delete options.dataZoom;
        current.instance.setOption(
          options,
          notMerge ? { notMerge: true } : { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] }
        );
        current.signature = signature;
        current.spec = next.spec;
        current.reducedMotion = motion;
        current.replace = false;
        current.width = width;
        current.height = height;
        current.locale = nextLabels.locale;
        current.symbols = undefined;
        current.updateSymbols?.();
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
    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;
        const chrome = resolveChartChrome(theme, chartElement);
        instance = echarts.init(
          chartElement,
          {
            color: chartPalette,
            backgroundColor: 'transparent',
            textStyle: { color: chrome.text, fontFamily: chrome.fontFamily }
          },
          { renderer: 'canvas' }
        );
        chart.current = { instance };
        const updateSymbols = () => {
          if (frame !== undefined) cancelAnimationFrame(frame);
          frame = requestAnimationFrame(() => {
            frame = undefined;
            const current = chart.current;
            const spec = current?.spec;
            if (!current || !spec || (spec.kind !== 'line' && spec.kind !== 'area')) return;
            const visible = spec.series.map((series, seriesIndex) => {
              let count = 0;
              for (const point of series.points) {
                const pixel = current.instance.convertToPixel({ seriesIndex }, point as [number, number]);
                if (pixel && current.instance.containPixel({ gridIndex: 0 }, pixel) && ++count > 1) break;
              }
              return count === 1;
            });
            const signature = JSON.stringify(visible);
            if (current.symbols === signature) return;
            const previous = current.symbols;
            current.symbols = signature;
            // The initial options already handle unzoomed single-point series.
            if (
              previous === undefined &&
              visible.every((show, index) => show === (spec.series[index].points.length === 1))
            )
              return;
            current.instance.setOption({
              series: visible.map((showSymbol, index) => ({ id: spec.kind + ':' + index, showSymbol }))
            });
          });
        };
        chart.current.updateSymbols = updateSymbols;
        instance.on('datazoom', updateSymbols);
        resizeObserver = new ResizeObserver(() => {
          instance?.resize();
          applyLatest();
          updateSymbols();
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
  }, [renderAttempt, theme]);

  useEffect(() => {
    applyLatest();
  }, [artifact, reducedMotion, labels]);
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
