import chokidar from 'chokidar';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  shouldBuildWasm,
  syncDocRuntime
} from './doc-runtime-service.mjs';
import {
  classifyChangedPath,
  createRuntimeWatchPaths,
  createSerialTaskQueue,
  describeChangeKinds,
  mergeChangeKinds,
  shouldSyncRuntime,
  toWatchEventRelativePath
} from './doc-runtime-watch-core.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main(argv = process.argv.slice(2)) {
  const skipInitial = argv.includes('--skip-initial');
  const initialContext = await createDocRuntimeContext({ root });
  let previous;
  let changeKinds = skipInitial ? new Set() : new Set(['docs']);

  if (skipInitial) {
    previous = await syncDocRuntime({ root, ...initialContext });
    console.log(`[runtime] baseline ready: ${previous.cellCount} interactive cell(s)`);
  }

  async function syncRuntime() {
    if (!shouldSyncRuntime(changeKinds)) return;

    const currentKinds = changeKinds;
    changeKinds = new Set();
    const context = await createDocRuntimeContext({ root, highlighter: initialContext.highlighter });

    console.log(`[runtime] syncing after ${describeChangeKinds(currentKinds)}`);
    const current = await syncDocRuntime({ root, ...context });

    if (shouldBuildWasm({ changeKinds: currentKinds, current, previous })) {
      console.log('[runtime] rebuilding Rust/Wasm cells');
      await buildRustWasm({ mode: 'dev', root });
    }

    await markRuntimeReady({ paths: context.paths, summary: current });
    previous = current;
    console.log(`[runtime] ready: ${current.cellCount} interactive cell(s)`);
  }

  const queue = createSerialTaskQueue(syncRuntime, {
    onError: (error) => {
      console.error('[runtime] sync failed');
      console.error(error);
    }
  });

  if (!skipInitial) {
    queue.enqueue();
  }

  // Chokidar v4 does not expand globs, so watch stable roots and classify events ourselves.
  const watcher = chokidar.watch(createRuntimeWatchPaths(), {
    cwd: root,
    ignoreInitial: true
  });

  watcher.on('all', (_event, filePath) => {
    const kind = classifyChangedPath(toWatchEventRelativePath(root, filePath));
    if (kind === 'other') return;

    changeKinds = mergeChangeKinds(changeKinds, kind);
    queue.enqueue();
  });

  watcher.on('ready', () => {
    console.log('[runtime] watching MDX and Rust sources');
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
