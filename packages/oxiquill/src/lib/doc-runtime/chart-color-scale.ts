import type { ChartSpec, HeatmapChartSpec } from './types.js';
import { numericBounds } from './chart-format.js';
import { ArtifactValidationError } from './output-validation-common.js';

export function heatmapColorScale(spec: HeatmapChartSpec) {
  const bounds = numericBounds(spec.data.map((point) => point[2]));
  const diverging = spec.colorScale === 'diverging';
  const center = spec.center ?? 0;
  const radius = bounds
    ? Math.min(Number.MAX_VALUE, Math.max(Math.abs(bounds.minimum - center), Math.abs(bounds.maximum - center))) ||
      Math.max(1, Math.abs(center) * 1e-6)
    : Math.max(1, Math.abs(center) * 1e-6);
  const min = spec.colorMin ?? (diverging ? Math.max(-Number.MAX_VALUE, center - radius) : (bounds?.minimum ?? 0));
  const max = spec.colorMax ?? (diverging ? Math.min(Number.MAX_VALUE, center + radius) : (bounds?.maximum ?? 1));
  if (min > max || (min === max && (spec.colorMin !== undefined || spec.colorMax !== undefined)))
    throw new ArtifactValidationError('Heatmap colorMin must be smaller than colorMax.');
  if (diverging && !(min < center && center < max))
    throw new ArtifactValidationError('Heatmap center must lie strictly inside the color range.');
  // Half differences avoid overflow for valid finite bounds spanning both extremes.
  const map = (value: number) =>
    !diverging
      ? value
      : value <= center
        ? -Math.min(
            1,
            Math.max(0, fraction(center - value, center - min, center / 2 - value / 2, center / 2 - min / 2))
          )
        : Math.min(
            1,
            Math.max(0, fraction(value - center, max - center, value / 2 - center / 2, max / 2 - center / 2))
          );
  const unmap = (value: number) =>
    !diverging ? value : (1 - Math.abs(value)) * center + Math.abs(value) * (value < 0 ? min : max);
  return { min, max, map, unmap, visualMin: diverging ? -1 : min, visualMax: diverging ? 1 : max };
}

function colorSignature(spec: ChartSpec): string {
  return JSON.stringify(
    spec.kind === 'heatmap'
      ? [spec.colorScale ?? 'sequential', spec.colorMin, spec.colorMax, spec.center]
      : spec.kind === 'bubble'
        ? [spec.colorMapping?.min, spec.colorMapping?.max]
        : [spec.kind]
  );
}

function fraction(distance: number, span: number, halfDistance: number, halfSpan: number): number {
  return Number.isFinite(span) ? distance / span : halfDistance / halfSpan;
}

function colorDomain(spec: ChartSpec) {
  if (spec.kind === 'heatmap') return heatmapColorScale(spec);
  const bounds =
    spec.kind === 'bubble' ? spec.colorMapping : spec.kind === 'field' ? numericBounds(spec.values.flat()) : undefined;
  if (!bounds) return;
  const min = 'min' in bounds ? bounds.min : bounds.minimum;
  const max = 'max' in bounds ? bounds.max : bounds.maximum;
  return { min, max, visualMin: min, visualMax: max, map: (value: number) => value, unmap: (value: number) => value };
}

/** Preserve selected data values when an automatic diverging domain changes. */
export function updatedColorSelection(
  previous: ChartSpec,
  next: ChartSpec,
  selected?: readonly number[]
): number[] | undefined {
  const before = colorDomain(previous);
  const after = colorDomain(next);
  if (!before || !after) return;
  const full = [after.visualMin, after.visualMax];
  if (colorSignature(previous) !== colorSignature(next)) return full;
  if (!selected || selected.length !== 2) return;
  if (selected[0] === before.visualMin && selected[1] === before.visualMax) return full;
  const lower = before.unmap(selected[0]);
  const upper = before.unmap(selected[1]);
  if (upper < after.min || lower > after.max) return full;
  return [after.map(Math.max(after.min, lower)), after.map(Math.min(after.max, upper))];
}

/** Read only the small visual-map state, without cloning chart data through getOption(). */
export function selectedColorRange(instance: unknown): number[] | undefined {
  const chart = instance as {
    getModel?: () => { getComponent?: (type: string) => { getSelected?: () => number[] } | undefined };
  };
  return chart.getModel?.().getComponent?.('visualMap')?.getSelected?.();
}
