// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/components/doc-runtime/ChartOutput';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');

describe('zero-based amounts', () => {
  it.each([[100, 102, 105], [-100, -102, -105], [-100, 0, 105], [100]])(
    'preserves proportional bar lengths for %j',
    (...values) => {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
      try {
        chart.setOption(
          chartSpecToEChartsOptions({ kind: 'bar', categories: values.map(String), series: [{ values }] })
        );
        const origin = chart.convertToPixel({ yAxisIndex: 0 }, 0);
        const length = (value) => origin - chart.convertToPixel({ yAxisIndex: 0 }, value);
        for (const value of values)
          if (value) expect(length(value) / value).toBeCloseTo(length(values[0]) / values[0], 10);
        expect(origin).toBeGreaterThanOrEqual(0);
        expect(origin).toBeLessThanOrEqual(360);
      } finally {
        chart.dispose();
      }
    }
  );
  it.each(['bar', 'histogram'])('rejects time-valued %s amounts', (kind) => {
    const spec = kind === 'bar' ? { kind, categories: [], series: [] } : { kind, bins: [] };
    expect(validateOutputArtifacts([{ kind: 'chart', spec: { ...spec, yType: 'time' } }])[0]).toMatchObject({
      status: 'error'
    });
  });
  it.each(['line', 'scatter', 'area', 'bar', 'histogram'])('chooses the appropriate baseline for %s', (kind) => {
    const spec =
      kind === 'bar'
        ? { kind, categories: [], series: [] }
        : kind === 'histogram'
          ? { kind, bins: [] }
          : { kind, series: [] };
    expect(chartSpecToEChartsOptions(spec).yAxis.scale).toBe(kind === 'line' || kind === 'scatter');
    expect(chartSpecToEChartsOptions({ ...spec, yType: 'log' }).yAxis.scale).toBe(true);
  });
});
