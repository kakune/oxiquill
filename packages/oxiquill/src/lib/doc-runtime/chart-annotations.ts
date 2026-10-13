import type { ChartAnnotation, ChartSpec } from './types.js';
import type { ChartChrome } from './chart-options.js';
import { chartAxisType } from './chart-axes.js';
import { chartCoordinates, chartCoordinateFormatter, numericBounds } from './chart-format.js';
import type { RuntimeLabels } from './runtime-localization.js';

export const annotationSeriesId = 'oxiquill:annotations';

export function annotationDescription(
  spec: ChartSpec,
  annotation: ChartAnnotation,
  labels: RuntimeLabels,
  coordinates = chartCoordinates(spec)
): string {
  const values = coordinates[annotation.axis];
  const format = chartCoordinateFormatter(
    values,
    chartAxisType(spec, annotation.axis),
    labels.locale,
    false,
    spec.style?.[annotation.axis === 'x' ? 'xFormat' : 'yFormat']
  );
  const position =
    annotation.kind === 'line' ? format(annotation.value) : format(annotation.from) + '–' + format(annotation.to);
  return [annotation.label, annotation.axis.toUpperCase() + ': ' + position].filter(Boolean).join(': ');
}

/** A separate empty series keeps annotations independent of series visibility and axis extents. */
export function chartAnnotationSeries(
  spec: ChartSpec,
  chrome: ChartChrome,
  labels: RuntimeLabels,
  coordinates = chartCoordinates(spec)
): Record<string, unknown> | undefined {
  const amountAxis = spec.kind === 'bar' && spec.orientation === 'horizontal' ? 'x' : 'y';
  const bounds = numericBounds(coordinates[amountAxis]);
  const annotations = [...(spec.annotations ?? [])];
  // Field axes are spatial coordinates rather than amounts, so zero is not a baseline there.
  if (
    spec.kind !== 'field' &&
    chartAxisType(spec, amountAxis) === 'value' &&
    bounds &&
    bounds.minimum < 0 &&
    bounds.maximum > 0 &&
    !annotations.some((item) => item.kind === 'line' && item.axis === amountAxis && item.value === 0)
  )
    annotations.unshift({ kind: 'line', axis: amountAxis, value: 0, style: { width: 1.5 } });
  if (!annotations.length) return;
  const format = (annotation: ChartAnnotation) => () =>
    annotationDescription(spec, annotation, labels, coordinates).replace(
      /[&<>"']/gu,
      (value) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[value] ?? value
    );
  const lines = annotations
    .filter((item) => item.kind === 'line')
    .map((item) => ({
      [item.axis + 'Axis']: item.value,
      label: {
        show: Boolean(item.label),
        formatter: () => item.label ?? '',
        position: 'insideEndTop',
        color: chrome.text
      },
      lineStyle: {
        color: item.style?.color ?? chrome.axis,
        type: item.style?.lineType ?? 'solid',
        width: item.style?.width ?? 1.5
      },
      tooltip: { formatter: format(item) }
    }));
  const ranges = annotations
    .filter((item) => item.kind === 'range')
    .map((item) => [
      {
        [item.axis + 'Axis']: item.from,
        name: item.label ?? '',
        label: {
          show: Boolean(item.label),
          formatter: () => item.label ?? '',
          position: 'insideTop',
          color: chrome.text
        },
        itemStyle: { color: item.style?.color ?? chrome.axis, opacity: item.style?.opacity ?? 0.12 },
        tooltip: { formatter: format(item) }
      },
      { [item.axis + 'Axis']: item.to }
    ]);
  return {
    id: annotationSeriesId,
    name: annotationSeriesId,
    type: 'line',
    data: [],
    silent: spec.tooltip === false,
    markLine: { symbol: ['none', 'none'], animation: false, data: lines },
    markArea: { animation: false, data: ranges }
  };
}
