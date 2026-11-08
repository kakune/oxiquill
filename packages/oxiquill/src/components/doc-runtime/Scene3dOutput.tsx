import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { Scene3dArtifact } from '../../lib/doc-runtime/types.js';
import { labelsForLanguage, type RuntimeLabels } from '../../lib/doc-runtime/runtime-localization.js';
import { scene3dLabels } from '../../lib/doc-runtime/scene3d-localization.js';
import { numberFormatter } from '../../lib/doc-runtime/number-format.js';
import {
  authoredCamera,
  pickPoint,
  projectScene,
  rotateCamera,
  sceneAxes,
  sceneDistance,
  sceneGroups,
  scenePointIds,
  sceneTables,
  selectPoint,
  zoomCamera,
  type Camera
} from '../../lib/doc-runtime/scene3d.js';
import { drawScene, scenePng } from '../../lib/doc-runtime/scene3d-canvas.js';
import { artifactDownloadName, downloadBlob } from '../../lib/doc-runtime/download.js';
import { boundedErrorMessage } from '../../lib/doc-runtime/output-limits.mjs';
import TableOutput from './TableOutput.js';

interface Props {
  artifact: Scene3dArtifact;
  idPrefix: string;
  labels?: RuntimeLabels;
  resultIdentity?: object;
}
interface View {
  identity: object;
  ids: string;
  camera: Camera;
  selected: readonly string[];
  hidden: ReadonlySet<string | undefined>;
}

export default function Scene3dOutput({
  artifact,
  idPrefix,
  labels = labelsForLanguage(globalThis.document?.documentElement.lang),
  resultIdentity
}: Props) {
  const text = scene3dLabels(labels.locale);
  const title = artifact.title?.trim() ? artifact.title : text.title;
  const mounted = useRef({});
  const identity = resultIdentity ?? mounted.current;
  const ids = useMemo(() => JSON.stringify([artifact.id, scenePointIds(artifact)]), [artifact]);
  const initial = (): View => ({ identity, ids, camera: authoredCamera(artifact), selected: [], hidden: new Set() });
  const [stored, setView] = useState<View>(initial);
  const view = stored.identity === identity && stored.ids === ids ? stored : initial();
  const latest = useRef({ artifact, view });
  latest.current = { artifact, view };
  const canvas = useRef<HTMLCanvasElement>(null);
  const printCanvas = useRef<HTMLCanvasElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 640, height: 360 });
  const [theme, setTheme] = useState(() => document.documentElement.dataset.theme);
  // The canvas backing store follows the device pixel ratio, for example after moving to another monitor.
  const [pixelRatio, setPixelRatio] = useState(() => globalThis.devicePixelRatio || 1);
  const [available, setAvailable] = useState(true);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [tableOpen, setTableOpen] = useState(false);
  const generation = useRef(0);
  const groups = useMemo(() => sceneGroups(artifact), [artifact]);
  const tables = useMemo(() => sceneTables(artifact, text), [artifact, text]);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef({ x: 0, y: 0, moved: false });

  function updateCamera(update: (camera: Camera) => Camera) {
    const current = latest.current.view;
    setView({ ...current, camera: update(current.camera) });
  }
  function select(id: string) {
    const current = latest.current.view;
    setView({ ...current, selected: selectPoint(current.selected, id) });
  }

  useEffect(() => {
    setView((current) => (current.identity === identity && current.ids === ids ? current : initial()));
    setError('');
  }, [identity, ids]);

  useEffect(() => {
    const used = new Set(artifact.points.map(({ group }) => group));
    setView((current) => {
      const hidden = new Set([...current.hidden].filter((id) => used.has(id)));
      return hidden.size === current.hidden.size ? current : { ...current, hidden };
    });
  }, [artifact]);

  useEffect(() => {
    const root = viewport.current;
    if (!root) return;
    const resize = () => {
      const width = root.getBoundingClientRect().width || 640;
      const height = Math.max(240, Math.min(420, width * 0.6));
      setSize((current) => (current.width === width && current.height === height ? current : { width, height }));
    };
    resize();
    let resizeFrame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(resize);
    });
    observer.observe(root);
    const themeObserver = new MutationObserver(() => setTheme(document.documentElement.dataset.theme));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? root.clientHeight || 360 : 1);
      updateCamera((camera) => zoomCamera(camera, Math.exp(Math.max(-2, Math.min(2, -delta * 0.002)))));
    };
    root.addEventListener('wheel', wheel, { passive: false });
    let pixelQuery: MediaQueryList | undefined;
    const watchPixelRatio = () => {
      pixelQuery?.removeEventListener('change', watchPixelRatio);
      const ratio = globalThis.devicePixelRatio || 1;
      setPixelRatio(ratio);
      pixelQuery = globalThis.matchMedia?.(`(resolution: ${ratio}dppx)`);
      pixelQuery?.addEventListener('change', watchPixelRatio);
    };
    watchPixelRatio();
    return () => {
      pixelQuery?.removeEventListener('change', watchPixelRatio);
      observer.disconnect();
      cancelAnimationFrame(resizeFrame);
      themeObserver.disconnect();
      root.removeEventListener('wheel', wheel);
      pointers.current.forEach((_, id) => {
        if (root.hasPointerCapture(id)) root.releasePointerCapture(id);
      });
      pointers.current.clear();
    };
  }, []);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!canvas.current || !viewport.current) return;
      const style = getComputedStyle(viewport.current);
      const chrome = {
        background: style.getPropertyValue('--sl-color-bg').trim() || (theme === 'dark' ? '#18181b' : '#fff'),
        text: style.getPropertyValue('--sl-color-text').trim() || (theme === 'dark' ? '#eee' : '#18181b'),
        edge: style.getPropertyValue('--sl-color-gray-3').trim() || '#888'
      };
      try {
        setAvailable(
          drawScene(canvas.current, artifact, view.camera, view.hidden, view.selected, chrome, size.width, size.height)
        );
      } catch (caught) {
        setAvailable(false);
        setError(boundedErrorMessage(caught));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [artifact, view.camera, view.hidden, view.selected, theme, size, pixelRatio]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (!printCanvas.current) return;
      try {
        drawScene(
          printCanvas.current,
          artifact,
          authoredCamera(artifact),
          new Set(),
          [],
          { background: '#fff', text: '#18181b', edge: '#666' },
          size.width,
          size.height
        );
      } catch (caught) {
        setError(boundedErrorMessage(caught));
      }
    });
    return () => cancelAnimationFrame(frame);
  }, [artifact, size]);

  useEffect(() => {
    generation.current += 1;
    setExporting(false);
    setError('');
    return () => {
      generation.current += 1;
    };
  }, [artifact, identity]);

  async function savePng() {
    if (!canvas.current || exporting) return;
    const token = generation.current;
    setExporting(true);
    try {
      const blob = await scenePng(canvas.current);
      if (generation.current === token) downloadBlob(blob, artifactDownloadName(artifact, 'png', 'scene3d'));
    } catch (caught) {
      if (generation.current === token) setError(`${text.exportError}: ${boundedErrorMessage(caught)}`);
    } finally {
      if (generation.current === token) setExporting(false);
    }
  }
  const distance = sceneDistance(artifact, view.selected);
  return (
    <figure
      class="doc-scene3d"
      aria-labelledby={`${idPrefix}-title`}
      aria-describedby={artifact.caption ? `${idPrefix}-caption` : undefined}
      data-testid="scene3d-output"
    >
      <figcaption>
        <strong id={`${idPrefix}-title`}>{title}</strong>
        {artifact.caption ? <p id={`${idPrefix}-caption`}>{artifact.caption}</p> : null}
      </figcaption>
      <div class="doc-scene3d__actions">
        <button type="button" onClick={() => updateCamera(() => authoredCamera(artifact))}>
          {text.reset}
        </button>
        <button type="button" disabled={!available || exporting} onClick={() => void savePng()}>
          {labels.savePng}
        </button>
      </div>
      <details class="doc-scene3d__controls">
        <summary>{text.controls}</summary>
        <p id={`${idPrefix}-instructions`}>{text.instructions}</p>
      </details>
      <div class="doc-scene3d__legend" aria-label={labels.chartSeries} role="group">
        {groups.map((group) => (
          <span key={JSON.stringify([group.id])}>
            <button
              type="button"
              aria-pressed={!view.hidden.has(group.id)}
              onClick={() => {
                const hidden = new Set(view.hidden);
                if (hidden.has(group.id)) hidden.delete(group.id);
                else hidden.add(group.id);
                setView({ ...view, hidden });
              }}
            >
              <span
                aria-hidden="true"
                class={`doc-scene3d__symbol doc-scene3d__symbol--${group.symbol}`}
                style={{ background: group.color }}
              />
              {group.label || text.ungrouped}
            </button>
            <button
              type="button"
              aria-label={labels.chartOnlySeries(group.label || text.ungrouped)}
              onClick={() =>
                setView({ ...view, hidden: new Set(groups.filter((item) => item.id !== group.id).map(({ id }) => id)) })
              }
            >
              {labels.chartOnly}
            </button>
          </span>
        ))}
        {groups.length ? (
          <button type="button" onClick={() => setView({ ...view, hidden: new Set() })}>
            {labels.chartShowAll}
          </button>
        ) : null}
      </div>
      <div
        ref={viewport}
        class="doc-scene3d__viewport"
        role="group"
        tabIndex={0}
        aria-labelledby={`${idPrefix}-title`}
        aria-describedby={`${idPrefix}-keyboard`}
        onKeyDown={(event) => {
          if (event.altKey || event.ctrlKey || event.metaKey) return;
          switch (event.key) {
            case 'ArrowLeft':
              updateCamera((c) => rotateCamera(c, -15, 0));
              break;
            case 'ArrowRight':
              updateCamera((c) => rotateCamera(c, 15, 0));
              break;
            case 'ArrowUp':
              updateCamera((c) => rotateCamera(c, 0, 15));
              break;
            case 'ArrowDown':
              updateCamera((c) => rotateCamera(c, 0, -15));
              break;
            case '+':
            case '=':
              updateCamera((c) => zoomCamera(c, 1.2));
              break;
            case '-':
              updateCamera((c) => zoomCamera(c, 1 / 1.2));
              break;
            case '0':
              updateCamera(() => authoredCamera(artifact));
              break;
            default:
              return;
          }
          event.preventDefault();
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.focus();
          event.currentTarget.setPointerCapture(event.pointerId);
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
          if (pointers.current.size === 1) gesture.current = { x: event.clientX, y: event.clientY, moved: false };
          else gesture.current.moved = true;
        }}
        onPointerMove={(event) => {
          const previous = pointers.current.get(event.pointerId);
          if (!previous) return;
          const other = [...pointers.current.entries()].find(([id]) => id !== event.pointerId)?.[1];
          if (other) {
            const before = Math.hypot(previous.x - other.x, previous.y - other.y);
            const after = Math.hypot(event.clientX - other.x, event.clientY - other.y);
            if (before > 0 && after > 0) updateCamera((c) => zoomCamera(c, after / before));
          } else if (
            gesture.current.moved ||
            Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4
          )
            updateCamera((c) =>
              rotateCamera(c, (event.clientX - previous.x) * 0.5, (event.clientY - previous.y) * 0.5)
            );
          if (Math.hypot(event.clientX - gesture.current.x, event.clientY - gesture.current.y) > 4)
            gesture.current.moved = true;
          pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });
        }}
        onPointerUp={(event) => {
          if (!pointers.current.has(event.pointerId)) return;
          if (!gesture.current.moved) {
            const rect = event.currentTarget.getBoundingClientRect();
            const picked = pickPoint(
              projectScene(artifact, view.camera, size.width, size.height),
              event.clientX - rect.left,
              event.clientY - rect.top,
              view.hidden
            );
            if (picked !== undefined) select(picked);
          }
          pointers.current.delete(event.pointerId);
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerCancel={() => {
          pointers.current.clear();
        }}
        onLostPointerCapture={(event) => {
          pointers.current.delete(event.pointerId);
        }}
      >
        <canvas
          ref={canvas}
          aria-hidden="true"
          style={{ width: '100%', height: `${size.height}px` }}
          data-testid="scene3d-canvas"
        />
        {available ? null : <p role="status">{text.unavailable}</p>}
        {!artifact.points.some((point) => !view.hidden.has(point.group)) ? <p>{text.empty}</p> : null}
      </div>
      <p id={`${idPrefix}-keyboard`} class="doc-visually-hidden">
        {text.instructions}
      </p>
      <canvas class="doc-scene3d__print" ref={printCanvas} aria-hidden="true" />
      <div aria-live="polite" role="status" aria-label={text.selection}>
        {view.selected.map((id) => {
          const point = artifact.points.find((p) => p.id === id);
          return point ? (
            <p key={id}>
              {point.id}
              {point.label ? ` — ${point.label}` : ''}:{' '}
              {sceneAxes
                .map(
                  (axis, index) =>
                    `${artifact.axes?.[axis]?.label ?? axis} = ${formatSceneNumber(point.position[index], labels.locale)}${artifact.axes?.[axis]?.unit ? ` ${artifact.axes[axis]?.unit}` : ''}`
                )
                .join(', ')}
            </p>
          ) : null;
        })}
        {distance.kind === 'units' ? (
          <p>{text.units}</p>
        ) : distance.kind === 'distance' ? (
          <p>
            {Number.isFinite(distance.value)
              ? `${text.distance}: ${formatSceneNumber(distance.value, labels.locale)} ${distance.unit}`
              : text.overflow}
          </p>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
      <details
        open={tableOpen || !available}
        onToggle={(event) => setTableOpen(event.currentTarget.open)}
        class="doc-scene3d__data"
      >
        <summary>{text.data}</summary>
        {tableOpen || !available ? (
          <>
            <TableOutput
              table={tables.points}
              idPrefix={`${idPrefix}-points`}
              labels={labels}
              resultIdentity={identity}
              rowAction={{
                label: text.select,
                render: (row) => (
                  <button
                    type="button"
                    aria-label={`${text.select} ${String(row[0])}`}
                    aria-pressed={view.selected.includes(String(row[0]))}
                    onClick={() => select(String(row[0]))}
                  >
                    {text.select}
                  </button>
                )
              }}
            />
            <TableOutput
              table={tables.edges}
              idPrefix={`${idPrefix}-edges`}
              labels={labels}
              resultIdentity={identity}
            />
          </>
        ) : null}
      </details>
    </figure>
  );
}

// Readouts use the chart tooltip precision; tables and CSV keep the original values.
function formatSceneNumber(value: number, locale: RuntimeLabels['locale']): string {
  return numberFormatter([value], locale, { context: 'chart' })(value);
}
