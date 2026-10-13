import type { ChartSpec } from '@chart-source/lib/doc-runtime/types';
import { render } from 'preact';
import { useState } from 'preact/hooks';
import ChartOutput from '@chart-source/components/doc-runtime/ChartOutput';
import TableOutput from '@chart-source/components/doc-runtime/TableOutput';
import { labelsForLanguage } from '@chart-source/lib/doc-runtime/runtime-localization';
import * as echarts from 'echarts/core';
import { chartFixtures } from '@chart-fixtures';
import '@starlight-props';
import '@chart-source/styles/custom.css';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') ?? 'light';
document.body.style.cssText =
  'margin:0;background:var(--sl-color-bg);color:var(--sl-color-text);font-family:system-ui,sans-serif';
const locale = query.get('locale') === 'ja' ? 'ja' : 'en';
const width = Number(query.get('width') ?? 720);

function Gallery() {
  const [revision, setRevision] = useState(0);
  const [clearAnnotations, setClearAnnotations] = useState(false);
  const [formatted, setFormatted] = useState(true);
  const [reordered, setReordered] = useState(false);
  const [range, setRange] = useState<'fixed' | 'changed' | 'auto'>('fixed');
  return (
    <main style={{ width }}>
      {query.get('fixture') === 'table-precision' ? (
        <TableOutput
          labels={labelsForLanguage(locale)}
          table={{
            kind: 'table',
            title: 'Numeric precision',
            columns: [
              { key: 'year', label: 'Year', type: 'integer' },
              { key: 'value', label: 'Value', type: 'number' }
            ],
            rows: [123456789, 2024, 9007199254740991, 0.30000000000000004, 1e21, 1e-7, -0].map((value, index) => [
              2024 + index,
              value
            ])
          }}
        />
      ) : null}
      <button onClick={() => setClearAnnotations(true)}>Clear annotations</button>
      <button onClick={() => setRange('changed')}>Change range</button>
      <button onClick={() => setRange('auto')}>Clear range</button>
      <button onClick={() => setReordered(true)}>Reorder and rename series</button>
      <button onClick={() => setFormatted(false)}>Clear formatting</button>
      <button onClick={() => setRevision((value) => value + 1)}>Update data</button>
      {Object.entries(chartFixtures)
        .filter(([name]) => !query.has('fixture') || query.get('fixture') === name)
        .map(([name, spec]) => (
          <section id={name} key={name}>
            <h2>{name}</h2>
            <ChartOutput
              artifact={{
                kind: 'chart',
                title: query.get('artifactTitle') ?? undefined,
                spec: {
                  ...updatedChart(spec, revision),
                  ...(clearAnnotations ? { annotations: [] } : {}),
                  ...(query.get('renderer') === 'svg' ? { style: { ...spec.style, renderer: 'svg' as const } } : {}),
                  ...(query.has('fixedRange')
                    ? range === 'auto'
                      ? { yMin: undefined, yMax: undefined }
                      : { yMin: 0, yMax: range === 'changed' ? 200 : 120 }
                    : {}),
                  ...(!formatted ? { style: undefined } : {}),
                  ...(revision ? { title: `Updated ${name}` } : {}),
                  ...(query.has('specTitle') ? { title: query.get('specTitle') ?? '' } : {}),
                  ...(query.has('longText')
                    ? { title: 'T'.repeat(16000), xLabel: 'X'.repeat(16000), yLabel: 'Y'.repeat(16000) }
                    : {}),
                  ...(spec.kind === 'line'
                    ? {
                        series: (reordered ? spec.series.toReversed() : spec.series).map((series) => ({
                          ...series,
                          ...(reordered ? { name: series.id === 'a' ? 'Renamed' : series.name, style: undefined } : {}),
                          points: series.points.map(([x, y]) => [x, typeof y === 'number' ? y + revision : y] as const)
                        }))
                      }
                    : {})
                },
                caption: query.get('caption') === 'none' ? undefined : `Revision ${revision}`
              }}
              idPrefix={name}
              labels={labelsForLanguage(locale)}
            />
          </section>
        ))}
    </main>
  );
}

Object.assign(window, { galleryECharts: echarts, galleryFixtureCount: Object.keys(chartFixtures).length });
const app = document.getElementById('app');
if (app) render(<Gallery />, app);

function updatedChart(spec: ChartSpec, revision: number): ChartSpec {
  if (!revision) return spec;
  switch (spec.kind) {
    case 'bar':
      return {
        ...spec,
        series: spec.series.map((series) => ({
          ...series,
          values: series.values.map((value) => (value === null ? null : value * (1 + revision / 10)))
        }))
      };
    case 'area':
      return {
        ...spec,
        series: spec.series.map((series) => ({
          ...series,
          points: series.points.map(([x, y]) => [x, Number(y) + revision] as const)
        }))
      };
    case 'errorbar':
    case 'band':
      return {
        ...spec,
        series: spec.series.map((series) => ({
          ...series,
          points: series.points.map(([x, center, lower, upper]) =>
            center === null
              ? ([x, null, null, null] as const)
              : ([x, center + revision, lower + revision, upper + revision] as const)
          )
        }))
      };
    case 'boxplot':
      return {
        ...spec,
        series: spec.series.map((series) => ({
          ...series,
          values: series.values.map((value) =>
            value === null
              ? null
              : ([
                  value[0] + revision,
                  value[1] + revision,
                  value[2] + revision,
                  value[3] + revision,
                  value[4] + revision
                ] as const)
          )
        }))
      };
    case 'bubble':
      return {
        ...spec,
        series: spec.series.map((series) => ({
          ...series,
          points: series.points.map(([x, y, size, color]) => [x, y, size + revision, color ?? null] as const)
        }))
      };
    case 'field':
      return {
        ...spec,
        values: spec.values.map((row) => row.map((value) => (value === null ? null : value + revision)))
      };
    case 'heatmap':
      return {
        ...spec,
        data: spec.data.map(([x, y, value], index) => [x, y, index === 0 ? value + revision : value] as const)
      };
    default:
      return spec;
  }
}
