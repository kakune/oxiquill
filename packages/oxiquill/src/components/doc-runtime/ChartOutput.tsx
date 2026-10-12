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
  chartSeriesPresentation,
  showLegend,
  defaultChartChrome,
  type ChartChrome,
  type ChartTheme
} from '../../lib/doc-runtime/chart-options.js';
import { chartRangeSignature } from '../../lib/doc-runtime/chart-axes.js';
import { chartHeight } from '../../lib/doc-runtime/chart-layout.js';
import { chartToTable } from '../../lib/doc-runtime/chart-table.js';
import TableOutput from './TableOutput.js';
import {
  applyChartViewState,
  chartViewState,
  exportChartImage,
  type ChartViewState
} from '../../lib/doc-runtime/chart-export.js';
import { artifactDownloadName, downloadBlob } from '../../lib/doc-runtime/download.js';
import { chartAxes, chartPointIndexes, hasIsolatedPoint } from '../../lib/doc-runtime/chart-viewport.js';

export { chartDataSummary, chartSpecToEChartsOptions, chartStructuralSignature };
export type { ChartChrome, ChartTheme, EChartsOptions } from '../../lib/doc-runtime/chart-options.js';

interface ChartOutputProps {
  artifact: ChartArtifact;
  idPrefix: string;
  labels: RuntimeLabels;
}
import { loadECharts, type EChartsInstance } from '../../lib/doc-runtime/echarts-runtime.js';

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
  const [exporting, setExporting] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const tableButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [legendPage, setLegendPage] = useState(0);
  const table = useMemo(
    () => (tableOpen ? chartToTable(displayed.spec, labels) : undefined),
    [tableOpen, displayed.spec, labels]
  );
  const [exportError, setExportError] = useState<string>();
  const savedView = useRef<{ signature: string; rangeSignature: string; state: ChartViewState }>();

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
          canvasLegend: false,
          chrome: resolveChartChrome(nextTheme, element.current ?? undefined)
        });
        if (!current.spec && savedView.current?.signature === signature) {
          const state = { ...savedView.current.state };
          if (savedView.current.rangeSignature !== chartRangeSignature(next.spec)) {
            delete state.dataZoom;
            delete state.symbols;
          }
          applyChartViewState(options, state);
        }
        savedView.current = undefined;
        // Omit interactive state when merging a compatible chart.
        if (!notMerge && current.spec && chartRangeSignature(current.spec) === chartRangeSignature(next.spec))
          delete options.dataZoom;
        current.instance.setOption(
          options,
          notMerge ? { notMerge: true } : { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] }
        );
        // Merges keep ECharts' legend selection; replacements start from the applied option.
        if (notMerge) setSelected({ ...(options.legend as { selected?: Record<string, boolean> }).selected });
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
        const yAxis = options.yAxis as { data?: readonly unknown[]; axisLine: { show: boolean } };
        current.counts = { x: xAxis.data?.length ?? 0, y: yAxis.data?.length ?? 0 };
        current.baseline = current.zeroLine = xAxis.axisLine.show || yAxis.axisLine.show;
        current.updateViewport?.();
      }
      setDisplayed(next);
      setIsReady(true);
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
    setIsReady(false);
    let cancelled = false;
    let instance: EChartsInstance | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let frame: number | undefined;
    let resizePending = false;
    void loadECharts()
      .then((echarts) => {
        if (cancelled) return;
        instance = echarts.init(chartElement, undefined, {
          renderer: latest.current.artifact.spec.style?.renderer ?? 'canvas'
        });
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
                      latest.current.labels.locale,
                      false
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
              const horizontalBar = spec.kind === 'bar' && spec.orientation === 'horizontal';
              const amount = horizontalBar ? x : y;
              const zeroLine = Boolean(current.baseline && amount[0] <= 0 && amount[1] >= 0);
              if (zeroLine !== current.zeroLine) {
                current.zeroLine = zeroLine;
                patch[horizontalBar ? 'yAxis' : 'xAxis'] = { axisLine: { show: zeroLine } };
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
          // Legend actions report the complete selection; getOption() would clone every data point.
          instance.on(event, (params: unknown) => {
            const selected = (params as { selected?: Record<string, boolean> } | undefined)?.selected;
            if (selected) setSelected({ ...selected });
            updateViewport();
          });
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
      if (chart.current?.signature && chart.current.spec && instance)
        savedView.current = {
          signature: chart.current.signature,
          rangeSignature: chartRangeSignature(chart.current.spec),
          state: chartViewState(instance)
        };
      instance?.dispose();
      chart.current = undefined;
    };
  }, [renderAttempt, artifact.spec.style?.renderer]);

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
  const legendSeries =
    'series' in displayed.spec ? displayed.spec.series : [{ name: labels.chartTitle(displayed.spec.kind) }];
  const legendPageCount = Math.max(1, Math.ceil(legendSeries.length / 25));
  const safeLegendPage = Math.min(legendPage, legendPageCount - 1);
  const legendStart = safeLegendPage * 25;
  async function saveImage(format: 'png' | 'svg'): Promise<void> {
    const current = chart.current;
    if (!current?.spec || exporting) return;
    const snapshot = displayed;
    setExporting(true);
    setExportError(undefined);
    try {
      const blob = await exportChartImage({
        spec: current.spec,
        theme,
        chrome: resolveChartChrome(theme, element.current ?? undefined),
        locale: labels.locale,
        width: current.instance.getWidth(),
        height: current.instance.getHeight(),
        state: chartViewState(current.instance),
        format
      });
      downloadBlob(
        blob,
        artifactDownloadName({ ...snapshot, title: snapshot.title ?? snapshot.spec.title }, format, 'chart')
      );
    } catch (error) {
      setExportError(labels.chartExportError(boundedErrorMessage(error)));
    } finally {
      setExporting(false);
    }
  }
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
      <div class="doc-chart-output__actions">
        <button
          ref={tableButton}
          type="button"
          aria-expanded={tableOpen}
          aria-controls={`${idPrefix}-data`}
          onClick={() => {
            setTableOpen((open) => !open);
            tableButton.current?.focus();
          }}
        >
          {tableOpen ? labels.hideChartData : labels.showChartData}
        </button>
        {displayed.spec.kind !== 'heatmap' && displayed.spec.dataZoom !== false ? (
          <button
            type="button"
            disabled={!isReady}
            onClick={() => chart.current?.instance.dispatchAction({ type: 'dataZoom', start: 0, end: 100 })}
          >
            {labels.resetZoom}
          </button>
        ) : null}
        <button type="button" disabled={exporting || !isReady} onClick={() => saveImage('png')}>
          {labels.savePng}
        </button>
        <button type="button" disabled={exporting || !isReady} onClick={() => saveImage('svg')}>
          {labels.saveSvg}
        </button>
      </div>
      {showLegend(displayed.spec) ? (
        <div class="doc-chart-output__legend" role="group" aria-label={labels.chartSeries}>
          {legendSeries.slice(legendStart, legendStart + 25).map((series, offset) => {
            const index = legendStart + offset;
            const id = chartSeriesId(displayed.spec, index);
            const appearance = chartSeriesPresentation(displayed.spec, index, theme);
            return (
              <button
                key={id}
                type="button"
                aria-pressed={selected[id] !== false}
                disabled={!isReady}
                onClick={() => chart.current?.instance.dispatchAction({ type: 'legendToggleSelect', name: id })}
              >
                <LegendSwatch {...appearance} kind={displayed.spec.kind} />
                {series.name?.trim() ? series.name : labels.chartSeriesName(index + 1)}
              </button>
            );
          })}
          {legendPageCount > 1 ? (
            <>
              <button
                type="button"
                disabled={safeLegendPage === 0}
                onClick={() => setLegendPage((page) => Math.max(0, Math.min(page, legendPageCount - 1) - 1))}
              >
                {labels.previousPage}
              </button>
              <button
                type="button"
                disabled={safeLegendPage + 1 >= legendPageCount}
                onClick={() => setLegendPage(safeLegendPage + 1)}
              >
                {labels.nextPage}
              </button>
            </>
          ) : null}
        </div>
      ) : null}
      {exportError ? (
        <p class="error-state" role="alert">
          {exportError}
        </p>
      ) : null}
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
      {table ? (
        <div id={`${idPrefix}-data`}>
          <TableOutput table={table} idPrefix={`${idPrefix}-table`} labels={labels} resultIdentity={displayed} />
        </div>
      ) : null}
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

function LegendSwatch({
  color,
  lineType,
  symbol,
  kind
}: ReturnType<typeof chartSeriesPresentation> & { kind: ChartSpec['kind'] }) {
  const line = kind === 'line' || kind === 'area';
  return (
    <svg aria-hidden="true" width="32" height="16" viewBox="0 0 32 16">
      {line ? (
        <line
          x1="1"
          x2="31"
          y1="8"
          y2="8"
          stroke={color}
          stroke-width="2"
          stroke-dasharray={lineType === 'dashed' ? '6 3' : lineType === 'dotted' ? '2 2' : undefined}
        />
      ) : null}
      {kind === 'bar' || symbol === 'rect' ? (
        <rect x="11" y="3" width="10" height="10" fill={color} />
      ) : symbol === 'triangle' ? (
        <polygon points="16,2 22,14 10,14" fill={color} />
      ) : symbol === 'diamond' ? (
        <polygon points="16,2 22,8 16,14 10,8" fill={color} />
      ) : symbol !== 'none' ? (
        <circle cx="16" cy="8" r="4" fill={symbol === 'emptyCircle' ? 'none' : color} stroke={color} />
      ) : null}
    </svg>
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
