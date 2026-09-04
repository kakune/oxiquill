import path from 'node:path';
import { pathFromUrl, relativePathFromUrl } from '../config/paths.mjs';
import { isAuthoredHelperInputPath, isExcludedHelperInputPath } from './doc-runtime/helper-inputs.mjs';

const runtimeWatchFileEvents = new Set(['add', 'change', 'unlink']);

export function classifyChangedPath(filePath, paths) {
  const normalized = normalizePath(filePath);
  const docsDir = paths ? relativePathFromUrl(paths.workspaceRoot, paths.docsDir) : 'content/docs';
  const cratesDir = paths ? relativePathFromUrl(paths.workspaceRoot, paths.cratesDir) : 'crates';

  if (isDocsPath(normalized, docsDir) || isDocsPath(normalized, 'src/content/docs')) return 'docs';
  if (isCratePath(normalized, cratesDir)) return 'crate';

  return 'other';
}

export function createRuntimeWatchPaths(paths) {
  if (!paths) return ['content/docs', 'crates'];

  return [pathFromUrl(paths.docsDir), pathFromUrl(paths.cratesDir)];
}

export function isExcludedCratePath(filePath, paths) {
  const normalized = normalizePath(filePath);
  const cratesDir = paths ? relativePathFromUrl(paths.workspaceRoot, paths.cratesDir) : 'crates';
  const relativePath = relativePathWithin(normalized, cratesDir);
  return relativePath !== undefined && isExcludedHelperInputPath(relativePath);
}

export function isRuntimeWatchFileEvent(event) {
  return runtimeWatchFileEvents.has(event);
}

export function shouldSyncRuntime(changeKinds) {
  return changeKinds.has('docs') || changeKinds.has('crate');
}

export function mergeChangeKinds(current, nextKind) {
  return nextKind === 'other' ? current : new Set([...current, nextKind]);
}

export function describeChangeKinds(changeKinds) {
  if (changeKinds.size === 0) return 'no runtime changes';
  return Array.from(changeKinds).sort().join(', ');
}

export function toRelativePath(root, filePath) {
  return normalizePath(path.relative(root, path.resolve(filePath)));
}

export function toWatchEventRelativePath(root, filePath) {
  const absolutePath = path.isAbsolute(filePath) ? filePath : path.join(root, filePath);
  return toRelativePath(root, absolutePath);
}

export function createSerialTaskQueue(task, { onError = console.error } = {}) {
  let pending = false;
  let running = false;

  async function drain() {
    if (running) {
      pending = true;
      return;
    }

    running = true;
    try {
      do {
        pending = false;
        try {
          await task();
        } catch (error) {
          onError(error);
        }
      } while (pending);
    } finally {
      running = false;
    }
  }

  return {
    enqueue: () => {
      void drain();
    },
    isRunning: () => running
  };
}

function normalizePath(value) {
  return value.split(path.sep).join('/');
}

function isDocsPath(filePath, docsDir) {
  const prefix = normalizePath(docsDir).replace(/\/$/u, '');
  return filePath.startsWith(`${prefix}/`) && /\.mdx?$/u.test(filePath);
}

function isCratePath(filePath, cratesDir) {
  const relativePath = relativePathWithin(filePath, cratesDir);
  return relativePath !== undefined && isAuthoredHelperInputPath(relativePath);
}

function relativePathWithin(filePath, directory) {
  const prefix = normalizePath(directory).replace(/\/$/u, '');
  return filePath.startsWith(`${prefix}/`) ? filePath.slice(prefix.length + 1) : undefined;
}
