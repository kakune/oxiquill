import { JSDOM } from 'jsdom';

export function measureText(text, font = '12px sans-serif') {
  const size = Number(font.match(/([\d.]+)px/u)?.[1] ?? 12);
  return {
    width: Array.from(text).reduce(
      (width, char) => width + (/\p{Mark}/u.test(char) ? 0 : (char.codePointAt(0) ?? 0) > 127 ? size : size * 0.6),
      0
    )
  };
}

const identity = [1, 0, 0, 1, 0, 0];
function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5]
  ];
}
function transform(element) {
  let matrix = identity;
  for (const match of (element.getAttribute('transform') ?? '').matchAll(
    /(matrix|translate|rotate|scale)\(([^)]+)\)/gu
  )) {
    const values = match[2].split(/[ ,]+/u).map(Number);
    const [x, y = 0] = values;
    const angle = (x * Math.PI) / 180;
    const next =
      match[1] === 'matrix'
        ? values
        : match[1] === 'translate'
          ? [1, 0, 0, 1, x, y]
          : match[1] === 'scale'
            ? [x, 0, 0, values[1] ?? x, 0, 0]
            : [Math.cos(angle), Math.sin(angle), -Math.sin(angle), Math.cos(angle), 0, 0];
    matrix = multiply(matrix, next);
  }
  return element.parentElement ? multiply(transform(element.parentElement), matrix) : matrix;
}
function rectangle(x, y, width, height, matrix) {
  const points = [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height]
  ].map(([px, py]) => [matrix[0] * px + matrix[2] * py + matrix[4], matrix[1] * px + matrix[3] * py + matrix[5]]);
  return {
    points,
    left: Math.min(...points.map((p) => p[0])),
    right: Math.max(...points.map((p) => p[0])),
    top: Math.min(...points.map((p) => p[1])),
    bottom: Math.max(...points.map((p) => p[1]))
  };
}
function intersects(a, b, tolerance = 0.5) {
  if (
    Math.min(a.right, b.right) - Math.max(a.left, b.left) <= tolerance ||
    Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) <= tolerance
  )
    return false;
  return [a, b].every((box) =>
    box.points.every((point, index) => {
      const next = box.points[(index + 1) % box.points.length];
      const length = Math.hypot(next[0] - point[0], next[1] - point[1]);
      if (!length) return true;
      const normal = [(next[1] - point[1]) / length, (point[0] - next[0]) / length];
      const project = (p) => p[0] * normal[0] + p[1] * normal[1];
      const first = a.points.map(project),
        second = b.points.map(project);
      return (
        Math.min(Math.max(...first), Math.max(...second)) - Math.max(Math.min(...first), Math.min(...second)) >
        tolerance
      );
    })
  );
}

export function svgLayoutIssues(svg, width, height) {
  const document = new JSDOM(svg, { contentType: 'image/svg+xml' }).window.document;
  const boxes = Array.from(document.querySelectorAll('text')).flatMap((element) => {
    if (element.closest('defs') || element.getAttribute('opacity') === '0') return [];
    const text = element.textContent;
    if (!text?.trim()) return [];
    const style = element.getAttribute('style') ?? '';
    const font = style.match(/font:\s*([^;]+)/u)?.[1] ?? '12px sans-serif';
    const fontSize = Number(font.match(/([\d.]+)px/u)?.[1] ?? 12);
    const textWidth = measureText(text, font).width;
    const anchor = element.getAttribute('text-anchor');
    const x =
      Number(element.getAttribute('x') ?? 0) - (anchor === 'middle' ? textWidth / 2 : anchor === 'end' ? textWidth : 0);
    const y =
      Number(element.getAttribute('y') ?? 0) -
      (element.getAttribute('dominant-baseline') === 'central' ? fontSize / 2 : fontSize * 0.8);
    const box = rectangle(x, y, textWidth, fontSize, transform(element));
    for (let parent = element; parent; parent = parent.parentElement) {
      const clipId = parent.getAttribute('clip-path')?.match(/url\(#(.+)\)/u)?.[1];
      const clip = clipId ? document.getElementById(clipId)?.querySelector('rect, path') : undefined;
      if (clip) {
        const path = clip.getAttribute('d')?.match(/^M([\d.-]+) ([\d.-]+)l([\d.-]+) 0l0 ([\d.-]+)/u);
        if (clip.tagName === 'path' && !path)
          throw new Error('Unsupported SVG clip geometry: ' + clip.getAttribute('d'));
        const bounds = rectangle(
          Number(path?.[1] ?? clip.getAttribute('x')),
          Number(path?.[2] ?? clip.getAttribute('y')),
          Number(path?.[3] ?? clip.getAttribute('width')),
          Number(path?.[4] ?? clip.getAttribute('height')),
          multiply(transform(parent), transform(clip))
        );
        if (!intersects(box, bounds)) return [];
        box.left = Math.max(box.left, bounds.left);
        box.right = Math.min(box.right, bounds.right);
        box.top = Math.max(box.top, bounds.top);
        box.bottom = Math.min(box.bottom, bounds.bottom);
        box.points = rectangle(box.left, box.top, box.right - box.left, box.bottom - box.top, identity).points;
      }
    }
    return [{ text, ...box }];
  });
  const issues = boxes
    .filter((b) => b.left < -1 || b.top < -1 || b.right > width + 1 || b.bottom > height + 1)
    .map((b) => `Outside: ${b.text}`);
  boxes.forEach((a, index) =>
    boxes.slice(index + 1).forEach((b) => {
      if (intersects(a, b)) issues.push(`Overlap: ${a.text} / ${b.text}`);
    })
  );
  return issues;
}
