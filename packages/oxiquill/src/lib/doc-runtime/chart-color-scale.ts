import type { HeatmapChartSpec } from './types.js';
import { numericBounds } from './chart-format.js';
import { ArtifactValidationError } from './output-validation-common.js';

export function heatmapColorScale(spec: HeatmapChartSpec) {
  const bounds = numericBounds(spec.data.map((point) => point[2]));
  const diverging = spec.colorScale === 'diverging';
  const center = spec.center ?? 0;
  const radius = bounds
    ? Math.min(Number.MAX_VALUE, Math.max(Math.abs(bounds.minimum - center), Math.abs(bounds.maximum - center))) || 1
    : 1;
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

export function heatmapColorSignature(spec: HeatmapChartSpec): string {
  return JSON.stringify([spec.colorScale ?? 'sequential', spec.colorMin, spec.colorMax, spec.center]);
}

function fraction(distance: number, span: number, halfDistance: number, halfSpan: number): number {
  return Number.isFinite(span) ? distance / span : halfDistance / halfSpan;
}
