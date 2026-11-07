import type { ChartSpec } from '@chart-source/lib/doc-runtime/types';
import { useState } from 'preact/hooks';
import OutputRenderer from '@chart-source/components/doc-runtime/OutputRenderer';
import { validateOutputArtifacts } from '@chart-source/lib/doc-runtime/output-artifact-validation';
import { labelsForLanguage } from '@chart-source/lib/doc-runtime/runtime-localization';

const query = new URLSearchParams(location.search);
const type = query.get('axis') === 'time' ? 'time' : query.get('axis') === 'log' ? 'log' : 'value';
const coordinate = (x: number) => (type === 'time' ? Date.UTC(2026, 0, 1) + x * 1000 : type === 'log' ? x + 1 : x);

export default function LinkedGallery() {
  const [revision, setRevision] = useState(0);
  const [sourceVisible, setSourceVisible] = useState(true);
  const [late, setLate] = useState(false);
  const [incompatible, setIncompatible] = useState(false);
  const [page, setPage] = useState(0);
  const labels = labelsForLanguage(query.get('locale'));
  const chart = (id: string, start: number, end: number, group = 'g'): ChartSpec => {
    const kind = query.get('kind');
    const points = Array.from(
      { length: 11 },
      (_, index) => [coordinate(start + ((end - start) * index) / 10), index + revision] as const
    );
    const common = {
      title: id,
      xType: type,
      link: { group },
      tooltip: query.get('tooltip') !== 'false',
      style: { animation: false, ...(type === 'time' ? {} : { xFormat: { unit: 's' } }) }
    };
    if (kind === 'xy')
      return {
        ...common,
        kind,
        xType: type === 'log' ? 'value' : type,
        layers: [{ id: 'path', kind: 'line', points }]
      };
    if (kind === 'band' || kind === 'errorbar')
      return { ...common, kind, series: [{ points: points.map(([x, y]) => [x, y, y - 1, y + 1]) }] };
    return {
      ...common,
      kind: kind === 'area' ? 'area' : kind === 'scatter' || id === 'peer' ? 'scatter' : 'line',
      series: [{ points }]
    };
  };
  const panels = [
    ...(sourceVisible ? [{ id: 'source', spec: chart('source', 0, 100), width: 720 }] : []),
    { id: 'peer', spec: chart('peer', 25, 125), width: 420 },
    { id: 'disjoint', spec: chart('disjoint', 200, 300), width: 600 },
    { id: 'other', spec: chart('other', 0, 100, 'other'), width: 500 },
    ...(late ? [{ id: 'late', spec: chart('late', 10, 90), width: 540 }] : []),
    ...(incompatible
      ? [{ id: 'invalid', spec: { ...chart('invalid', 0, 100), style: { xFormat: { unit: 'm' } } }, width: 500 }]
      : [])
  ];
  return (
    <main>
      <button onClick={() => setRevision((value) => value + 1)}>Update linked data</button>
      <button onClick={() => setSourceVisible((visible) => !visible)}>Toggle source</button>
      <button onClick={() => setLate(true)}>Add late peer</button>
      <button onClick={() => setIncompatible(true)}>Add incompatible peer</button>
      <button
        onClick={() => {
          document.dispatchEvent(new Event('astro:before-swap'));
          setPage((value) => value + 1);
        }}
      >
        Navigate to fresh page
      </button>
      <div key={page}>
        {panels.map(({ id, spec, width }) => (
          <section id={id} key={id} style={{ width }}>
            <OutputRenderer
              idPrefix={id}
              labels={labels}
              outputs={validateOutputArtifacts([{ kind: 'chart', id, spec }])}
            />
          </section>
        ))}
      </div>
    </main>
  );
}
