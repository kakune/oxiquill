import type { ChartSpec } from '../../packages/oxiquill/src/lib/doc-runtime/types';

const line = (values: number[], extra: Partial<ChartSpec> = {}): ChartSpec =>
  ({
    kind: 'line',
    xLabel: 'Observation',
    yLabel: 'Measured value',
    series: [{ points: values.map((y, x) => [x, y]) }],
    ...extra
  }) as ChartSpec;

export const chartFixtures: Record<string, ChartSpec> = {
  stackedBars: {
    kind: 'bar',
    categories: ['A', 'B', 'C'],
    series: [
      { name: 'First', stack: 'total', values: [2, -2, null] },
      { name: 'Second', stack: 'total', values: [3, -3, 4] }
    ]
  },
  stackedAreas: {
    kind: 'area',
    series: [
      {
        name: 'First',
        stack: 'total',
        points: [
          [0, 2],
          [1, -2],
          [2, 3]
        ]
      },
      {
        name: 'Second',
        stack: 'total',
        points: [
          [0, 3],
          [1, -3],
          [2, 1]
        ]
      }
    ]
  },
  horizontalBars: {
    kind: 'bar',
    orientation: 'horizontal',
    xLabel: 'Change',
    yLabel: 'Region',
    categories: ['North America (estimate)', 'South America (estimate)', 'Europe', 'Asia'],
    series: [{ values: [10, -3, 8, 6] }]
  },
  errorBars: {
    kind: 'errorbar',
    series: [
      {
        name: 'Estimate',
        points: [
          [0, -3, -5, -2],
          [1, 0, -2, 3],
          [2, 4, 3, 6]
        ]
      }
    ]
  },
  intervalBand: {
    kind: 'band',
    series: [
      {
        name: 'Interval',
        points: [
          [0, -3, -5, -2],
          [1, 0, -2, 3],
          [2, 4, 3, 6],
          [3, null, null, null],
          [4, 2, 1, 3]
        ]
      }
    ]
  },
  annotations: {
    kind: 'line',
    xMin: 0,
    xMax: 4,
    yMin: 0,
    yMax: 10,
    series: [
      {
        points: [
          [0, 2],
          [1, 3],
          [2, 8],
          [3, 7]
        ]
      }
    ],
    annotations: [
      { kind: 'line', axis: 'y', value: 5, label: 'Threshold' },
      { kind: 'range', axis: 'x', from: 1, to: 2, label: 'Window' }
    ]
  },
  divergingHeatmap: {
    kind: 'heatmap',
    colorScale: 'diverging',
    colorMin: -2,
    colorMax: 8,
    center: 0,
    data: [
      [0, 0, -2],
      [1, 0, 0],
      [2, 0, 8]
    ]
  },
  boxplot: {
    kind: 'boxplot',
    categories: ['First', 'Second', 'Constant'],
    series: [
      {
        name: 'Distribution',
        values: [
          [-5, -3, -2, 0, 4],
          [1, 2, 3, 4, 8],
          [2, 2, 2, 2, 2]
        ]
      }
    ]
  },
  bubble: {
    kind: 'bubble',
    sizeMapping: { maxValue: 100 },
    colorMapping: { min: 0, max: 10 },
    series: [
      {
        name: 'Observations',
        points: [
          [0, 2, 25, 2],
          [1, 3, 100, 8],
          [2, 1, 50, null]
        ]
      }
    ]
  },
  field: {
    kind: 'field',
    xEdges: [-3, -1, 0, 0.5, 2, 4],
    yEdges: [-2, -0.5, 0, 1, 3],
    values: Array.from({ length: 4 }, (_, y) => Array.from({ length: 5 }, (_, x) => Math.sin(x) * Math.cos(y)))
  },
  large: line([1e6, 1e7, 2.1e7]),
  tiny: line([0.000012, 0.000015, 0.000019]),
  extreme: line([1e15, 1e18, 3e20, 1e21]),
  logarithmic: line([1e-10, 1e-8, 1e-6], { yType: 'log' }),
  years: {
    kind: 'line',
    xLabel: 'Year',
    yLabel: 'Count',
    series: [{ points: Array.from({ length: 22 }, (_, i) => [1998 + i, i * 5]) }]
  },
  rounding: line([0.1 + 0.2, 0.5, 0.7]),
  narrow: line([1_000_000, 1_000_005, 1_000_010]),
  equal: line([42, 42, 42]),
  single: line([12]),
  negative: {
    kind: 'bar',
    categories: ['First', 'Second', 'Third'],
    xLabel: 'Category',
    yLabel: 'Change',
    series: [{ values: [-20, 0, 40] }]
  },
  baseline: {
    kind: 'bar',
    categories: ['First', 'Second', 'Third'],
    yLabel: 'count',
    series: [{ values: [100, 102, 105] }]
  },
  categories: {
    kind: 'bar',
    categories: [
      'North America (estimate)',
      'South America (estimate)',
      'Europe (estimate)',
      'Asia (estimate)',
      'Oceania (estimate)',
      'Africa (estimate)'
    ],
    xLabel: 'Region',
    yLabel: 'Count',
    series: [{ values: [1, 2, 3, 4, 5, 6] }]
  },
  unicode: {
    kind: 'bar',
    categories: [
      '日本語の長いカテゴリ名',
      '🧑🏽‍🔬 Laboratory measurements',
      'e\u0301'.repeat(12),
      '東京の測定結果',
      'Another category',
      'Last category'
    ],
    series: [{ values: [6, 5, 4, 3, 2, 1] }]
  },
  legend: {
    kind: 'line',
    title: 'Long series names',
    xLabel: 'Observation',
    yLabel: 'Measurement',
    series: Array.from({ length: 9 }, (_, i) => ({
      name: `A long descriptive name for measurement series ${i + 1}`,
      points: [
        [0, i],
        [1, i + 1],
        [2, i]
      ]
    }))
  },
  heatmap: {
    kind: 'heatmap',
    xLabel: 'Column',
    yLabel: 'Row',
    data: [
      [0, 0, 0],
      [1, 0, 0.857],
      [0, 1, 0.3],
      [1, 1, 0.7]
    ]
  },
  matrix: {
    kind: 'heatmap',
    xLabel: 'Sample column',
    yLabel: 'Sample row',
    xCategories: Array.from({ length: 30 }, (_, i) => `Column ${i + 1}`),
    yCategories: Array.from({ length: 12 }, (_, i) => `Row ${i + 1}`),
    data: Array.from({ length: 360 }, (_, i) => [i % 30, Math.floor(i / 30), i / 359])
  },
  time: {
    kind: 'line',
    xType: 'time',
    xLabel: 'Time (UTC)',
    yLabel: 'Count',
    series: [
      {
        points: [
          ['2024-03-10T06:30:00Z', 1],
          ['2024-03-10T07:30:00Z', 2],
          ['2024-03-11T00:30:00Z', 3]
        ]
      }
    ]
  },
  empty: line([]),
  unnamed: {
    kind: 'line',
    series: [
      {
        points: [
          [0, 1],
          [1, 2]
        ]
      },
      {
        points: [
          [0, 2],
          [1, 3]
        ]
      }
    ]
  },
  seriesIdentity: {
    kind: 'line',
    series: [
      {
        id: 'a',
        name: 'Same',
        points: [
          [0, 1],
          [1, 2]
        ],
        style: { smooth: true, symbol: 'diamond', showSymbol: true, color: { light: '#3987e5', dark: '#9085e9' } }
      },
      {
        id: 'b',
        name: 'Same',
        points: [
          [0, 2],
          [1, 1]
        ],
        style: { step: 'end', lineType: 'dashed' }
      }
    ]
  },
  formatted: line([1500, 2400], { style: { yFormat: { fractionDigits: 2, notation: 'si', unit: 'V' } } }),
  histogramDensity: {
    kind: 'histogram',
    mode: 'density',
    xLabel: 'Measurement',
    bins: [
      [-1, -0.5, 2],
      [0.1 + 0.2, 0.7, 3],
      [1, 3, 4]
    ]
  },
  histogramLog: {
    kind: 'histogram',
    yType: 'log',
    bins: [
      [0, 1, 0.1],
      [1, 2, 10]
    ]
  },
  histogram: {
    kind: 'histogram',
    xLabel: 'Bin',
    yLabel: 'Count',
    bins: [
      [0, 1, 500],
      [1, 2, 520],
      [2, 3, 550]
    ]
  },
  area: {
    kind: 'area',
    yLabel: 'Amount',
    series: [
      {
        points: [
          [0, 100],
          [1, 102],
          [2, 105]
        ]
      }
    ]
  }
};
