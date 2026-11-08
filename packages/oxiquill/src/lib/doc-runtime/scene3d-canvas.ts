import type { Scene3dArtifact } from './types.js';
import { projectScene, sceneGroups, scenePrimitives, type Camera } from './scene3d.js';

export interface SceneChrome {
  background: string;
  text: string;
  edge: string;
}

export function drawScene(
  canvas: HTMLCanvasElement,
  scene: Scene3dArtifact,
  camera: Camera,
  hidden: ReadonlySet<string | undefined>,
  selected: readonly string[],
  chrome: SceneChrome,
  width: number,
  height: number,
  ratio = globalThis.devicePixelRatio || 1
): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;
  canvas.width = Math.max(1, Math.round(width * ratio));
  canvas.height = Math.max(1, Math.round(height * ratio));
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.fillStyle = chrome.background;
  context.fillRect(0, 0, width, height);
  const groups = new Map(sceneGroups(scene).map((group) => [group.id, group]));
  const primitives = scenePrimitives(scene, projectScene(scene, camera, width, height), hidden);
  primitives.forEach((primitive) => {
    context.globalAlpha = 0.65 + (primitive.depth + 1) * 0.175;
    context.beginPath();
    if (primitive.kind === 'edge') {
      context.strokeStyle = chrome.edge;
      context.lineWidth = 1;
      context.moveTo(primitive.from.x, primitive.from.y);
      context.lineTo(primitive.to.x, primitive.to.y);
      context.stroke();
      return;
    }
    const { x, y, point } = primitive.point;
    if (x < -12 || y < -12 || x > width + 12 || y > height + 12) return;
    const group = groups.get(point.group);
    context.fillStyle = group?.color ?? chrome.text;
    switch (group?.symbol) {
      case 'square':
        context.rect(x - 4, y - 4, 8, 8);
        break;
      case 'triangle':
        context.moveTo(x, y - 5);
        context.lineTo(x + 5, y + 4);
        context.lineTo(x - 5, y + 4);
        context.closePath();
        break;
      case 'diamond':
        context.moveTo(x, y - 6);
        context.lineTo(x + 5, y);
        context.lineTo(x, y + 6);
        context.lineTo(x - 5, y);
        context.closePath();
        break;
      default:
        context.arc(x, y, 4.5, 0, 2 * Math.PI);
    }
    context.fill();
    if (selected.includes(point.id)) {
      context.globalAlpha = 1;
      context.beginPath();
      context.arc(x, y, 9, 0, 2 * Math.PI);
      context.strokeStyle = chrome.text;
      context.lineWidth = 2;
      context.stroke();
    }
  });
  context.globalAlpha = 1;
  return true;
}

export function scenePng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Unable to encode scene PNG.'))), 'image/png')
  );
}
