import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import { normalizePath } from './path-utils.mjs';

const excludedHelperInputSegments = new Set(['target', '.git', '.hg', '.svn']);

export function isAuthoredHelperInputPath(filePath) {
  const segments = normalizePath(filePath).split('/').filter(Boolean);
  return segments.length > 0 && !segments.some((segment) => excludedHelperInputSegments.has(segment));
}

export function isExcludedHelperInputPath(filePath) {
  return normalizePath(filePath)
    .split('/')
    .some((segment) => excludedHelperInputSegments.has(segment));
}

export async function listAuthoredHelperInputFiles(directory, { fileSystem }) {
  const root = pathFromUrl(directory);
  return listNestedHelperInputFiles(root, '', { fileSystem });
}

async function listNestedHelperInputFiles(directory, relativeDirectory, { fileSystem }) {
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }

  const nested = await Promise.all(
    entries.map(async (entry) => {
      const relativePath = normalizePath(path.join(relativeDirectory, entry.name));
      if (!isAuthoredHelperInputPath(relativePath)) return [];

      const filePath = path.join(directory, entry.name);
      if (entry.isDirectory()) return listNestedHelperInputFiles(filePath, relativePath, { fileSystem });
      return entry.isFile() ? [{ filePath, path: relativePath }] : [];
    })
  );
  return nested.flat().sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
}
