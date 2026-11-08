import { chartPalette } from './chart-palette.js';
import type { Scene3dArtifact, Scene3dCamera, Scene3dPoint, TableArtifact } from './types.js';

export type Camera = Required<Scene3dCamera>;
export type ProjectedPoint = { point: Scene3dPoint; x: number; y: number; depth: number };
export type ScenePrimitive =
  | { kind: 'point'; point: ProjectedPoint; depth: number }
  | { kind: 'edge'; from: ProjectedPoint; to: ProjectedPoint; depth: number };
export const sceneAxes = ['x', 'y', 'z'] as const;
export const sceneSymbols = ['circle', 'square', 'triangle', 'diamond'] as const;

export function authoredCamera(scene: Scene3dArtifact): Camera {
  return { yaw: scene.camera?.yaw ?? 30, pitch: scene.camera?.pitch ?? 20, zoom: scene.camera?.zoom ?? 1 };
}

export function rotateCamera(camera: Camera, yaw: number, pitch: number): Camera {
  return { ...camera, yaw: ((camera.yaw % 360) + yaw) % 360, pitch: Math.max(-90, Math.min(90, camera.pitch + pitch)) };
}

export function zoomCamera(camera: Camera, factor: number): Camera {
  return { ...camera, zoom: Math.max(Number.MIN_VALUE, Math.min(Number.MAX_VALUE, camera.zoom * factor)) };
}

export function scenePointIds(scene: Scene3dArtifact): string {
  return JSON.stringify(scene.points.map(({ id }) => id).sort());
}

export function selectPoint(selected: readonly string[], id: string): readonly string[] {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected.slice(-1), id];
}

export function sceneGroups(scene: Scene3dArtifact) {
  const used = new Set(scene.points.map(({ group }) => group));
  const declared = (scene.groups ?? []).filter(({ id }) => used.has(id));
  const ordered: { id: string | undefined; label: string }[] = declared.map(({ id, label }) => ({
    id,
    label: label ?? id
  }));
  const known = new Set<string | undefined>(declared.map(({ id }) => id));
  scene.points.forEach(({ group }) => {
    if (!known.has(group)) {
      known.add(group);
      ordered.push({ id: group, label: group ?? '' });
    }
  });
  return ordered.map((group, index) => ({
    ...group,
    color: chartPalette[index % chartPalette.length] as string,
    symbol: sceneSymbols[index % sceneSymbols.length] as (typeof sceneSymbols)[number]
  }));
}

export function projectScene(
  scene: Scene3dArtifact,
  camera: Camera,
  width: number,
  height: number
): readonly ProjectedPoint[] {
  const magnitude = scene.points.reduce((max, { position }) => Math.max(max, ...position.map(Math.abs)), 0) || 1;
  const normalized = scene.points.map(({ position }) => position.map((value) => value / magnitude));
  const minima = sceneAxes.map((_, axis) => normalized.reduce((min, p) => Math.min(min, p[axis] ?? 0), Infinity));
  const maxima = sceneAxes.map((_, axis) => normalized.reduce((max, p) => Math.max(max, p[axis] ?? 0), -Infinity));
  const center = minima.map((min, index) => min / 2 + (maxima[index] ?? 0) / 2);
  const centered = normalized.map((p) => p.map((value, axis) => value - (center[axis] ?? 0)));
  const radius = centered.reduce((max, p) => Math.max(max, Math.hypot(...p)), 0) || 1;
  const yaw = ((camera.yaw % 360) * Math.PI) / 180;
  const pitch = (camera.pitch * Math.PI) / 180;
  const size = Math.min(Math.max(0, width), Math.max(0, height)) * 0.4;
  // Clip enormous finite zooms before handing coordinates to browser drawing APIs.
  const screen = (value: number) => Math.max(-1e9, Math.min(1e9, value * camera.zoom * size));
  return scene.points.map((point, index) => {
    const p = centered[index] ?? [];
    const [x, y, z] = [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0].map((value) => value / radius);
    const horizontal = (x ?? 0) * Math.cos(yaw) + (z ?? 0) * Math.sin(yaw);
    const back = -(x ?? 0) * Math.sin(yaw) + (z ?? 0) * Math.cos(yaw);
    const vertical = (y ?? 0) * Math.cos(pitch) - back * Math.sin(pitch);
    return {
      point,
      x: width / 2 + screen(horizontal),
      y: height / 2 - screen(vertical),
      depth: (y ?? 0) * Math.sin(pitch) + back * Math.cos(pitch)
    };
  });
}

export function scenePrimitives(
  scene: Scene3dArtifact,
  points: readonly ProjectedPoint[],
  hidden: ReadonlySet<string | undefined>
): readonly ScenePrimitive[] {
  const visible = points.filter(({ point }) => !hidden.has(point.group));
  const byId = new Map(visible.map((point) => [point.point.id, point]));
  const edges: ScenePrimitive[] = (scene.edges ?? []).flatMap(({ from, to }) => {
    const a = byId.get(from);
    const b = byId.get(to);
    return a && b ? [{ kind: 'edge' as const, from: a, to: b, depth: a.depth / 2 + b.depth / 2 }] : [];
  });
  return [...edges, ...visible.map((point) => ({ kind: 'point' as const, point, depth: point.depth }))].sort(
    (a, b) => a.depth - b.depth
  );
}

export function pickPoint(
  points: readonly ProjectedPoint[],
  x: number,
  y: number,
  hidden: ReadonlySet<string | undefined> = new Set()
): string | undefined {
  return points
    .filter(({ point }) => !hidden.has(point.group))
    .reduce<{ id?: string; distance: number; depth: number }>(
      (best, p) => {
        const distance = Math.hypot(p.x - x, p.y - y);
        return distance <= 12 && (distance < best.distance || (distance === best.distance && p.depth > best.depth))
          ? { id: p.point.id, distance, depth: p.depth }
          : best;
      },
      { distance: Infinity, depth: -Infinity }
    ).id;
}

export function sceneDistance(
  scene: Scene3dArtifact,
  selected: readonly string[]
): { kind: 'none' } | { kind: 'units' } | { kind: 'distance'; value: number; unit: string } {
  const a = scene.points.find(({ id }) => id === selected[0]);
  const b = scene.points.find(({ id }) => id === selected[1]);
  if (!a || !b) return { kind: 'none' };
  const unit = scene.axes?.x?.unit;
  if (!unit?.trim() || scene.axes?.y?.unit !== unit || scene.axes?.z?.unit !== unit) return { kind: 'units' };
  // Direct subtraction keeps tiny separations; hypot scales to avoid squared overflow.
  const value = Math.hypot(...a.position.map((coordinate, index) => coordinate - (b.position[index] ?? 0)));
  return { kind: 'distance', value, unit };
}

type SceneColumn = 'id' | 'label' | 'group' | 'from' | 'to';

export function sceneTables(
  scene: Scene3dArtifact,
  titles: { points: string; edges: string; columns?: Readonly<Record<SceneColumn, string>> }
): { points: TableArtifact; edges: TableArtifact } {
  const column = (key: SceneColumn) => ({ key, label: titles.columns?.[key] ?? key, type: 'string' as const });
  return {
    points: {
      kind: 'table',
      title: titles.points,
      columns: [
        ...(['id', 'label', 'group'] as const).map(column),
        ...sceneAxes.map((key) => ({
          key,
          label: scene.axes?.[key]?.label ?? key,
          type: 'number' as const,
          ...(scene.axes?.[key]?.unit ? { format: { unit: scene.axes[key]?.unit } } : {})
        }))
      ],
      rows: scene.points.map((point) => [point.id, point.label ?? '', point.group ?? '', ...point.position])
    },
    edges: {
      kind: 'table',
      title: titles.edges,
      columns: (['from', 'to'] as const).map(column),
      rows: (scene.edges ?? []).map(({ from, to }) => [from, to])
    }
  };
}
