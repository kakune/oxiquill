import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/preact';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import Scene3dOutput from '../../packages/oxiquill/src/components/doc-runtime/Scene3dOutput';
import LazyScene3dOutput from '../../packages/oxiquill/src/components/doc-runtime/LazyScene3dOutput';
import { CellOutput } from '../../packages/oxiquill/src/components/doc-runtime/CellOutput';
import { drawScene, scenePng } from '../../packages/oxiquill/src/lib/doc-runtime/scene3d-canvas';
import { downloadBlob } from '../../packages/oxiquill/src/lib/doc-runtime/download';
import { labelsForLanguage } from '../../packages/oxiquill/src/lib/doc-runtime/runtime-localization';
import { tetrahedron } from '../fixtures/scene3d';

vi.mock('../../packages/oxiquill/src/lib/doc-runtime/scene3d-canvas', () => ({
  drawScene: vi.fn(() => true),
  scenePng: vi.fn(async () => new Blob(['png']))
}));
vi.mock('../../packages/oxiquill/src/lib/doc-runtime/download', async (original) => ({
  ...(await original<object>()),
  downloadBlob: vi.fn()
}));
let resized: ResizeObserverCallback;
const disconnect = vi.fn();
const identity = {};
const labels = labelsForLanguage('en');
const draw = vi.mocked(drawScene);
function camera() {
  return draw.mock.calls.filter(([canvas]) => canvas.dataset.testid === 'scene3d-canvas').at(-1)?.[2];
}
async function openTable() {
  const details = screen.getByText('Show data as tables').parentElement as HTMLDetailsElement;
  details.open = true;
  fireEvent(details, new Event('toggle'));
  await screen.findByRole('button', { name: 'Select point a' });
}

beforeEach(() => {
  vi.clearAllMocks();
  draw.mockReturnValue(true);
  vi.mocked(scenePng).mockResolvedValue(new Blob(['png']));
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: ResizeObserverCallback) {
        resized = callback;
      }
      observe() {}
      disconnect = disconnect;
    }
  );
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, init: PointerEventInit) {
        super(type, init);
        this.pointerId = init.pointerId ?? 0;
      }
    }
  );
  HTMLElement.prototype.setPointerCapture = vi.fn();
  HTMLElement.prototype.hasPointerCapture = vi.fn(() => true);
  HTMLElement.prototype.releasePointerCapture = vi.fn();
  document.documentElement.dataset.theme = 'light';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('offers keyboard and table measurement without interpreting labels as markup', async () => {
  const result = render(<Scene3dOutput artifact={tetrahedron} idPrefix="scene" />);
  const viewport = screen.getByRole('group', { name: 'Tetrahedron' });
  expect(viewport).toHaveAccessibleDescription(expect.stringContaining('Arrow keys rotate 15°'));
  await waitFor(() => expect(camera()?.yaw).toBe(30));
  fireEvent.keyDown(viewport, { key: 'ArrowRight' });
  await waitFor(() => expect(camera()?.yaw).toBe(45));
  fireEvent.keyDown(viewport, { key: 'ArrowUp' });
  await waitFor(() => expect(camera()?.pitch).toBe(35));
  fireEvent.keyDown(viewport, { key: 'ArrowLeft' });
  fireEvent.keyDown(viewport, { key: 'ArrowDown' });
  fireEvent.keyDown(viewport, { key: '+' });
  await waitFor(() => expect(camera()?.zoom).toBe(1.2));
  fireEvent.keyDown(viewport, { key: '-' });
  await waitFor(() => expect(camera()?.zoom).toBe(1));
  expect(fireEvent.keyDown(viewport, { key: '+', ctrlKey: true })).toBe(true);
  expect(fireEvent.keyDown(viewport, { key: 'Escape' })).toBe(true);
  fireEvent.keyDown(viewport, { key: '0' });
  await openTable();
  fireEvent.click(screen.getByRole('button', { name: 'Select point a' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select point b' }));
  expect(screen.getByRole('status', { name: 'Selected points' })).toHaveTextContent('Distance: 1 nm');
  expect(result.container.querySelector('b')).toBeNull();
  expect(result.container).toHaveTextContent('<b>Origin</b>');
  expect(result.container.querySelectorAll('table')).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Select point c' }));
  expect(screen.getByRole('status', { name: 'Selected points' })).toHaveTextContent(`Distance: ${Math.SQRT2} nm`);
  fireEvent.click(screen.getByRole('button', { name: 'Select point b' }));
  expect(screen.getByRole('status', { name: 'Selected points' })).not.toHaveTextContent('Distance:');
});

it('preserves compatible views through themes, resizing and data changes, but resets unrelated scenes', async () => {
  const output = (artifact = tetrahedron, token = identity) => (
    <Scene3dOutput artifact={artifact} idPrefix="scene" resultIdentity={token} />
  );
  const result = render(output());
  await waitFor(() => expect(camera()).toBeDefined());
  fireEvent.keyDown(screen.getByRole('group', { name: 'Tetrahedron' }), { key: 'ArrowRight' });
  await openTable();
  fireEvent.click(screen.getByRole('button', { name: 'Select point a' }));
  result.rerender(output({ ...tetrahedron, points: tetrahedron.points.toReversed(), camera: { yaw: 80, pitch: 0 } }));
  await waitFor(() => expect(camera()?.yaw).toBe(45));
  expect(screen.getByRole('button', { name: 'Select point a' })).toHaveAttribute('aria-pressed', 'true');
  act(() => {
    document.documentElement.dataset.theme = 'dark';
    resized([], {} as ResizeObserver);
  });
  await waitFor(() => expect(draw.mock.calls.some((call) => call[5].background === '#18181b')).toBe(true));
  expect(camera()?.yaw).toBe(45);
  const printed = draw.mock.calls.filter(([canvas]) => canvas.classList.contains('doc-scene3d__print')).at(-1);
  expect(printed?.[2].yaw).toBe(80);
  expect(printed?.[3].size).toBe(0);
  expect(printed?.[4]).toEqual([]);
  fireEvent.click(screen.getByRole('button', { name: 'Reset view' }));
  await waitFor(() => expect(camera()?.yaw).toBe(80));
  result.rerender(output(tetrahedron, {}));
  await waitFor(() => expect(camera()?.yaw).toBe(30));
  expect(screen.getByRole('button', { name: 'Select point a' })).toHaveAttribute('aria-pressed', 'false');
  result.rerender(output({ ...tetrahedron, id: 'other' }));
  await waitFor(() => expect(camera()?.yaw).toBe(30));
  result.rerender(output({ ...tetrahedron, points: tetrahedron.points.slice(0, 1), edges: [] }));
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Select point b' })).toBeNull());
  result.unmount();
  expect(disconnect).toHaveBeenCalled();
});

it('toggles and isolates groups while keeping tables usable and reports missing units', async () => {
  render(<Scene3dOutput artifact={{ ...tetrahedron, axes: {} }} idPrefix="scene" />);
  await waitFor(() => expect(camera()).toBeDefined());
  fireEvent.click(screen.getByRole('button', { name: 'Core', exact: true }));
  await waitFor(() =>
    expect(
      draw.mock.calls
        .filter(([canvas]) => canvas.dataset.testid === 'scene3d-canvas')
        .at(-1)?.[3]
        .has('core')
    ).toBe(true)
  );
  fireEvent.click(screen.getByRole('button', { name: 'Core', exact: true }));
  fireEvent.click(screen.getByRole('button', { name: labels.chartOnlySeries('Shell') }));
  fireEvent.click(screen.getByRole('button', { name: labels.chartShowAll }));
  await openTable();
  fireEvent.click(screen.getByRole('button', { name: 'Select point a' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select point b' }));
  expect(screen.getByText('distance unavailable: axes use different or undeclared units')).toBeVisible();
});

it('keeps accessible data available without a Canvas context and localizes controls', async () => {
  draw.mockReturnValue(false);
  const result = render(<Scene3dOutput artifact={tetrahedron} idPrefix="scene" />);
  await screen.findByText('Canvas unavailable; use the points table to inspect and select points.');
  await screen.findByRole('button', { name: 'Select point a' });
  expect(screen.getByRole('button', { name: 'Save PNG' })).toBeDisabled();
  result.rerender(
    <Scene3dOutput artifact={{ kind: 'scene3d', points: [] }} idPrefix="scene" labels={labelsForLanguage('ja')} />
  );
  expect(screen.getByRole('button', { name: 'ビューをリセット' })).toBeVisible();
});

it('exports the current view, reports encoding failures, and ignores stale exports', async () => {
  const result = render(<Scene3dOutput artifact={tetrahedron} idPrefix="scene" />);
  await waitFor(() => expect(camera()).toBeDefined());
  const save = screen.getByRole('button', { name: 'Save PNG' });
  fireEvent.click(save);
  await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Tetrahedron.png'));
  vi.mocked(scenePng).mockRejectedValueOnce(new Error('encode failed'));
  await waitFor(() => expect(save).not.toBeDisabled());
  fireEvent.click(save);
  await screen.findByRole('alert');
  expect(screen.getByRole('alert')).toHaveTextContent('encode failed');
  let resolve: (blob: Blob) => void = () => {};
  vi.mocked(scenePng).mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  fireEvent.click(save);
  result.unmount();
  await act(async () => resolve(new Blob()));
  expect(downloadBlob).toHaveBeenCalledTimes(1);
});

it('supports orbit, wheel, tap, pinch, pointer cancellation and capture cleanup', async () => {
  const scene = { ...tetrahedron, points: [{ id: 'a', position: [0, 0, 0] as const }], edges: [] };
  render(<Scene3dOutput artifact={scene} idPrefix="scene" />);
  const viewport = screen.getByRole('group', { name: 'Tetrahedron' });
  await waitFor(() => expect(camera()).toBeDefined());
  fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 320, clientY: 192, button: 0 });
  fireEvent.pointerUp(viewport, { pointerId: 1, clientX: 320, clientY: 192 });
  expect(screen.getByRole('status', { name: 'Selected points' })).toHaveTextContent('a:');
  fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 140, clientY: 120 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
  await waitFor(() => expect(camera()?.yaw).toBe(50));
  fireEvent.wheel(viewport, { deltaY: -100 });
  await waitFor(() => expect(camera()?.zoom).toBeGreaterThan(1));
  fireEvent.pointerDown(viewport, { pointerId: 1, clientX: 100, clientY: 100 });
  fireEvent.pointerDown(viewport, { pointerId: 2, clientX: 200, clientY: 100 });
  fireEvent.pointerMove(viewport, { pointerId: 2, clientX: 300, clientY: 100 });
  await waitFor(() => expect(camera()?.zoom).toBeGreaterThan(2));
  fireEvent.pointerCancel(viewport, { pointerId: 1 });
  fireEvent.pointerMove(viewport, { pointerId: 1, clientX: 0 });
  fireEvent.pointerUp(viewport, { pointerId: 1 });
});

it('retries a rejected lazy import and ignores completion after unmount', async () => {
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ default: Scene3dOutput });
  const result = render(<LazyScene3dOutput artifact={tetrahedron} idPrefix="scene" labels={labels} load={load} />);
  expect(screen.getByRole('status')).toHaveTextContent('Loading 3D scene');
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
  await screen.findByRole('figure', { name: 'Tetrahedron' });
  expect(load).toHaveBeenCalledTimes(2);
  result.unmount();
  const pending = render(
    <LazyScene3dOutput
      artifact={tetrahedron}
      idPrefix="late"
      labels={labels}
      load={() => Promise.resolve({ default: Scene3dOutput })}
    />
  );
  pending.unmount();
  await act(async () => {});
});

it('preserves selected scene IDs through actual CellOutput result replacements', async () => {
  const output = (scale: number) => (
    <CellOutput
      cellTitle="Scene"
      outputId="cell-output"
      isRunning={false}
      labels={labels}
      runMode="reactive"
      result={{
        outputs: [
          {
            ...tetrahedron,
            points: tetrahedron.points.map((point) => ({
              ...point,
              position: point.position.map((n) => n * scale) as [number, number, number]
            }))
          }
        ]
      }}
    />
  );
  const result = render(output(1));
  await screen.findByRole('figure', { name: 'Tetrahedron' });
  await openTable();
  fireEvent.click(screen.getByRole('button', { name: 'Select point a' }));
  fireEvent.click(screen.getByRole('button', { name: 'Select point b' }));
  result.rerender(output(2));
  await waitFor(() =>
    expect(screen.getByRole('status', { name: 'Selected points' })).toHaveTextContent('Distance: 2 nm')
  );
});
