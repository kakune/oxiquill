import type { BubbleChartSpec } from './types.js';
import { numericBounds } from './chart-format.js';

export function bubbleSizeMapping(spec: BubbleChartSpec) {
  const maximum =
    spec.sizeMapping?.maxValue ??
    (numericBounds(spec.series.flatMap((series) => series.points.map((point) => point[2])))?.maximum || 1);
  const minPixels = spec.sizeMapping?.minPixels ?? 0;
  const maxPixels = spec.sizeMapping?.maxPixels ?? 40;
  return {
    maximum,
    minPixels,
    maxPixels,
    diameter: (value: number) => {
      if (value === 0) return 0;
      const ratio = Math.min(value, maximum) / maximum;
      return Math.max(minPixels, maxPixels * (spec.sizeMapping?.scale === 'radius' ? ratio : Math.sqrt(ratio)));
    }
  };
}
