import chokidar from 'chokidar';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { pathFromUrl } from '../config/paths.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import { createDocRuntimeContext, syncDocRuntime } from './doc-runtime-service.mjs';
import { prepareCleanupOwnership } from './cleanup-ownership.mjs';
import { pythonLicensePaths } from './doc-runtime/python-package-notices.mjs';
import {
  classifyChangedPath,
  createRuntimeWatchPaths,
  createSerialTaskQueue,
  describeChangeKinds,
  isExcludedCratePath,
  isRuntimeWatchFileEvent,
  mergeChangeKinds,
  shouldSyncRuntime,
  toWatchEventRelativePath
} from './doc-runtime-watch-core.mjs';

const defaultServices = {
  createDocRuntimeContext,
  loadProjectConfig: loadOxiquillProjectConfig,
  prepareCleanupOwnership,
  syncDocRuntime,
  watch: chokidar.watch
};

export async function main(argv = process.argv.slice(2), serviceOverrides = {}) {
  const services = { ...defaultServices, ...serviceOverrides };
  const { values } = parseArgs({
    allowPositionals: false,
    args: argv,
    options: {
      config: { type: 'string' },
      'skip-initial': { type: 'boolean' }
    },
    strict: true
  });
  const configFile = values.config;
  const projectConfig = await services.loadProjectConfig({ cwd: process.cwd(), configFile });
  return watchDocRuntime({
    projectConfig,
    serviceOverrides: services,
    skipInitial: values['skip-initial'] === true
  });
}

export async function watchDocRuntime({ projectConfig, serviceOverrides = {}, skipInitial = false }) {
  const services = { ...defaultServices, ...serviceOverrides };
  const { paths } = projectConfig;
  await services.prepareCleanupOwnership({
    configFile: projectConfig.configFile,
    fields: ['cacheDir', 'publicAssetsDir'],
    paths
  });
  const workspaceRoot = pathFromUrl(paths.workspaceRoot);
  let pythonOptions = projectConfig.python;
  let licensePaths = pythonLicensePaths(pythonOptions, paths);
  let reloadConfig = false;
  let highlighter;
  let changeKinds = skipInitial ? new Set() : new Set(['docs']);

  async function syncRuntime() {
    if (!shouldSyncRuntime(changeKinds)) return;

    const currentKinds = changeKinds;
    changeKinds = new Set();
    if (reloadConfig) {
      reloadConfig = false;
      const updated = await services.loadProjectConfig({ cwd: workspaceRoot, configFile: projectConfig.configFile });
      pythonOptions = updated.python;
      licensePaths = pythonLicensePaths(pythonOptions, paths);
      watcher.add(licensePaths);
    }
    const context = await services.createDocRuntimeContext({ paths, highlighter, pythonOptions });
    highlighter = context.highlighter;

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

  // Chokidar v4 does not expand globs, so watch stable roots and classify events ourselves.
  const watcher = services.watch(
    [
      ...createRuntimeWatchPaths(paths),
      ...licensePaths,
      ...(projectConfig.configFile ? [projectConfig.configFile] : [])
    ],
    {
      cwd: workspaceRoot,
      ignored: (filePath) => isExcludedCratePath(toWatchEventRelativePath(workspaceRoot, filePath), paths),
      ignoreInitial: true
    }
  );

  watcher.on('all', (event, filePath) => {
    if (!isRuntimeWatchFileEvent(event)) return;

    const absolutePath = path.resolve(workspaceRoot, filePath);
    const configChanged = Boolean(projectConfig.configFile && absolutePath === path.resolve(projectConfig.configFile));
    reloadConfig ||= configChanged;
    const kind =
      configChanged || licensePaths.includes(absolutePath)
        ? 'python'
        : classifyChangedPath(toWatchEventRelativePath(workspaceRoot, filePath), paths);
    if (kind === 'other') return;

    changeKinds = mergeChangeKinds(changeKinds, kind);
    queue.enqueue();
  });

  watcher.on('ready', () => {
    console.log('[runtime] watching documentation and helper-crate inputs');
  });

  if (!skipInitial) {
    queue.enqueue();
  }

  return watcher;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
