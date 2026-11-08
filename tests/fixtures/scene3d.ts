import type { Scene3dArtifact } from '../../packages/oxiquill/src/lib/doc-runtime/types';

export const tetrahedron: Scene3dArtifact = {
  kind: 'scene3d',
  id: 'tetrahedron',
  title: 'Tetrahedron',
  points: [
    { id: 'a', position: [0, 0, 0], label: '<b>Origin</b>', group: 'core' },
    { id: 'b', position: [1, 0, 0], group: 'shell' },
    { id: 'c', position: [0, 1, 0], group: 'shell' },
    { id: 'd', position: [0, 0, 1], group: 'shell' }
  ],
  edges: [
    { from: 'a', to: 'b' },
    { from: 'a', to: 'c' },
    { from: 'a', to: 'd' },
    { from: 'b', to: 'c' },
    { from: 'b', to: 'd' },
    { from: 'c', to: 'd' }
  ],
  groups: [
    { id: 'core', label: 'Core' },
    { id: 'shell', label: 'Shell' }
  ],
  axes: { x: { unit: 'nm' }, y: { unit: 'nm' }, z: { unit: 'nm' } },
  camera: { yaw: 30, pitch: 20, zoom: 1 }
};

export function largeScene(count: number): Scene3dArtifact {
  const points = Array.from({ length: count }, (_, index) => ({
    id: String(index),
    position: [Math.sin(index), Math.cos(index), index / Math.max(1, count)] as const,
    group: String(index % 4)
  }));
  const edges = points.flatMap(({ id }, index) =>
    [1, 2].flatMap((offset) => (index + offset < count ? [{ from: id, to: String(index + offset) }] : []))
  );
  if (count === 10_000) edges.push(...[0, 1, 2].map((index) => ({ from: String(index), to: String(count - 1) })));
  return { kind: 'scene3d', points, edges };
}
