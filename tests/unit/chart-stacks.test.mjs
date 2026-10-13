// @vitest-environment node
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { chartSpecToEChartsOptions } from '../../packages/oxiquill/src/lib/doc-runtime/chart-options';
const echarts = createRequire(resolve('packages/oxiquill/package.json'))('echarts');
const validate = (spec) => validateOutputArtifacts([{ kind: 'chart', spec }])[0];

describe('stacked chart groups', () => {
  for (const kind of ['bar', 'area']) {
    const spec = (values) => ({
      kind,
      ...(kind === 'bar' ? { categories: ['A', 'B'] } : {}),
      series: values.map((row) => ({
        stack: 'total',
        ...(kind === 'bar' ? { values: row } : { points: row.map((y, x) => [x, y]) })
      }))
    });
    it.each([
      [
        [2, -2],
        [3, -3]
      ],
      [
        [0, 0],
        [0, 0]
      ],
      [
        [2, 4],
        [3, 1]
      ],
      [
        [-2, -4],
        [-3, -1]
      ]
    ])(`renders ${kind} from separate signed baselines: %j`, (...rows) => {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
      try {
        const artifact = validate(spec(rows));
        expect(artifact.status).toBe('valid');
        chart.setOption(chartSpecToEChartsOptions(artifact.artifact.spec));
        const data = chart.getModel().getSeriesByIndex(1).getData();
        const dimension = data.getCalculationInfo('stackResultDimension');
        expect([data.get(dimension, 0), data.get(dimension, 1)]).toEqual(
          rows[0].map((value, index) => value + rows[1][index])
        );
        expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
      } finally {
        chart.dispose();
      }
    });
    it(`recomputes ${kind} stacks when series and groups change`, () => {
      const chart = echarts.init(null, null, { renderer: 'svg', ssr: true, width: 720, height: 360 });
      try {
        const initial = spec([
          [2, 3],
          [3, 4]
        ]);
        chart.setOption(chartSpecToEChartsOptions(initial));
        chart.setOption(chartSpecToEChartsOptions(spec([[2, 3]])), { replaceMerge: ['series'] });
        expect(chart.getModel().getSeries()).toHaveLength(1);
        for (const series of initial.series) delete series.stack;
        chart.setOption(chartSpecToEChartsOptions(initial), { replaceMerge: ['series'] });
        expect(chart.getModel().getSeries()).toHaveLength(2);
        expect(
          chart.getModel().getSeriesByIndex(1).getData().getCalculationInfo('stackResultDimension')
        ).toBeUndefined();
        expect(chart.renderToSVGString()).not.toMatch(/NaN|Infinity/);
      } finally {
        chart.dispose();
      }
    });
    it(`rejects invalid ${kind} groups and overflow`, () => {
      expect(validate({ ...spec([[2, 3]]), yType: 'log' }).status).toBe('error');
      const empty = spec([[1, 2]]);
      empty.series[0].stack = ' ';
      expect(validate(empty).status).toBe('error');
      expect(
        validate(
          spec([
            [Number.MAX_VALUE, 1],
            [Number.MAX_VALUE, 1]
          ])
        ).status
      ).toBe('error');
    });
  }
  it('retains null bars and independent groups', () => {
    const spec = {
      kind: 'bar',
      categories: ['A'],
      series: [{ stack: 'a', values: [null] }, { stack: 'b', values: [2] }, { values: [3] }]
    };
    expect(validate(spec)).toMatchObject({ status: 'valid', artifact: { spec } });
    expect(chartSpecToEChartsOptions(spec).series.map((s) => s.stack)).toEqual(['a', 'b', '']);
  });
  it('checks area alignment, uniqueness, ordering, empty groups, and UTC instants', () => {
    const spec = {
      kind: 'area',
      series: [
        {
          stack: 'a',
          points: [
            [0, 1],
            [1, 2]
          ]
        },
        { stack: 'a', points: [[0, 2]] }
      ]
    };
    expect(validate(spec).status).toBe('error');
    for (const x of [0, -1])
      expect(
        validate({
          ...spec,
          series: [
            {
              stack: 'a',
              points: [
                [0, 1],
                [x, 2]
              ]
            }
          ]
        }).status
      ).toBe('error');
    expect(
      validate({
        ...spec,
        xType: 'category',
        series: [
          {
            stack: 'a',
            points: [
              ['A', 1],
              ['A', 2]
            ]
          }
        ]
      }).status
    ).toBe('error');
    expect(
      validate({
        ...spec,
        series: [
          { stack: 'a', points: [] },
          { stack: 'a', points: [] }
        ]
      }).status
    ).toBe('valid');
    expect(
      validate({
        kind: 'area',
        xType: 'time',
        series: [
          { stack: 'a', points: [[0, 1]] },
          { stack: 'a', points: [['1970-01-01T00:00:00Z', 2]] }
        ]
      }).status
    ).toBe('valid');
    expect(validate({ kind: 'line', series: [{ stack: 'a', points: [] }] }).status).toBe('error');
  });
});
