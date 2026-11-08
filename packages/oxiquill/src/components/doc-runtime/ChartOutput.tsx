import { chartItems, chartLineItems } from '../../lib/doc-runtime/chart-layers.js';
import { updatedColorSelection, selectedColorRange } from '../../lib/doc-runtime/chart-color-scale.js';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
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
import RuntimeDisclosure from './RuntimeDisclosure.js';
import {
  reconcileChartSelection,
  isolateChartSelection,
  visibleChartSeries,
  chartSelectionIds
} from '../../lib/doc-runtime/chart-selection.js';
import {
  applyChartViewState,
  chartViewState,
  exportChartImage,
  type ChartViewState
} from '../../lib/doc-runtime/chart-export.js';
import { artifactDownloadName, downloadBlob } from '../../lib/doc-runtime/download.js';
import { chartAxes, chartPointIndexes, hasIsolatedPoint } from '../../lib/doc-runtime/chart-viewport.js';
import { attachChartInteractions } from '../../lib/doc-runtime/chart-interactions.js';
import { chartZoomable } from '../../lib/doc-runtime/chart-navigation.js';
import { ArtifactError } from './ArtifactErrorBoundary.js';

export { chartDataSummary, chartSpecToEChartsOptions, chartStructuralSignature };
export type { ChartChrome, ChartTheme, EChartsOptions } from '../../lib/doc-runtime/chart-options.js';

interface ChartOutputProps {
  artifact: ChartArtifact;
  idPrefix: string;
  labels: RuntimeLabels;
  artifactIndex?: number;
  resultIdentity?: object;
}
import { loadECharts, type EChartsInstance } from '../../lib/doc-runtime/echarts-runtime.js';

export default function ChartOutput({
  artifact,
  idPrefix,
  labels,
  artifactIndex = 0,
  resultIdentity
}: ChartOutputProps) {
  const mountedIdentity = useRef({});
  const identity = resultIdentity ?? mountedIdentity.current;
  const selection = useRef({ identity, selected: {} as Record<string, boolean> });
  const [compact, setCompact] = useState(false);
  const figure = useRef<HTMLElement>(null);
  const focusBeforeLayout = useRef<Element | null>(null);
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
    updateViewport?: () => void;
    interactions?: ReturnType<typeof attachChartInteractions>;
  }>();
  const reducedMotion = useReducedMotion();
  const [displayed, setDisplayed] = useState(artifact);
  const [theme, setTheme] = useState<ChartTheme>(() => currentChartTheme());
  const latest = useRef({ artifact, reducedMotion, labels, theme, identity });
  latest.current = { artifact, reducedMotion, labels, theme, identity };
  const [renderError, setRenderError] = useState<{ message: string; initialization: boolean }>();
  const [renderAttempt, setRenderAttempt] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [isReady, setIsReady] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const tableButton = useRef<HTMLButtonElement>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [legendPage, setLegendPage] = useState(0);
  const table = useMemo(
    () => (tableOpen ? chartToTable(displayed.spec, labels, selected) : undefined),
    [tableOpen, displayed.spec, labels, selected]
  );
  const [exportError, setExportError] = useState<string>();
  const [disjoint, setDisjoint] = useState(false);
  const [linkFailure, setLinkFailure] = useState<{ artifact: ChartArtifact; message: string }>();
  const savedView = useRef<{
    signature: string;
    rangeSignature: string;
    spec: ChartSpec;
    state: ChartViewState;
    identity: object;
  }>();
  const dataSummary = useMemo(() => chartDataSummary(displayed.spec, labels), [displayed.spec, labels]);

  function rememberFocus(): void {
    const active = figure.current?.ownerDocument.activeElement;
    focusBeforeLayout.current = active && figure.current?.contains(active) ? active : null;
  }

  function applyLatest(force = false): void {
    const current = chart.current;
    if (!current) return;
    const {
      artifact: next,
      reducedMotion: motion,
      labels: nextLabels,
      theme: nextTheme,
      identity: nextIdentity
    } = latest.current;
    const width = element.current?.clientWidth || 720;
    const height = chartHeight(next.spec);
    try {
      if (
        force ||
        current.spec !== next.spec ||
        selection.current.identity !== nextIdentity ||
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
        if (
          notMerge &&
          current.spec?.kind === 'xy' &&
          next.spec.kind === 'xy' &&
          current.spec.xType === next.spec.xType &&
          current.spec.yType === next.spec.yType
        ) {
          const state = chartViewState(current.instance);
          delete state.symbols;
          if (chartRangeSignature(current.spec) !== chartRangeSignature(next.spec)) delete state.dataZoom;
          applyChartViewState(options, state);
        }
        if (!current.spec && savedView.current?.signature === signature) {
          const state = { ...savedView.current.state };
          if (savedView.current.rangeSignature !== chartRangeSignature(next.spec)) {
            delete state.dataZoom;
            delete state.symbols;
          }
          const range = updatedColorSelection(savedView.current.spec, next.spec, state.visualMap?.[0]?.range);
          if (range) state.visualMap = [{ range }];
          applyChartViewState(options, state);
        }
        const restoredSelection =
          !current.spec && savedView.current?.identity === nextIdentity
            ? savedView.current.state.legend?.[0]?.selected
            : undefined;
        const nextSelection = reconcileChartSelection(
          next.spec,
          selection.current.identity === nextIdentity
            ? (restoredSelection ??
                (options.legend as { selected?: Record<string, boolean> }).selected ??
                selection.current.selected)
            : undefined
        );
        options.legend = { ...(options.legend as Record<string, unknown>), selected: nextSelection };
        savedView.current = undefined;
        // Omit interactive state when merging a compatible chart.
        if (!notMerge && current.spec && chartRangeSignature(current.spec) === chartRangeSignature(next.spec))
          delete options.dataZoom;
        if (current.spec && options.visualMap) {
          const range = updatedColorSelection(current.spec, next.spec, selectedColorRange(current.instance));
          if (range) options.visualMap = { ...(options.visualMap as Record<string, unknown>), range };
        }
        current.instance.setOption(
          options,
          notMerge ? { notMerge: true } : { notMerge: false, lazyUpdate: true, replaceMerge: ['series'] }
        );
        selection.current = { identity: nextIdentity, selected: nextSelection };
        setSelected(nextSelection);
        current.signature = signature;
        current.spec = next.spec;
        try {
          current.interactions?.update(next.spec);
        } catch (error) {
          setLinkFailure({ artifact: next, message: boundedErrorMessage(error) });
          setIsReady(false);
          return;
        }
        current.reducedMotion = motion;
        current.theme = nextTheme;
        current.replace = false;
        current.width = width;
        current.height = height;
        current.locale = nextLabels.locale;
        current.symbols = undefined;
        current.indexes = undefined;
        const xAxis = options.xAxis as { data?: readonly unknown[] };
        const yAxis = options.yAxis as { data?: readonly unknown[] };
        current.counts = { x: xAxis.data?.length ?? 0, y: yAxis.data?.length ?? 0 };
        current.updateViewport?.();
      }
      rememberFocus();
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
    const restore = (event: PageTransitionEvent) => {
      if (event.persisted) setRenderAttempt((attempt) => attempt + 1);
    };
    globalThis.window?.addEventListener('pageshow', restore);
    return () => globalThis.window?.removeEventListener('pageshow', restore);
  }, []);

  useEffect(() => {
    const chartElement = element.current;
    if (!chartElement || linkFailure) return;
    setIsReady(false);
    const updateCompact = () => {
      const next = getComputedStyle(chartElement).getPropertyValue('--doc-chart-compact').trim() === '1';
      setCompact((previous) => {
        if (previous !== next) rememberFocus();
        return next;
      });
    };
    updateCompact();
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
        chart.current.interactions = attachChartInteractions(instance, chartElement, setDisjoint, () =>
          chart.current?.updateViewport?.()
        );
        const updateViewport = () => {
          if (frame !== undefined) return;
          frame = requestAnimationFrame(() => {
            frame = undefined;
            updateCompact();
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
              if (spec.kind === 'line' || spec.kind === 'area' || spec.kind === 'xy') {
                const lines = chartLineItems(spec);
                current.indexes ??= chartPointIndexes(spec, axes);
                const visible = current.indexes.map(
                  (index, seriesIndex) => lines[seriesIndex]?.style?.showSymbol ?? hasIsolatedPoint(index, x, y)
                );
                const signature = JSON.stringify(visible);
                if (current.symbols !== signature) {
                  const initial =
                    current.symbols === undefined &&
                    visible.every(
                      (show, index) => show === (lines[index]?.style?.showSymbol ?? lines[index]?.points.length === 1)
                    );
                  current.symbols = signature;
                  if (!initial)
                    patch.series = visible.flatMap((showSymbol, index) =>
                      lines[index] ? [{ id: chartSeriesId(spec, index), showSymbol }] : []
                    );
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
            if (selected && chart.current?.spec) {
              const next = reconcileChartSelection(chart.current.spec, selected);
              selection.current = { ...selection.current, selected: next };
              setSelected(next);
            }
            updateViewport();
          });
        }
        resizeObserver = new ResizeObserver(() => {
          resizePending = true;
          updateViewport();
        });
        resizeObserver.observe(chartElement);
        if (figure.current) resizeObserver.observe(figure.current);
        applyLatest(true);
      })
      .catch((error: unknown) => {
        if (!cancelled) setRenderError({ message: boundedErrorMessage(error), initialization: true });
      });
    const cleanup = () => {
      if (cancelled) return;
      cancelled = true;
      chartElement.ownerDocument.removeEventListener('astro:before-swap', cleanup);
      chartElement.ownerDocument.defaultView?.removeEventListener('pagehide', cleanup);
      if (frame !== undefined) cancelAnimationFrame(frame);
      resizeObserver?.disconnect();
      chart.current?.interactions?.dispose();
      if (chart.current?.signature && chart.current.spec && instance)
        savedView.current = {
          signature: chart.current.signature,
          rangeSignature: chartRangeSignature(chart.current.spec),
          spec: chart.current.spec,
          state: chartViewState(instance),
          identity: selection.current.identity
        };
      instance?.dispose();
      chart.current = undefined;
    };
    chartElement.ownerDocument.addEventListener('astro:before-swap', cleanup);
    chartElement.ownerDocument.defaultView?.addEventListener('pagehide', cleanup);
    return cleanup;
  }, [renderAttempt, artifact.spec.style?.renderer, linkFailure]);

  useEffect(() => {
    if (linkFailure && linkFailure.artifact !== artifact) setLinkFailure(undefined);
    applyLatest();
  }, [artifact, reducedMotion, labels, theme, identity]);
  const titleId = idPrefix + '-title';
  const captionId = displayed.caption ? idPrefix + '-caption' : undefined;
  const descriptionId = idPrefix + '-description';
  const artifactTitle = displayed.title?.trim() ? displayed.title : undefined;
  const specTitle = displayed.spec.title?.trim() ? displayed.spec.title : undefined;
  const authoredTitle = artifactTitle ?? specTitle;
  const title = authoredTitle ?? labels.chartTitle(displayed.spec.kind);
  const subtitle = artifactTitle && specTitle && artifactTitle !== specTitle ? specTitle : undefined;
  const legendSeries =
    displayed.spec.kind === 'xy' || 'series' in displayed.spec
      ? chartItems(displayed.spec)
      : [{ name: labels.chartTitle(displayed.spec.kind) }];
  const legendPageCount = Math.max(1, Math.ceil(legendSeries.length / 25));
  const safeLegendPage = Math.min(legendPage, legendPageCount - 1);
  const legendStart = safeLegendPage * 25;
  const totalSeries = chartSelectionIds(displayed.spec).length;
  const shownSeries = visibleChartSeries(displayed.spec, selected);
  const compactLegend = compact && legendSeries.length > 6;
  useLayoutEffect(() => {
    const active = focusBeforeLayout.current;
    focusBeforeLayout.current = null;
    if (active && !active.isConnected) tableButton.current?.focus();
  }, [compact, displayed]);
  function selectSeries(only?: string): void {
    const current = chart.current;
    if (!current?.spec || !isReady) return;
    const next = isolateChartSelection(current.spec, only);
    for (const visible of [true, false]) {
      const batch = Object.entries(next)
        .filter(([, selected]) => selected === visible)
        .map(([name]) => ({ name }));
      if (batch.length)
        current.instance.dispatchAction({ type: visible ? 'legendSelect' : 'legendUnSelect', batch }, { silent: true });
    }
    selection.current = { ...selection.current, selected: next };
    setSelected(next);
    current.updateViewport?.();
  }
  const legend = (
    <div class="doc-chart-output__legend" role="group" aria-label={labels.chartSeries}>
      <button type="button" disabled={!isReady} onClick={() => selectSeries()}>
        {labels.chartShowAll}
      </button>
      {legendSeries.slice(legendStart, legendStart + 25).map((series, offset) => {
        const index = legendStart + offset;
        const id = chartSeriesId(displayed.spec, index);
        const appearance = chartSeriesPresentation(displayed.spec, index, theme);
        const name = series.name?.trim() ? series.name : labels.chartSeriesName(index + 1);
        return (
          <div class="doc-chart-output__legend-entry" key={id}>
            <button
              type="button"
              aria-pressed={selected[id] !== false}
              disabled={!isReady}
              onClick={() => chart.current?.instance.dispatchAction({ type: 'legendToggleSelect', name: id })}
            >
              <LegendSwatch
                {...appearance}
                kind={displayed.spec.kind === 'xy' ? displayed.spec.layers[index].kind : displayed.spec.kind}
              />
              {name}
            </button>
            <button
              type="button"
              disabled={!isReady}
              aria-label={labels.chartOnlySeries(name)}
              onClick={() => selectSeries(id)}
            >
              {labels.chartOnly}
            </button>
          </div>
        );
      })}
      {legendPageCount > 1 ? (
        <>
          <button type="button" disabled={safeLegendPage === 0} onClick={() => setLegendPage(safeLegendPage - 1)}>
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
  );
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
  if (linkFailure)
    return (
      <ArtifactError message={labels.artifactError(artifactIndex + 1, labels.diagnosticDetail(linkFailure.message))} />
    );
  return (
    <figure
      ref={figure}
      class="doc-chart-output"
      aria-labelledby={titleId}
      aria-describedby={[captionId, descriptionId].filter(Boolean).join(' ')}
    >
      <figcaption>
        <strong id={titleId} class={authoredTitle ? undefined : 'doc-visually-hidden'}>
          {title}
        </strong>
        {subtitle ? <span>{subtitle}</span> : null}
        {displayed.caption ? <span id={captionId}>{displayed.caption}</span> : null}
      </figcaption>
      <div class="doc-chart-output__actions">
        <button
          ref={tableButton}
          type="button"
          aria-label={compact ? (tableOpen ? labels.hideChartData : labels.showChartData) : undefined}
          aria-expanded={tableOpen}
          aria-controls={`${idPrefix}-data`}
          onClick={() => {
            setTableOpen((open) => !open);
            tableButton.current?.focus();
          }}
        >
          {compact ? labels.chartCompactData : tableOpen ? labels.hideChartData : labels.showChartData}
        </button>
        {chartZoomable(displayed.spec) ? (
          <button type="button" disabled={!isReady} onClick={() => chart.current?.interactions?.reset()}>
            {compact ? labels.chartResetView : labels.resetZoom}
          </button>
        ) : null}
        {compact ? (
          <RuntimeDisclosure
            id={`${idPrefix}-exports`}
            label={labels.chartExport}
            disabled={!isReady}
            busy={exporting}
            overlay
          >
            {(close) => (
              <ul>
                {(['png', 'svg'] as const).map((format) => (
                  <li key={format}>
                    <button
                      type="button"
                      disabled={exporting || !isReady}
                      onClick={() => {
                        close();
                        void saveImage(format);
                      }}
                    >
                      {format === 'png' ? labels.savePng : labels.saveSvg}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </RuntimeDisclosure>
        ) : (
          <>
            <button type="button" disabled={exporting || !isReady} onClick={() => saveImage('png')}>
              {labels.savePng}
            </button>
            <button type="button" disabled={exporting || !isReady} onClick={() => saveImage('svg')}>
              {labels.saveSvg}
            </button>
          </>
        )}
      </div>
      {showLegend(displayed.spec) ? (
        compactLegend ? (
          <RuntimeDisclosure id={`${idPrefix}-series`} label={labels.chartSelectedSeries(shownSeries, totalSeries)}>
            {() => legend}
          </RuntimeDisclosure>
        ) : (
          legend
        )
      ) : null}
      {exportError ? (
        <p class="error-state" role="alert">
          {exportError}
        </p>
      ) : null}
      <div
        key="viewport"
        class="doc-chart-output__viewport"
        role={chartZoomable(displayed.spec) ? 'group' : undefined}
        tabIndex={chartZoomable(displayed.spec) ? 0 : undefined}
        aria-labelledby={titleId}
        aria-describedby={chartZoomable(displayed.spec) ? `${idPrefix}-keyboard` : undefined}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          if (chart.current?.interactions?.key(event.key)) event.preventDefault();
        }}
      >
        <div
          ref={element}
          class="doc-plot"
          style={{ height: chartHeight(displayed.spec) }}
          aria-hidden="true"
          data-chart-theme={theme}
          data-chart-motion={reducedMotion ? 'reduced' : 'full'}
          data-testid="doc-plot"
        />
        {totalSeries > 0 && shownSeries === 0 ? (
          <p class="doc-chart-output__empty" role="status">
            {labels.noChartData}
          </p>
        ) : null}
      </div>
      {chartZoomable(displayed.spec) ? (
        <p id={`${idPrefix}-keyboard`} class="doc-visually-hidden">
          {labels.chartKeyboardInstructions}
        </p>
      ) : null}
      <p class="doc-visually-hidden" role="status" aria-live="polite">
        {disjoint ? labels.chartNoDataInRange : ''}
      </p>
      <p id={descriptionId} class="doc-chart-output__summary">
        <span class="doc-visually-hidden">{labels.chartCaption}: </span>
        {dataSummary} {labels.chartSeriesVisibility(shownSeries, totalSeries)}
      </p>
      {table ? (
        <div id={`${idPrefix}-data`}>
          <TableOutput
            table={table}
            idPrefix={`${idPrefix}-table`}
            labels={labels}
            resultIdentity={selection.current.identity}
          />
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
