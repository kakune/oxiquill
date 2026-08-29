import chokidar from 'chokidar';
import { pathToFileURL } from 'node:url';
import { parseConfigOption } from '../cli/config-option.mjs';
import { pathFromUrl } from '../config/paths.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import {
  buildHaskellWasm,
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  shouldBuildHaskellWasm,
  shouldBuildWasm,
  syncLicenseArtifacts,
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

export async function main(argv = process.argv.slice(2)) {
  const { commandArgs, configFile } = parseConfigOption(argv);
  const unexpectedArgs = commandArgs.filter((argument) => argument !== '--skip-initial');
  if (unexpectedArgs.length > 0) {
    throw new Error(`Unknown runtime watcher option: ${unexpectedArgs[0]}.`);
  }
  const projectConfig = await loadOxiquillProjectConfig({ cwd: process.cwd(), configFile });
  return watchDocRuntime({
    projectConfig,
    skipInitial: commandArgs.includes('--skip-initial')
  });
}

export async function watchDocRuntime({ projectConfig, skipInitial = false }) {
  const { paths } = projectConfig;
  const initialContext = await createDocRuntimeContext({ paths });
  const workspaceRoot = pathFromUrl(initialContext.paths.workspaceRoot);
  let previous;
  let changeKinds = skipInitial ? new Set() : new Set(['docs']);

  if (skipInitial) {
    previous = await syncDocRuntime(initialContext);
    console.log(`[runtime] baseline ready: ${previous.cellCount} interactive cell(s)`);
  }

  async function syncRuntime() {
    if (!shouldSyncRuntime(changeKinds)) return;

    const currentKinds = changeKinds;
    changeKinds = new Set();
    const context = await createDocRuntimeContext({ paths, highlighter: initialContext.highlighter });

    console.log(`[runtime] syncing after ${describeChangeKinds(currentKinds)}`);
    const current = await syncDocRuntime(context);

    if (shouldBuildWasm({ changeKinds: currentKinds, current, previous })) {
      console.log('[runtime] rebuilding Rust/Wasm cells');
      await buildRustWasm({ mode: 'dev', paths: context.paths });
    }
    if (shouldBuildHaskellWasm({ current, previous })) {
      console.log('[runtime] rebuilding Haskell/WASI cells');
      const result = await buildHaskellWasm({
        haskellFingerprint: current.haskellFingerprint,
        mode: 'dev',
        paths: context.paths,
        tolerateFailure: true
      });
      if (!result.ok) {
        console.warn(`[runtime] Haskell/WASI runtime unavailable: ${result.error.message}`);
      }
    }

    await syncLicenseArtifacts({ paths: context.paths });

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
  const watcher = chokidar.watch(createRuntimeWatchPaths(initialContext.paths), {
    cwd: workspaceRoot,
    ignoreInitial: true
  });

  watcher.on('all', (_event, filePath) => {
    const kind = classifyChangedPath(toWatchEventRelativePath(workspaceRoot, filePath), initialContext.paths);
    if (kind === 'other') return;

    changeKinds = mergeChangeKinds(changeKinds, kind);
    queue.enqueue();
  });

  watcher.on('ready', () => {
    console.log('[runtime] watching MDX, Rust, and Haskell cell sources');
  });

  return watcher;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
