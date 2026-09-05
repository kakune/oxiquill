import { describe, expect, expectTypeOf, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import type {
  AreaChartSpec,
  BarChartSpec,
  ChartSpec,
  LineChartStyle,
  ScatterChartSpec,
  ScatterChartStyle
} from '../../packages/oxiquill/src/lib/doc-runtime/types';

const specs: ChartSpec[] = [
  { kind: 'line', series: [] },
  { kind: 'area', series: [] },
  { kind: 'scatter', series: [] },
  { kind: 'bar', categories: [], series: [] },
  { kind: 'histogram', bins: [] },
  { kind: 'heatmap', data: [] }
];
function validate(style: unknown, spec: ChartSpec = specs[0]) {
  return validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, style } }])[0];
}

describe('curated chart styles', () => {
  it('exports the kind-specific public types', () => {
    expectTypeOf<AreaChartSpec['style']>().toEqualTypeOf<LineChartStyle | undefined>();
    expectTypeOf<ScatterChartSpec['style']>().toEqualTypeOf<ScatterChartStyle | undefined>();
    expectTypeOf<NonNullable<BarChartSpec['style']>>().not.toHaveProperty('lineWidth');
  });

  it.each(specs)('accepts common styles for $kind and accounts for style bytes', (spec) => {
    const style = {
      palette: { light: ['#ABC', '#123456'], dark: ['#000', '#fff'] },
      showGrid: false,
      animation: false,
      animationDurationMs: 2000
    };
    const result = validate(style, spec);
    expect(result).toMatchObject({ status: 'valid', artifact: { spec: { style } } });
    const plain = validateOutputArtifacts([{ kind: 'chart', spec }])[0];
    if (result.status === 'valid' && plain.status === 'valid') {
      expect(result.byteLength - plain.byteLength).toBe(
        new TextEncoder().encode(',"style":' + JSON.stringify(style)).length
      );
    }
    expect(validate({}, spec).status).toBe('valid');
  });

  it.each([
    ['animationDurationMs', 0, 2000, specs[0]],
    ['lineWidth', 1, 8, specs[0]],
    ['lineWidth', 1, 8, specs[1]],
    ['symbolSize', 2, 32, specs[2]]
  ] as const)('checks exact %s bounds', (field, minimum, maximum, spec) => {
    for (const value of [minimum, maximum, (minimum + maximum) / 2])
      expect(validate({ [field]: value }, spec).status).toBe('valid');
    for (const value of [minimum - 0.001, maximum + 0.001, NaN, Infinity, -Infinity, null, '2', undefined]) {
      expect(validate({ [field]: value }, spec).status).toBe('error');
    }
    if (field === 'animationDurationMs') expect(validate({ [field]: 1.5 }, spec).status).toBe('error');
  });

  it.each(specs)('rejects inapplicable and unknown fields for $kind', (spec) => {
    for (const field of ['formatter', 'html', 'options', 'smooth'])
      expect(validate({ [field]: true }, spec).status).toBe('error');
    if (spec.kind !== 'line' && spec.kind !== 'area') expect(validate({ lineWidth: 2 }, spec).status).toBe('error');
    if (spec.kind !== 'scatter') expect(validate({ symbolSize: 7 }, spec).status).toBe('error');
  });

  it('rejects unsafe nested records and all invalid palette forms', () => {
    for (const style of [
      null,
      undefined,
      [],
      'blue',
      { animation: 1 },
      { showGrid: 'true' },
      { palette: {} },
      { palette: { light: [] } },
      { palette: { light: ['red'] } },
      { palette: { light: ['#abcd'] } },
      { palette: { light: ['#ABC', '#aabbcc'] } },
      { palette: { light: ['#123'], extra: [] } },
      { palette: { light: ['#123'], dark: null } },
      { [Symbol('extra')]: true },
      Object.create({ animation: true }),
      { palette: Object.create({ light: ['#123'] }) },
      { palette: { light: Array(2) } },
      { palette: { light: ['#1234567'] } },
      { palette: { light: Array.from({ length: 13 }, (_, index) => '#' + index.toString(16).padStart(6, '0')) } }
    ]) {
      expect(validate(style).status).toBe('error');
    }
    let reads = 0;
    const accessor = Object.defineProperty({}, 'animation', {
      get: () => {
        reads += 1;
        return true;
      }
    });
    expect(validate(accessor).status).toBe('error');
    expect(reads).toBe(0);
    expect(validate({ palette: { light: ['#123'] } }).status).toBe('valid');
    expect(validate({ palette: { dark: ['#123'] } }).status).toBe('valid');
    expect(validate({ palette: { light: ['#123'] } }, specs[5]).status).toBe('error');
    expect(
      validate({
        palette: { light: Array.from({ length: 12 }, (_, index) => '#' + index.toString(16).padStart(6, '0')) }
      }).status
    ).toBe('valid');
  });
});
