import { describe, expect, it } from 'vitest';
import { chartPalette, heatmapPalette } from '../../packages/oxiquill/src/lib/doc-runtime/chart-palette';
import {
  chartSeriesPresentation,
  chartSpecToEChartsOptions
} from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';

const linear = (value: number) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
const rgb = (color: string) => [1, 3, 5].map((index) => linear(parseInt(color.slice(index, index + 2), 16) / 255));
const dot = (a: readonly number[], b: readonly number[]) => a.reduce((sum, value, index) => sum + value * b[index], 0);
// https://bottosson.github.io/posts/oklab/
function oklab(color: readonly number[]) {
  const lms = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005]
  ].map((row) => Math.cbrt(dot(row, color)));
  return [
    [0.2104542553, 0.793617785, -0.0040720468],
    [1.9779984951, -2.428592205, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.808675766]
  ].map((row) => dot(row, lms));
}
// Machado, Oliveira and Fernandes (2009), severity 1.0, linear sRGB.
// https://doi.org/10.1109/TVCG.2009.113
const simulations = [
  [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998]
  ],
  [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881]
  ],
  [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039]
  ]
];
const delta = (a: readonly number[], b: readonly number[]) =>
  100 * Math.hypot(...a.map((value, index) => value - b[index]));
const luminance = (color: readonly number[]) => dot(color, [0.2126, 0.7152, 0.0722]);

describe('fixed chart palette', () => {
  it.each(['#fefefe', '#181a1e'])('meets the contrast and perceptual budgets on %s', (background) => {
    const colors = chartPalette.map(rgb);
    const lab = colors.map(oklab);
    const backgroundLuminance = luminance(rgb(background));
    colors.forEach((color, index) => {
      const lightness = luminance(color);
      expect(
        (Math.max(lightness, backgroundLuminance) + 0.05) / (Math.min(lightness, backgroundLuminance) + 0.05)
      ).toBeGreaterThanOrEqual(3);
      expect(lab[index][0]).toBeGreaterThanOrEqual(0.5);
      expect(lab[index][0]).toBeLessThanOrEqual(0.7);
      const chroma = Math.hypot(lab[index][1], lab[index][2]);
      expect(chroma).toBeGreaterThanOrEqual(0.12);
      expect(chroma).toBeLessThanOrEqual(0.2);
      expect(delta(lab[index], lab[(index + 1) % lab.length])).toBeGreaterThanOrEqual(15);
    });
    simulations.forEach((matrix) => {
      const simulated = colors.map((color) => oklab(matrix.map((row) => Math.max(0, Math.min(1, dot(row, color))))));
      simulated.forEach((color, index) =>
        expect(delta(color, simulated[(index + 1) % simulated.length])).toBeGreaterThanOrEqual(8)
      );
    });
  });
  it.each(['light', 'dark'] as const)('keeps the %s heatmap ramp monotone and approximately one hue', (theme) => {
    const [first, last] = heatmapPalette[theme].map(rgb);
    const ramp = Array.from({ length: 21 }, (_, index) =>
      oklab(first.map((value, channel) => value + ((last[channel] - value) * index) / 20))
    );
    const direction = Math.sign(ramp[20][0] - ramp[0][0]);
    for (let i = 1; i < ramp.length; i++) expect((ramp[i][0] - ramp[i - 1][0]) * direction).toBeGreaterThan(0);
    const hues = ramp.map((color) => Math.atan2(color[2], color[1]));
    expect(Math.max(...hues) - Math.min(...hues)).toBeLessThan(0.2);
  });
  it('adds line and symbol differences on palette reuse', () => {
    const series = Array.from({ length: 16 }, () => ({
      points: [
        [0, 1],
        [1, 2]
      ] as const
    }));
    const lines = chartSpecToEChartsOptions({ kind: 'line', series }).series;
    expect(lines[0]).toMatchObject({ lineStyle: { type: 'solid' } });
    expect(lines[8]).toMatchObject({ lineStyle: { type: 'dashed' } });
    const points = chartSpecToEChartsOptions({ kind: 'scatter', series }).series;
    expect(points[0].symbol).toBe('circle');
    expect(points[8].symbol).toBe('rect');
  });

  it.each(['line', 'area', 'scatter'] as const)('describes %s legend swatches with the rendered symbols', (kind) => {
    const spec = {
      kind,
      series: [{ points: [[0, 1]] as const }, { points: [[1, 2]] as const, style: { symbol: 'diamond' as const } }]
    };
    const rendered = chartSpecToEChartsOptions(spec).series;
    expect([0, 1].map((index) => chartSeriesPresentation(spec, index, 'light').symbol)).toEqual(
      rendered.map((series) => series.symbol)
    );
  });
});
