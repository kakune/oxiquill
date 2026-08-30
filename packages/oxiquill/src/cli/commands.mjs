import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import { createDocRuntimeContext, syncDocRuntime } from '../generator/doc-runtime-service.mjs';
import { cleanOxiquillWorkspace } from '../generator/clean.mjs';
import { runHelperCargo } from '../generator/run-helper-cargo.mjs';
import { parseConfigOption } from './config-option.mjs';

const projectCommands = new Set([
  'dev',
  'dev:runtime',
  'dev:astro',
  'preview',
  'build',
  'check',
  'docgen',
  'clean',
  'test-rust',
  'test-rust-coverage',
  'lint-rust',
  'doc-rust',
  'test-wasm'
]);

export async function runCli(
  command,
  args = [],
  {
    cwd = process.cwd(),
    loadProjectConfig = loadOxiquillProjectConfig,
    runCommand = runCommandWithInheritedStdio,
    selectNode = frameworkNode
  } = {}
) {
  if (command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }
  if (!projectCommands.has(command)) {
    throw new Error(`Unknown oxiquill command "${command}".`);
  }

  const { commandArgs, configFile } = parseConfigOption(args);
  const projectConfig = await loadProjectConfig({ cwd, configFile });
  const paths = projectConfig.paths;
  const astroArgs = [...projectConfig.astroConfigArgs, ...commandArgs];

  switch (command) {
    case 'dev':
      await generateRuntime({ projectConfig, tolerateHaskellBuildFailure: true, wasmMode: 'dev' });
      await runDevServer({ args: astroArgs, projectConfig, selectNode });
      return;
    case 'dev:runtime': {
      const { watchDocRuntime } = await import('../generator/watch-doc-runtime.mjs');
      await watchDocRuntime({
        projectConfig,
        skipInitial: commandArgs.includes('--skip-initial')
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
      await generateRuntime({ projectConfig, wasmMode: 'build' });
      await runOxiquillCheck(projectConfig, [], { runCommand, selectNode });
      await runAstro(projectConfig, ['build', ...astroArgs], { runCommand, runtimeOwner: 'cli', selectNode });
      return;
    case 'check':
      await generateRuntime({ projectConfig, wasmMode: 'dev' });
      await runOxiquillCheck(projectConfig, commandArgs, { runCommand, selectNode });
      return;
    case 'docgen':
      await generateRuntime({ projectConfig, wasmMode: parseWasmMode(commandArgs) });
      return;
    case 'clean':
      await cleanOxiquillWorkspace({ paths });
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
    case 'test-wasm':
      if ((await generateRuntime({ projectConfig, wasmMode: 'dev' })).rustCellCount === 0) {
        console.log('[runtime] no Rust cells; skipping wasm-pack test');
        return;
      }
      await runCommand('wasm-pack', ['test', '--node', pathFromUrl(paths.rustCellsDir)], {
        cwd: pathFromUrl(paths.workspaceRoot)
      });
      return;
  }
}

async function generateRuntime({ projectConfig, tolerateHaskellBuildFailure = false, wasmMode }) {
  const { paths } = projectConfig;
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

async function runDevServer({ args, projectConfig, selectNode }) {
  const { paths } = projectConfig;
  const nodePath = selectNode(paths);
  const env = frameworkEnv(paths, { nodePath });
  const { watchDocRuntime } = await import('../generator/watch-doc-runtime.mjs');
  const watcher = await watchDocRuntime({ projectConfig, skipInitial: true });
  const child = spawn(nodePath, [frameworkBinScript(paths, 'astro'), 'dev', ...args], {
    cwd: projectConfig.cwd,
    env,
    stdio: 'inherit'
  });

  try {
    await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        if (code === 0 || signal === 'SIGTERM') {
          resolve();
        } else {
          reject(new Error(`dev child exited with ${signal ?? code}`));
        }
      });
    });
  } finally {
    if (!child.killed) child.kill('SIGTERM');
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

function parseWasmMode(args) {
  const wasmIndex = args.indexOf('--wasm');
  if (wasmIndex === -1) return undefined;

  const mode = args[wasmIndex + 1];
  if (mode === 'dev' || mode === 'build') return mode;

  throw new Error('--wasm must be followed by "dev" or "build".');
}

function printHelp() {
  console.log(
    'Usage: oxiquill <dev|build|check|docgen|clean|test-rust|lint-rust|doc-rust|test-wasm> [--config <path>]'
  );
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
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      }
    });
  });
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
