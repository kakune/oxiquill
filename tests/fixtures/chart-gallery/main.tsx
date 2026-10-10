import { render } from 'preact';
import { useState } from 'preact/hooks';
import ChartOutput from '@chart-source/components/doc-runtime/ChartOutput';
import { labelsForLanguage } from '@chart-source/lib/doc-runtime/runtime-localization';
import * as echarts from 'echarts/core';
import { chartFixtures } from '../chart-specs';
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
  const [formatted, setFormatted] = useState(true);
  const [reordered, setReordered] = useState(false);
  return (
    <main style={{ width }}>
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
                spec: {
                  ...spec,
                  ...(!formatted ? { style: undefined } : {}),
                  ...(revision ? { title: `Updated ${name}` } : {}),
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
                caption: `Revision ${revision}`
              }}
              idPrefix={name}
              labels={labelsForLanguage(locale)}
            />
          </section>
        ))}
    </main>
  );
}

Object.assign(window, { galleryECharts: echarts });
const app = document.getElementById('app');
if (app) render(<Gallery />, app);
