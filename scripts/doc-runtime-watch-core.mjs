import path from 'node:path';

export function classifyChangedPath(filePath) {
  const normalized = normalizePath(filePath);

  if (/^src\/content\/docs\/.+\.mdx?$/u.test(normalized)) return 'docs';
  if (/^crates\/.+\.(rs|toml)$/u.test(normalized)) return 'crate';

  return 'other';
}

export function createRuntimeWatchPaths() {
  return ['src/content/docs', 'crates'];
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
        await task();
      } while (pending);
    } catch (error) {
      onError(error);
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
