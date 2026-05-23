import path from 'node:path';

const contentPrefix = 'src/content/docs/';
const markdownExtensionPattern = /\.(md|mdx)$/u;

export function scopedCellId(pagePath, localId) {
  const pageId = pageIdFromPath(pagePath);
  return pageId ? `${pageId}__${sanitizeId(localId)}` : sanitizeId(localId);
}

export function relativePagePath(root, filePath) {
  if (!root || !filePath) return undefined;
  return normalizePath(path.relative(root, filePath));
}

export function pageIdFromPath(pagePath) {
  return normalizePath(pagePath)
    .replace(markdownExtensionPattern, '')
    .replace(new RegExp(`^${escapeRegExp(contentPrefix)}`, 'u'), '')
    .split('/')
    .filter(Boolean)
    .map(sanitizeId)
    .join('__');
}

function sanitizeId(value) {
  const sanitized = String(value).trim().replace(/[^A-Za-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return sanitized || 'cell';
}

function normalizePath(value) {
  return String(value ?? '').split(path.sep).join('/');
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
