import type { ChartSpec } from './types.js';
import { chartAxisType } from './chart-axes.js';
import { ArtifactValidationError } from './output-validation-common.js';

/** ECharts stacks numeric axes by index, so alignment must be checked before rendering. */
export function validateChartStacks(spec: ChartSpec): void {
  if (spec.kind !== 'bar' && spec.kind !== 'area') return;
  const groups = new Map<string, { x: readonly (number | string)[]; positive: number[]; negative: number[] }>();
  for (const series of spec.series) {
    if (!series.stack) continue;
    if (chartAxisType(spec, spec.kind === 'bar' && spec.orientation === 'horizontal' ? 'x' : 'y') !== 'value')
      throw new ArtifactValidationError('Stacked charts require a value axis for amounts.');
    const x =
      'points' in series
        ? series.points.map(([value]) =>
            spec.xType === 'time' && typeof value === 'string' ? Date.parse(value) : value
          )
        : spec.kind === 'bar'
          ? spec.categories
          : [];
    if (spec.kind === 'area') {
      if (spec.xType === 'category') {
        if (new Set(x.map(String)).size !== x.length)
          throw new ArtifactValidationError('Stacked area x coordinates must be unique.');
      } else if (x.some((value, index) => index > 0 && Number(value) <= Number(x[index - 1])))
        throw new ArtifactValidationError('Stacked area x coordinates must be strictly increasing.');
    }
    let group = groups.get(series.stack);
    if (!group) {
      group = { x, positive: Array<number>(x.length).fill(0), negative: Array<number>(x.length).fill(0) };
      groups.set(series.stack, group);
    }
    if (group.x.length !== x.length || x.some((value, index) => value !== group.x[index]))
      throw new ArtifactValidationError(
        `Stack group ${JSON.stringify(series.stack)} requires matching x coordinates and order.`
      );
    const values = 'points' in series ? series.points.map((point) => point[1]) : series.values;
    values.forEach((value, index) => {
      if (value === null) return;
      const total = Number(value) < 0 ? group.negative : group.positive;
      total[index] += Number(value);
      if (!Number.isFinite(total[index])) throw new ArtifactValidationError('Stacked chart totals must be finite.');
    });
  }
}
