import { expect, it, vi } from 'vitest';
import { drawScene, scenePng } from '../../packages/oxiquill/src/lib/doc-runtime/scene3d-canvas';
import { authoredCamera } from '../../packages/oxiquill/src/lib/doc-runtime/scene3d';
import { tetrahedron, largeScene } from '../fixtures/scene3d';

it('draws all symbols and edges with finite coordinates and a bounded alpha', () => {
  const calls: number[][] = [];
  const record = (...numbers: number[]) => calls.push(numbers);
  const context = {
    setTransform: record,
    fillRect: record,
    beginPath() {},
    moveTo: record,
    lineTo: record,
    stroke() {},
    rect: record,
    arc: record,
    closePath() {},
    fill() {},
    globalAlpha: 1
  };
  const canvas = { getContext: () => context } as unknown as HTMLCanvasElement;
  expect(
    drawScene(
      canvas,
      largeScene(10),
      authoredCamera(tetrahedron),
      new Set(),
      ['0'],
      { background: '#fff', text: '#000', edge: '#888' },
      600,
      360,
      2
    )
  ).toBe(true);
  expect(canvas.width).toBe(1200);
  expect(calls.flat().every(Number.isFinite)).toBe(true);
  expect(context.globalAlpha).toBe(1);
  drawScene(
    canvas,
    tetrahedron,
    { yaw: 0, pitch: 0, zoom: Number.MAX_VALUE },
    new Set(),
    [],
    { background: '#fff', text: '#000', edge: '#888' },
    600,
    360
  );
  expect(calls.flat().every(Number.isFinite)).toBe(true);
  expect(
    drawScene(
      { getContext: () => null } as unknown as HTMLCanvasElement,
      tetrahedron,
      authoredCamera(tetrahedron),
      new Set(),
      [],
      { background: '', text: '', edge: '' },
      600,
      360
    )
  ).toBe(false);
});

it('encodes PNG blobs and rejects missing or throwing encoders', async () => {
  const blob = new Blob(['PNG'], { type: 'image/png' });
  const toBlob = vi.fn((callback: BlobCallback) => callback(blob));
  await expect(scenePng({ toBlob } as unknown as HTMLCanvasElement)).resolves.toBe(blob);
  expect(toBlob).toHaveBeenCalledWith(expect.any(Function), 'image/png');
  await expect(scenePng({ toBlob: (callback: BlobCallback) => callback(null) } as HTMLCanvasElement)).rejects.toThrow(
    'encode'
  );
  await expect(
    scenePng({
      toBlob: () => {
        throw new Error('tainted');
      }
    } as unknown as HTMLCanvasElement)
  ).rejects.toThrow('tainted');
});
