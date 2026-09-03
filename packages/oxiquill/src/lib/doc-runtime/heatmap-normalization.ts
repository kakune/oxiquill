import type { HeatmapChartSpec } from './types.js';

export interface NormalizedHeatmapSpec {
  data: readonly (readonly [string, string, number])[];
  xCategories: readonly string[];
  yCategories: readonly string[];
}

type HeatmapCoordinate = HeatmapChartSpec['data'][number][0];

export function normalizeHeatmapSpec(spec: HeatmapChartSpec): NormalizedHeatmapSpec {
  const xAxis = heatmapAxisNormalizer(spec.xCategories);
  const yAxis = heatmapAxisNormalizer(spec.yCategories);
  const data = spec.data.map(([x, y, value]) => [xAxis.normalize(x), yAxis.normalize(y), value] as const);

  return {
    data,
    xCategories: xAxis.categories,
    yCategories: yAxis.categories
  };
}

function heatmapAxisNormalizer(explicitCategories?: readonly string[]): {
  categories: readonly string[];
  normalize: (coordinate: HeatmapCoordinate) => string;
} {
  if (explicitCategories) {
    return {
      categories: explicitCategories,
      normalize: (coordinate) => {
        if (typeof coordinate === 'string') return coordinate;
        const category = explicitCategories[coordinate];
        if (category == null) throw new Error('Validated heatmap category index is out of range.');
        return category;
      }
    };
  }

  const categories: string[] = [];
  const categoryNames = new Set<string>();
  return {
    categories,
    normalize: (coordinate) => {
      const category = String(coordinate);
      if (!categoryNames.has(category)) {
        categoryNames.add(category);
        categories.push(category);
      }
      return category;
    }
  };
}
