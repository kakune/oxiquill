import { render } from 'preact';
import { useState } from 'preact/hooks';
import OutputRenderer from '@chart-source/components/doc-runtime/OutputRenderer';
import { validateOutputArtifacts } from '@chart-source/lib/doc-runtime/output-artifact-validation';
import { drawScene } from '@chart-source/lib/doc-runtime/scene3d-canvas';
import { authoredCamera, pickPoint, projectScene } from '@chart-source/lib/doc-runtime/scene3d';
import { labelsForLanguage } from '@chart-source/lib/doc-runtime/runtime-localization';
import { tetrahedron, largeScene } from '../scene3d';
import '@starlight-props';
import '@chart-source/styles/custom.css';

const query = new URLSearchParams(location.search);
document.documentElement.dataset.theme = query.get('theme') ?? 'light';
document.documentElement.lang = query.get('locale') ?? 'en';
document.body.style.cssText =
  'margin:0;background:var(--sl-color-bg);color:var(--sl-color-text);font-family:system-ui,sans-serif';

function Fixture() {
  const [scale, setScale] = useState(1);
  const [identity, setIdentity] = useState({});
  const [mounted, setMounted] = useState(true);
  const [changedIds, setChangedIds] = useState(false);
  const scene = {
    ...tetrahedron,
    points: tetrahedron.points.map((point) => ({
      ...point,
      id: changedIds ? `${point.id}-new` : point.id,
      position: point.position.map((n) => n * scale) as [number, number, number]
    })),
    edges: changedIds ? [] : tetrahedron.edges,
    ...(query.has('mixed') ? { axes: {} } : {})
  };
  return (
    <main style={{ width: '100%', maxWidth: 720, margin: 'auto' }}>
      <h1>Scene fixture</h1>
      <button onClick={() => setScale((value) => value + 1)}>Update scene</button>
      <button onClick={() => setIdentity({})}>Replace scene</button>
      <button onClick={() => setChangedIds(true)}>Change IDs</button>
      <button onClick={() => setMounted((value) => !value)}>Toggle mount</button>
      <button
        onClick={() => {
          document.documentElement.dataset.theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
        }}
      >
        Change theme
      </button>
      {mounted ? (
        <OutputRenderer
          outputs={validateOutputArtifacts([scene])}
          resultIdentity={identity}
          idPrefix="scene"
          labels={labelsForLanguage(document.documentElement.lang)}
        />
      ) : null}
    </main>
  );
}
render(<Fixture />, document.getElementById('app') as HTMLElement);

// Reproducible renderer measurements, with no timing thresholds in correctness tests.
Object.assign(window, {
  benchmarkScene(count: number) {
    const scene = largeScene(count);
    const canvas = document.createElement('canvas');
    const chrome = { background: '#fff', text: '#111', edge: '#888' };
    const camera = authoredCamera(scene);
    const started = performance.now();
    drawScene(canvas, scene, camera, new Set(), [], chrome, 720, 360, 1);
    const rendered = performance.now();
    drawScene(canvas, scene, { ...camera, yaw: 45 }, new Set(), [], chrome, 720, 360, 1);
    const rotated = performance.now();
    const points = projectScene(scene, camera, 720, 360);
    pickPoint(points, 360, 180);
    return {
      points: count,
      edges: scene.edges?.length ?? 0,
      renderMs: rendered - started,
      orbitMs: rotated - rendered,
      projectAndPickMs: performance.now() - rotated
    };
  }
});
