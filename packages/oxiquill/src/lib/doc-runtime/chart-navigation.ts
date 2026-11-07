import { chartAxisType, chartIncludesZero } from './chart-axes.js';
import { chartCoordinates, numericBounds } from './chart-format.js';
import type { ChartRange } from './chart-link.js';
import type { ChartAxisType, ChartSpec } from './types.js';

export function chartZoomable(spec: ChartSpec): boolean {
  return spec.kind !== 'heatmap' && spec.dataZoom !== false;
}

export function chartNavigationAxis(spec: ChartSpec): 'x' | 'y' {
  return spec.kind === 'bar' && spec.orientation === 'horizontal' ? 'y' : 'x';
}

export function chartDomain(spec: ChartSpec, axis: 'x' | 'y' = 'x'): ChartRange | undefined {
  const type = chartAxisType(spec, axis);
  const values = chartCoordinates(spec)[axis];
  if (type === 'category') return values.length ? [0, values.length - 1] : undefined;
  const bounds = numericBounds(
    values.map((value) => (type === 'time' && typeof value === 'string' ? Date.parse(value) : value))
  );
  const includeZero = chartIncludesZero(spec, axis);
  const minimum =
    spec[axis === 'x' ? 'xMin' : 'yMin'] ?? (bounds && (includeZero ? Math.min(0, bounds.minimum) : bounds.minimum));
  const maximum =
    spec[axis === 'x' ? 'xMax' : 'yMax'] ?? (bounds && (includeZero ? Math.max(0, bounds.maximum) : bounds.maximum));
  return minimum !== undefined && maximum !== undefined ? [minimum, maximum] : undefined;
}

export function keyboardChartRange(
  key: string,
  visible: ChartRange,
  domain: ChartRange,
  type: ChartAxisType
): ChartRange | undefined {
  if (!['+', '=', '-', 'ArrowLeft', 'ArrowRight'].includes(key)) return undefined;
  const transform = type === 'log' ? Math.log : (value: number) => value;
  const invert = type === 'log' ? Math.exp : (value: number) => value;
  const [low, high] = domain.map(transform);
  const [start, end] = visible.map(transform);
  if (![low, high, start, end].every(Number.isFinite) || high <= low || end <= start) return undefined;
  if (!Number.isFinite(high - low) || !Number.isFinite(end - start)) return undefined;
  const factor = key === '+' || key === '=' ? 0.8 : key === '-' ? 1.25 : 1;
  const requestedSpan = (end - start) * factor;
  const span = Math.min(
    high - low,
    type === 'category' ? Math.max(1, factor < 1 ? Math.floor(requestedSpan) : Math.ceil(requestedSpan)) : requestedSpan
  );
  const pan = key === 'ArrowLeft' ? -0.1 : key === 'ArrowRight' ? 0.1 : 0;
  const offset =
    type === 'category' ? Math.sign(pan) * Math.max(1, Math.round((end - start) * Math.abs(pan))) : (end - start) * pan;
  const center = start + (end - start) / 2 + offset;
  const next = Math.max(low, Math.min(high - span, center - span / 2));
  return type === 'category' ? [Math.round(next), Math.round(next + span)] : [invert(next), invert(next + span)];
}
