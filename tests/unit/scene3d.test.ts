import { describe, expect, it } from 'vitest';
import { validateOutputArtifacts } from '../../packages/oxiquill/src/lib/doc-runtime/output-artifact-validation';
import { outputArtifactLimits, utf8ByteLength } from '../../packages/oxiquill/src/lib/doc-runtime/output-limits.mjs';
import {
  authoredCamera,
  pickPoint,
  projectScene,
  rotateCamera,
  sceneDistance,
  sceneGroups,
  scenePointIds,
  scenePrimitives,
  sceneTables,
  selectPoint,
  zoomCamera
} from '../../packages/oxiquill/src/lib/doc-runtime/scene3d';
import { tableToCsv } from '../../packages/oxiquill/src/components/doc-runtime/TableOutput';
import { tetrahedron, largeScene } from '../fixtures/scene3d';

describe('bounded scene3d contract', () => {
  it.each([tetrahedron, { kind: 'scene3d', points: [] }, largeScene(10_000)])(
    'accepts valid scenes including limits',
    (scene) => {
      const result = validateOutputArtifacts([scene])[0];
      expect(result).toMatchObject({ status: 'valid', artifact: scene });
      if (result?.status === 'valid') expect(result.byteLength).toBe(utf8ByteLength(JSON.stringify(result.artifact)));
    }
  );

  it.each([
    [{ points: undefined }, 'points'],
    [{ points: [{ position: [0, 0, 0] }] }, 'id'],
    [{ points: [{ id: '', position: [0, 0, 0] }] }, 'id'],
    [{ points: [{ id: '界'.repeat(22), position: [0, 0, 0] }] }, 'id'],
    [{ points: [tetrahedron.points[0], tetrahedron.points[0]] }, 'id'],
    [{ points: [{ id: 'a', position: [0, 1] }] }, 'position'],
    [{ points: [{ id: 'a', position: [NaN, 0, 0] }] }, 'position[0]'],
    [{ points: [{ id: 'a', position: [0, Infinity, 0] }] }, 'position[1]'],
    [{ points: [{ id: 'a', position: [0, 0, -Infinity] }] }, 'position[2]'],
    [{ points: [{ id: 'a', position: [0, 0, 0], label: '界'.repeat(86) }] }, 'label'],
    [{ edges: [{ from: 'a', to: 'a' }] }, 'self-edge'],
    [{ edges: [{ from: 'unknown', to: 'a' }] }, 'from'],
    [{ edges: [{ from: 'a', to: 'unknown' }] }, 'to'],
    [
      {
        edges: [
          { from: 'a', to: 'b' },
          { from: 'b', to: 'a' }
        ]
      },
      'duplicate'
    ],
    [
      {
        edges: [
          { from: 'a', to: 'b' },
          { from: 'a', to: 'b' }
        ]
      },
      'duplicate'
    ],
    [{ camera: { pitch: 91 } }, 'pitch'],
    [{ camera: { pitch: -91 } }, 'pitch'],
    [{ camera: { yaw: Infinity } }, 'yaw'],
    [{ camera: { zoom: 0 } }, 'zoom'],
    [{ camera: { zoom: -1 } }, 'zoom'],
    [{ camera: { zoom: NaN } }, 'zoom'],
    [{ axes: { x: { unit: 'x'.repeat(33) } } }, 'unit'],
    [{ axes: { x: { label: 'x'.repeat(16385) } } }, 'label'],
    [{ axes: { w: {} } }, 'w'],
    [{ axes: { x: { url: 'https://example.com' } } }, 'url'],
    [{ camera: { script: 'alert(1)' } }, 'script'],
    [{ groups: [{ id: 'g' }, { id: 'g' }] }, 'id'],
    [{ groups: [{ id: '' }] }, 'id'],
    [{ points: [{ id: 'a', position: [0, 0, 0], group: '' }] }, 'group'],
    [{ groups: [{ id: 'g', html: '<b>unsafe</b>' }] }, 'html'],
    [{ points: [{ id: 'a', position: [0, 0, 0], url: 'model.glb' }] }, 'url'],
    [{ edges: [{ from: 'a', to: 'b', script: 'code' }] }, 'script'],
    [{ modelUrl: 'model.glb' }, 'modelUrl'],
    [{ truncated: true }, 'truncated'],
    [{ points: Array.from({ length: 10001 }, () => tetrahedron.points[0]) }, 'points'],
    [{ edges: Array.from({ length: 20001 }, () => ({ from: 'a', to: 'b' })) }, 'edges']
  ])('isolates invalid scene fields %j', (patch, field) => {
    const results = validateOutputArtifacts([
      { ...tetrahedron, ...patch },
      { kind: 'text', stream: 'stdout', content: 'survives' }
    ]);
    expect(results[0]).toMatchObject({ status: 'error', index: 0, message: expect.stringContaining(field) });
    expect(results[1]).toMatchObject({ status: 'valid' });
  });

  it('checks own data properties without invoking getters', () => {
    const points = Object.defineProperty([], '0', {
      get() {
        throw new Error('must not invoke');
      },
      configurable: true
    });
    expect(validateOutputArtifacts([{ kind: 'scene3d', points }])[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('own data property')
    });
    const point = Object.defineProperty({ position: [0, 0, 0] }, 'id', {
      get() {
        throw new Error('must not invoke');
      }
    });
    expect(validateOutputArtifacts([{ kind: 'scene3d', points: [point] }])[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('id')
    });
  });

  it('accepts exact text/camera bounds and counts all scene bytes in the shared budget', () => {
    expect(
      validateOutputArtifacts([
        {
          kind: 'scene3d',
          points: [{ id: 'a'.repeat(64), position: [0, 0, 0], label: 'x'.repeat(256) }],
          camera: { yaw: Number.MAX_VALUE, pitch: -90, zoom: Number.MIN_VALUE },
          axes: { x: { unit: 'x'.repeat(32) } }
        }
      ])[0]
    ).toMatchObject({ status: 'valid' });
    const scene = {
      kind: 'scene3d',
      points: [],
      groups: Array.from({ length: 1024 }, (_, i) => ({ id: String(i), label: 'x'.repeat(16384) }))
    };
    expect(validateOutputArtifacts([scene])[0]).toMatchObject({
      status: 'error',
      message: expect.stringContaining('byte limit')
    });
    const almostFull = Array.from({ length: 16 }, () => ({
      kind: 'text',
      stream: 'stdout',
      content: 'x'.repeat(outputArtifactLimits.bytesPerTextJsonOrHtml)
    }));
    expect(validateOutputArtifacts([...almostFull, tetrahedron]).at(-1)).toMatchObject({ status: 'error', index: 16 });
  });
});

describe('pure geometry and scene data', () => {
  it('uses known orthographic rotations and independent Euclidean distance oracles', () => {
    const camera = { yaw: 0, pitch: 0, zoom: 1 };
    const points = projectScene(tetrahedron, camera, 400, 400);
    const a = points[0];
    const b = points[1];
    const c = points[2];
    const d = points[3];
    expect(a?.y).toBe(b?.y);
    expect(a?.x).toBe(c?.x);
    expect(b?.x).toBeGreaterThan(a?.x ?? 0);
    expect(c?.y).toBeLessThan(a?.y ?? 0);
    expect(d?.x).toBe(a?.x);
    expect(d?.y).toBe(a?.y);
    expect(d?.depth).toBeGreaterThan(a?.depth ?? 0);
    expect(projectScene(tetrahedron, { ...camera, yaw: 90 }, 400, 400)[3]?.x).toBeCloseTo(b?.x ?? 0);
    for (const [from, to, distance] of [
      ['a', 'b', 1],
      ['b', 'c', Math.SQRT2],
      ['c', 'd', Math.SQRT2]
    ] as const)
      expect(sceneDistance(tetrahedron, [from, to])).toEqual({ kind: 'distance', value: distance, unit: 'nm' });
    expect(sceneDistance(tetrahedron, [])).toEqual({ kind: 'none' });
    for (const axes of [
      undefined,
      {},
      { x: { unit: 'nm' } },
      { x: { unit: '' }, y: { unit: '' }, z: { unit: '' } },
      { x: { unit: 'nm' }, y: { unit: 'm' }, z: { unit: 'nm' } }
    ])
      expect(sceneDistance({ ...tetrahedron, axes }, ['a', 'b'])).toEqual({ kind: 'units' });
  });

  it('handles empty, coincident, tiny and extreme positions and cameras', () => {
    expect(projectScene({ kind: 'scene3d', points: [] }, authoredCamera(tetrahedron), 400, 300)).toEqual([]);
    for (const value of [0, Number.MIN_VALUE, Number.MAX_VALUE]) {
      const scene = {
        kind: 'scene3d' as const,
        points: [
          { id: 'a', position: [value, value, value] as const },
          { id: 'b', position: [-value, -value, -value] as const }
        ]
      };
      for (const zoom of [Number.MIN_VALUE, 1, Number.MAX_VALUE])
        expect(
          projectScene(scene, { yaw: Number.MAX_VALUE, pitch: 90, zoom }, 400, 300).every((p) =>
            [p.x, p.y, p.depth].every(Number.isFinite)
          )
        ).toBe(true);
    }
    const point = { id: 'only', position: [42, 42, 42] as const };
    expect(projectScene({ kind: 'scene3d', points: [point] }, authoredCamera(tetrahedron), 400, 300)[0]).toMatchObject({
      x: 200,
      y: 150,
      depth: 0
    });
    expect(zoomCamera({ yaw: 0, pitch: 0, zoom: Number.MAX_VALUE }, 2).zoom).toBe(Number.MAX_VALUE);
    expect(zoomCamera({ yaw: 0, pitch: 0, zoom: Number.MIN_VALUE }, 0.5).zoom).toBe(Number.MIN_VALUE);
  });

  it('sorts mixed primitives and picks within CSS pixels, breaking ties by depth', () => {
    const projected = projectScene(tetrahedron, { yaw: 0, pitch: 0, zoom: 1 }, 400, 400);
    const a = projected[0];
    expect(pickPoint(projected, a?.x ?? 0, a?.y ?? 0)).toBe('d');
    expect(pickPoint(projected, (a?.x ?? 0) - 12, a?.y ?? 0, new Set(['shell']))).toBe('a');
    expect(pickPoint(projected, (a?.x ?? 0) - 12.01, a?.y ?? 0)).toBeUndefined();
    const primitives = scenePrimitives(tetrahedron, projected, new Set());
    expect(primitives).toHaveLength(10);
    expect(primitives.map(({ depth }) => depth)).toEqual(
      primitives.map(({ depth }) => depth).toSorted((a, b) => a - b)
    );
    expect(scenePrimitives(tetrahedron, projected, new Set(['shell']))).toHaveLength(1);
  });

  it('reconciles selections and retains raw table/CSV data independently of groups', () => {
    expect(selectPoint([], 'a')).toEqual(['a']);
    expect(selectPoint(['a'], 'b')).toEqual(['a', 'b']);
    expect(selectPoint(['a', 'b'], 'c')).toEqual(['b', 'c']);
    expect(selectPoint(['a', 'b'], 'a')).toEqual(['b']);
    expect(scenePointIds(tetrahedron)).toBe(scenePointIds({ ...tetrahedron, points: tetrahedron.points.toReversed() }));
    const tables = sceneTables(tetrahedron, { points: 'Points', edges: 'Edges' });
    expect(tableToCsv(tables.points.columns, tables.points.rows)).toMatchObject({
      ok: true,
      csv: expect.stringContaining('a,<b>Origin</b>,core,0,0,0')
    });
    expect(sceneTables(largeScene(10000), { points: 'P', edges: 'E' }).edges.rows).toHaveLength(20000);
    expect(authoredCamera({ kind: 'scene3d', points: [] })).toEqual({ yaw: 30, pitch: 20, zoom: 1 });
    expect(rotateCamera({ yaw: 350, pitch: 80, zoom: 2 }, 20, 15)).toEqual({ yaw: 10, pitch: 90, zoom: 2 });
    expect(rotateCamera({ yaw: 0, pitch: -90, zoom: 1 }, -15, -15).pitch).toBe(-90);
    expect(sceneGroups({ ...tetrahedron, groups: [{ id: 'unused' }, { id: 'shell' }] }).map(({ id }) => id)).toEqual([
      'shell',
      'core'
    ]);
    const ungrouped = { kind: 'scene3d' as const, points: [{ id: 'a', position: [0, 0, 0] as const }] };
    expect(sceneGroups(ungrouped)).toMatchObject([{ id: undefined, label: '', symbol: 'circle' }]);
    expect(sceneTables(ungrouped, { points: 'P', edges: 'E' }).edges.rows).toEqual([]);
  });
});
