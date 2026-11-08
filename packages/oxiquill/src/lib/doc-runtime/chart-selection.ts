import { chartItems } from './chart-layers.js';
import { chartSeriesId } from './chart-options.js';
import type { ChartSpec } from './types.js';

export type ChartSelection = Readonly<Record<string, boolean>>;

/** Scalar charts have one selectable legend entry, even without a series collection. */
export function chartSelectionIds(spec: ChartSpec): string[] {
  return Array.from({ length: 'series' in spec || spec.kind === 'xy' ? chartItems(spec).length : 1 }, (_, index) =>
    chartSeriesId(spec, index)
  );
}

/** Drop vanished IDs and make new IDs visible. Never copy chart data to change a view. */
export function reconcileChartSelection(spec: ChartSpec, previous: ChartSelection = {}): Record<string, boolean> {
  return Object.fromEntries(chartSelectionIds(spec).map((id) => [id, previous[id] !== false]));
}

export function isolateChartSelection(spec: ChartSpec, only?: string): Record<string, boolean> {
  return Object.fromEntries(chartSelectionIds(spec).map((id) => [id, only === undefined || id === only]));
}

export function visibleChartSeries(spec: ChartSpec, selected: ChartSelection): number {
  return chartSelectionIds(spec).filter((id) => selected[id] !== false).length;
}
