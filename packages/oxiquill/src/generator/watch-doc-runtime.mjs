import chokidar from 'chokidar';
import { pathToFileURL } from 'node:url';
import { parseConfigOption } from '../cli/config-option.mjs';
import { pathFromUrl } from '../config/paths.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import { createDocRuntimeContext, syncDocRuntime } from './doc-runtime-service.mjs';
import {
  classifyChangedPath,
  createRuntimeWatchPaths,
  createSerialTaskQueue,
  describeChangeKinds,
  mergeChangeKinds,
  shouldSyncRuntime,
  toWatchEventRelativePath
} from './doc-runtime-watch-core.mjs';

const defaultServices = {
  createDocRuntimeContext,
  loadProjectConfig: loadOxiquillProjectConfig,
  syncDocRuntime,
  watch: chokidar.watch
};

export async function main(argv = process.argv.slice(2), serviceOverrides = {}) {
  const services = { ...defaultServices, ...serviceOverrides };
  const { commandArgs, configFile } = parseConfigOption(argv);
  const unexpectedArgs = commandArgs.filter((argument) => argument !== '--skip-initial');
  if (unexpectedArgs.length > 0) {
    throw new Error(`Unknown runtime watcher option: ${unexpectedArgs[0]}.`);
  }
  const projectConfig = await services.loadProjectConfig({ cwd: process.cwd(), configFile });
  return watchDocRuntime({
    projectConfig,
    serviceOverrides: services,
    skipInitial: commandArgs.includes('--skip-initial')
  });
}

export async function watchDocRuntime({ projectConfig, serviceOverrides = {}, skipInitial = false }) {
  const services = { ...defaultServices, ...serviceOverrides };
  const { paths } = projectConfig;
  const initialContext = await services.createDocRuntimeContext({ paths });
  const workspaceRoot = pathFromUrl(initialContext.paths.workspaceRoot);
  let changeKinds = skipInitial ? new Set() : new Set(['docs']);

  if (skipInitial) {
    const baseline = await services.syncDocRuntime({
      ...initialContext,
      mode: 'dev',
      tolerateHaskellBuildFailure: true
    });
    console.log(`[runtime] baseline ready: ${baseline.cellCount} interactive cell(s)`);
  }

  async function syncRuntime() {
    if (!shouldSyncRuntime(changeKinds)) return;

    const currentKinds = changeKinds;
    changeKinds = new Set();
    const context = await services.createDocRuntimeContext({ paths, highlighter: initialContext.highlighter });

    console.log(`[runtime] syncing after ${describeChangeKinds(currentKinds)}`);
    const current = await services.syncDocRuntime({
      ...context,
      forceRustBuild: currentKinds.has('crate'),
      mode: 'dev',
      tolerateHaskellBuildFailure: true
    });

    if (current.plan.languages.rust.public === 'build') {
      console.log('[runtime] rebuilt Rust/Wasm cells');
    }
    if (current.plan.languages.haskell.public === 'build') {
      console.log('[runtime] rebuilt Haskell/WASI cells');
    }
    if (current.haskellBuildResult && !current.haskellBuildResult.ok) {
      console.warn(`[runtime] Haskell/WASI runtime unavailable: ${current.haskellBuildResult.error.message}`);
    }

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
  const watcher = services.watch(createRuntimeWatchPaths(initialContext.paths), {
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
