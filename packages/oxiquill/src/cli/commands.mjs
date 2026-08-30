import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import { createDocRuntimeContext, syncDocRuntime } from '../generator/doc-runtime-service.mjs';
import { cleanOxiquillWorkspace } from '../generator/clean.mjs';
import { prepareCleanupOwnership } from '../generator/cleanup-ownership.mjs';
import { runHelperCargo } from '../generator/run-helper-cargo.mjs';
import { testGeneratedHaskellCells } from '../generator/doc-runtime/haskell-runtime-test.mjs';
import { formatCliHelp, parseCliArguments } from './arguments.mjs';
import { initializeProject } from './init.mjs';

export async function runCli(commandOrArgs = [], argsOrOptions = {}, legacyOptions = {}) {
  const { args, options } = normalizeRunCliArguments(commandOrArgs, argsOrOptions, legacyOptions);
  const {
    cwd = process.cwd(),
    initialize = initializeProject,
    loadPackageVersion = installedPackageVersion,
    loadProjectConfig = loadOxiquillProjectConfig,
    log = console.log,
    runCommand = runCommandWithInheritedStdio,
    selectNode = frameworkNode
  } = options;
  const parsed = parseCliArguments(args);

  if (parsed.action === 'help') {
    log(formatCliHelp(parsed.commandName));
    return;
  }
  if (parsed.action === 'version') {
    log(await loadPackageVersion());
    return;
  }

  const { commandArgs, commandName: command, configFile, positionals, values } = parsed;
  if (command === 'init') {
    await initialize({ cwd, directory: positionals[0], log });
    return;
  }

  const projectConfig = await loadProjectConfig({ cwd, configFile });
  const paths = projectConfig.paths;
  const astroArgs = [...projectConfig.astroConfigArgs, ...commandArgs];

  switch (command) {
    case 'dev':
      await generateRuntime({ projectConfig, tolerateHaskellBuildFailure: true, wasmMode: 'dev' });
      await runDevServer({ args: astroArgs, projectConfig, runCommand, selectNode });
      return;
    case 'dev:runtime': {
      const { watchDocRuntime } = await import('../generator/watch-doc-runtime.mjs');
      await watchDocRuntime({
        projectConfig,
        skipInitial: values['skip-initial'] === true
      });
      return;
    }
    case 'dev:astro':
      await runAstro(projectConfig, ['dev', ...astroArgs], { runCommand, selectNode });
      return;
    case 'preview':
      await runAstro(projectConfig, ['preview', ...astroArgs], { runCommand, selectNode });
      return;
    case 'build':
      await generateRuntime({
        ownershipFields: ['cacheDir', 'outDir', 'publicAssetsDir'],
        projectConfig,
        wasmMode: 'build'
      });
      await runOxiquillCheck(projectConfig, [], { runCommand, selectNode });
      await runAstro(projectConfig, ['build', ...astroArgs], { runCommand, runtimeOwner: 'cli', selectNode });
      return;
    case 'check':
      await generateRuntime({ projectConfig, wasmMode: 'dev' });
      await runOxiquillCheck(projectConfig, commandArgs, { runCommand, selectNode });
      return;
    case 'docgen':
      await generateRuntime({ projectConfig, wasmMode: values.wasm });
      return;
    case 'clean':
      await cleanOxiquillWorkspace({ configFile: projectConfig.configFile, paths });
      return;
    case 'test-rust':
      await runHelperCargo({ argv: ['test'], paths });
      return;
    case 'test-rust-coverage':
      await runHelperCargo({
        argv: [
          'llvm-cov',
          '--fail-under-lines',
          '85',
          '--fail-under-functions',
          '85',
          '--fail-under-regions',
          '85',
          '--ignore-filename-regex',
          '(/target/|/.oxiquill/)'
        ],
        paths
      });
      return;
    case 'lint-rust':
      await runHelperCargo({ argv: ['clippy', '--all-targets', '--', '-D', 'warnings'], paths });
      return;
    case 'doc-rust':
      await runHelperCargo({ argv: ['doc', '--no-deps'], paths });
      return;
    case 'test-wasm': {
      const summary = await generateRuntime({ projectConfig, wasmMode: 'dev' });
      if (summary.rustCellCount === 0) {
        console.log('[runtime] no Rust cells; skipping wasm-pack test');
      } else {
        await runCommand('wasm-pack', ['test', '--node', pathFromUrl(paths.rustCellsDir), '--locked'], {
          cwd: pathFromUrl(paths.workspaceRoot)
        });
      }

      if (summary.haskellCellCount === 0) {
        console.log('[runtime] no Haskell cells; skipping Haskell/WASI test');
      } else {
        const result = await testGeneratedHaskellCells({
          expectedFingerprint: summary.haskellFingerprint,
          paths
        });
        console.log(`[runtime] tested ${result.cellCount} generated Haskell cell(s)`);
      }
      return;
    }
  }
}

function normalizeRunCliArguments(commandOrArgs, argsOrOptions, legacyOptions) {
  if (typeof commandOrArgs === 'string') {
    return {
      args: [commandOrArgs, ...(Array.isArray(argsOrOptions) ? argsOrOptions : [])],
      options: legacyOptions
    };
  }
  return { args: commandOrArgs, options: argsOrOptions };
}

async function generateRuntime({
  ownershipFields = ['cacheDir', 'publicAssetsDir'],
  projectConfig,
  tolerateHaskellBuildFailure = false,
  wasmMode
}) {
  const { paths } = projectConfig;
  await prepareCleanupOwnership({
    configFile: projectConfig.configFile,
    fields: ownershipFields,
    paths
  });
  const context = await createDocRuntimeContext({ paths, pythonOptions: projectConfig.python });
  const summary = await syncDocRuntime({
    ...context,
    mode: wasmMode,
    tolerateHaskellBuildFailure
  });
  console.log(`Generated ${summary.cellCount} interactive cell(s).`);
  if (summary.haskellBuildResult) warnToleratedHaskellBuildFailure(summary.haskellBuildResult);
  return summary;
}

function warnToleratedHaskellBuildFailure(result) {
  if (result.ok) return;
  console.warn(`[runtime] Haskell/WASI runtime unavailable: ${result.error.message}`);
}

async function runDevServer({ args, projectConfig, runCommand, selectNode }) {
  const { paths } = projectConfig;
  const nodePath = selectNode(paths);
  const env = frameworkEnv(paths, { nodePath });
  const { watchDocRuntime } = await import('../generator/watch-doc-runtime.mjs');
  const watcher = await watchDocRuntime({ projectConfig, skipInitial: true });

  try {
    await runCommand(nodePath, [frameworkBinScript(paths, 'astro'), 'dev', ...args], {
      cwd: projectConfig.cwd,
      env,
      successfulSignals: ['SIGTERM']
    });
  } finally {
    await watcher.close();
  }
}

async function runAstro(projectConfig, args, { runCommand, runtimeOwner, selectNode }) {
  const { paths } = projectConfig;
  const nodePath = selectNode(paths);

  await runCommand(nodePath, [frameworkBinScript(paths, 'astro'), ...args], {
    cwd: projectConfig.cwd,
    env: frameworkEnv(paths, { nodePath, runtimeOwner })
  });
}

async function runOxiquillCheck(projectConfig, args, { runCommand, selectNode }) {
  const { paths } = projectConfig;
  await runAstro(projectConfig, ['sync', ...projectConfig.astroConfigArgs], { runCommand, selectNode });

  const { check, parseArgsAsCheckConfig } = await importFromFramework(paths, '@astrojs/check');
  const config = parseArgsAsCheckConfig(['node', 'oxiquill-check', ...args]);
  config.root = pathFromUrl(paths.workspaceRoot);

  console.info(`Getting diagnostics for Astro files in ${config.root}...`);
  if (await check(config)) {
    throw new Error('Astro check reported diagnostics.');
  }
}

async function importFromFramework(paths, specifier) {
  return import(pathToFileURL(resolveFromFramework(paths, specifier)).href);
}

function resolveFromFramework(paths, specifier) {
  const require = createRequire(pathInUrl(paths.frameworkRoot, 'package.json'));
  return require.resolve(specifier);
}

function resolveFromWorkspaceOrFramework(paths, specifier) {
  const workspacePackageJsonPath = pathInUrl(paths.workspaceRoot, 'package.json');
  if (existsSync(workspacePackageJsonPath)) {
    const require = createRequire(workspacePackageJsonPath);
    try {
      return require.resolve(specifier);
    } catch {
      // Fall back to Oxiquill's own framework dependencies.
    }
  }

  return resolveFromFramework(paths, specifier);
}

function frameworkNode(paths) {
  return selectFrameworkNode(paths);
}

export function selectFrameworkNode(
  paths,
  { env = process.env, execPath = process.execPath, exists = existsSync, spawn = spawnSync, warn = console.warn } = {}
) {
  const vitePath = resolveFromFramework(paths, 'vite');
  const probeEnv = frameworkEnv(paths, { env });
  const overridePath = env.OXIQUILL_NODE;
  const candidates = overridePath
    ? [overridePath]
    : nodeExecutableCandidates({ execPath, exists, pathValue: env.PATH });
  const selected = candidates.find((candidate) =>
    canLoadNativePackage(candidate, vitePath, { cwd: pathFromUrl(paths.workspaceRoot), env: probeEnv, spawn })
  );

  if (selected) {
    if (!overridePath && realpathSafe(selected) !== realpathSafe(execPath)) {
      warn(`[oxiquill] Using ${selected} for Astro/Vite because ${execPath} cannot load Rollup native addons.`);
    }
    return selected;
  }

  const overrideDetail = overridePath ? ` OXIQUILL_NODE is set to ${overridePath}, but it failed the same probe.` : '';
  throw new Error(
    `Astro/Vite requires a Node.js runtime that can load native addons, but ${execPath} could not load Vite/Rollup.${overrideDetail} ` +
      'If ghc-wasm placed its static Node first in PATH, set OXIQUILL_NODE to a normal Node.js binary or place that Node earlier in PATH.'
  );
}

export function nodeExecutableCandidates({
  execPath = process.execPath,
  pathValue = process.env.PATH,
  platform = process.platform,
  exists = existsSync
} = {}) {
  const executableNames = platform === 'win32' ? ['node.exe', 'node.cmd', 'node'] : ['node'];
  const candidates = [execPath];

  for (const directory of (pathValue ?? '').split(path.delimiter).filter(Boolean)) {
    for (const executableName of executableNames) {
      candidates.push(path.join(directory, executableName));
    }
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    if (!exists(candidate)) return false;

    const key = realpathSafe(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function canLoadNativePackage(
  nodePath,
  packagePath,
  { cwd = process.cwd(), env = process.env, spawn = spawnSync } = {}
) {
  const packageUrl = pathToFileURL(packagePath).href;
  const result = spawn(nodePath, ['-e', 'import(process.argv[1]).catch(() => process.exit(1));', packageUrl], {
    cwd,
    env,
    stdio: 'ignore'
  });

  return result.status === 0;
}

function frameworkBinScript(paths, packageName, binName = packageName) {
  const packageJsonPath = resolveFromWorkspaceOrFramework(paths, `${packageName}/package.json`);
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];

  if (!binPath) {
    throw new Error(`Package "${packageName}" does not define a "${binName}" bin.`);
  }

  return path.resolve(path.dirname(packageJsonPath), binPath);
}

export function frameworkEnv(paths, { env = process.env, nodePath, runtimeOwner } = {}) {
  const frameworkNodePath = pathInUrl(paths.frameworkRoot, 'node_modules');
  const currentNodePath = env.NODE_PATH;
  const nextEnv = {
    ...env,
    NODE_PATH: currentNodePath ? `${frameworkNodePath}${path.delimiter}${currentNodePath}` : frameworkNodePath
  };

  if (nodePath) {
    const pathKey = Object.keys(nextEnv).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
    const currentPath = nextEnv[pathKey];
    nextEnv[pathKey] = currentPath
      ? `${path.dirname(nodePath)}${path.delimiter}${currentPath}`
      : path.dirname(nodePath);
  }

  if (runtimeOwner) nextEnv.OXIQUILL_RUNTIME_OWNER = runtimeOwner;

  return nextEnv;
}

function runCommandWithInheritedStdio(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: 'inherit'
    });

    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0 || options.successfulSignals?.includes(signal)) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      }
    });
  });
}

async function installedPackageVersion() {
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
  return packageJson.version;
}

export function isCliEntrypoint(argvPath = process.argv[1], moduleUrl = import.meta.url) {
  if (!argvPath) return false;

  return realpathSafe(argvPath) === realpathSafe(fileURLToPath(moduleUrl));
}

function realpathSafe(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return filePath;
  }
}
