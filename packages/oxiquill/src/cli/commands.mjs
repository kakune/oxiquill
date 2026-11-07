import { createRuntimeEvents, summarizePhases } from '../generator/doc-runtime/runtime-events.mjs';
import { runProcess } from '../generator/doc-runtime/process-runner.mjs';
import { createEventReporter } from './events.mjs';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { resolveAstroVite } from '../config/astro-vite.mjs';
import { loadOxiquillProjectConfig } from '../config/project-config.mjs';
import { createDocRuntimeContext, syncDocRuntime } from '../generator/doc-runtime-service.mjs';
import { cleanOxiquillWorkspace } from '../generator/clean.mjs';
import { prepareCleanupOwnership } from '../generator/cleanup-ownership.mjs';
import { runHelperCargo } from '../generator/run-helper-cargo.mjs';
import { runWasmTests } from './test-wasm.mjs';
import { runLinkCheck } from './check-links.mjs';
import { debugRequested, formatCliError, formatCliHelp, parseCliArguments } from './arguments.mjs';
import { initializeProject } from './init.mjs';
import { acquireRuntimeLock, withRuntimeLock } from '../generator/runtime-lock.mjs';

export async function runCli(commandOrArgs = [], argsOrOptions = {}, legacyOptions = {}) {
  const { args, options } = normalizeRunCliArguments(commandOrArgs, argsOrOptions, legacyOptions);
  let events;
  let exitStatus = 0;
  let cancellationStatus;
  let finished = false;
  let commandName;
  const makeEvents = (format) => {
    const render = createEventReporter({ format, write: options.log });
    return createRuntimeEvents({
      report: (event) => {
        if (!finished) render(event);
      }
    });
  };
  const finish = (status, cancelled = false) => {
    if (!events || finished) return;
    if (cancelled) events.failActive?.();
    const command = args.find((arg) => ['build', 'check', 'docgen'].includes(arg));
    const expected =
      commandName === 'check-links'
        ? []
        : [
            'discovery',
            'validation',
            'generation',
            'compile',
            'optimize',
            'publish',
            ...(command !== 'docgen' ? ['astro-check'] : []),
            ...(command === 'build' ? ['astro-build'] : [])
          ];
    for (const phase of expected)
      if (!events.phases.some((entry) => entry.phase === phase)) {
        events.skipped(phase, { reason: status ? 'upstream-failed' : 'not-required' });
      }
    events.report({
      type: 'summary',
      ...(commandName === 'check-links' ? {} : { phases: summarizePhases(events.phases) }),
      ...(events.linkCheck ? { linkCheck: events.linkCheck } : {}),
      exitStatus: status
    });
    finished = true;
  };
  try {
    const parsed = parseCliArguments(args);
    commandName = parsed.commandName;
    const reporting =
      parsed.action === 'run' && ['build', 'check', 'docgen', 'check-links'].includes(parsed.commandName);
    if (reporting) events = options.events ?? makeEvents(parsed.values.format);
    return await runCliCommand(args, {
      ...options,
      parsed,
      events,
      format: parsed.values?.format ?? 'human',
      ...(events
        ? {
            onSignalExit: (signal) => {
              cancellationStatus = signal === 'SIGINT' ? 130 : 143;
              finish(cancellationStatus, true);
            }
          }
        : {})
    });
  } catch (cause) {
    const error = cause instanceof Error ? cause : new Error(String(cause), { cause });
    exitStatus = cancellationStatus ?? error.exitCode ?? 1;
    if (cancellationStatus) error.exitCode = cancellationStatus;
    if (
      !events &&
      args.some((arg) => ['build', 'check', 'docgen', 'check-links'].includes(arg)) &&
      (args.includes('--format=json') || args.some((arg, index) => arg === '--format' && args[index + 1] === 'json'))
    ) {
      commandName = args.find((arg) => ['build', 'check', 'docgen', 'check-links'].includes(arg));
      events = makeEvents('json');
    }
    if (events) {
      events.report({ type: 'diagnostic', message: formatCliError(error, { debug: debugRequested(args) }) });
      error.reported = true;
    }
    throw error;
  } finally {
    finish(exitStatus);
  }
}

async function runCliCommand(commandOrArgs = [], argsOrOptions = {}, legacyOptions = {}) {
  const { args, options } = normalizeRunCliArguments(commandOrArgs, argsOrOptions, legacyOptions);
  const {
    cwd = process.cwd(),
    acquireLock = acquireRuntimeLock,
    initialize = initializeProject,
    generate = generateProjectRuntime,
    loadPackageVersion = installedPackageVersion,
    loadCheck,
    loadProjectConfig = loadOxiquillProjectConfig,
    log = console.log,
    events,
    onSignalExit,
    format = 'human',
    runCommand: executeCommand = runProcess,
    selectNode = frameworkNode
  } = options;
  const parsed = options.parsed ?? parseCliArguments(args);

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

  const lease =
    !values.explain && ['build', 'check', 'docgen', 'clean', 'test-wasm'].includes(command)
      ? await acquireLock({
          paths,
          configFile: projectConfig.configFile,
          command,
          ...(events ? { log: (message) => events.report({ type: 'diagnostic', message }) } : {}),
          ...(onSignalExit ? { onSignalExit } : {}),
          timeout: values['lock-timeout'] === undefined ? 1800 : Number(values['lock-timeout'])
        })
      : undefined;
  const runCommand = (command, args, settings) =>
    executeCommand(command, args, { events, format, ...settings, trackChild: lease?.trackChild });
  const generateRuntime = (settings) =>
    values.explain
      ? generate({ ...settings, events, format, explain: true })
      : lease
        ? generate({ ...settings, events, format, trackChild: lease.trackChild })
        : withRuntimeLock(
            { paths, configFile: projectConfig.configFile, command, timeout: Infinity },
            ({ trackChild }) => generate({ ...settings, trackChild })
          );

  try {
    if (values.explain) {
      await generateRuntime({
        projectConfig,
        wasmMode: command === 'build' ? 'build' : command === 'check' ? 'dev' : values.wasm
      });
      if (command !== 'docgen') events.skipped('astro-check', { reason: 'explain' });
      if (command === 'build') events.skipped('astro-build', { reason: 'explain' });
      return;
    }
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
      case 'check-links':
        await runLinkCheck({ paths, events });
        return;
      case 'build': {
        const { generationId } = await generateRuntime({
          ownershipFields: ['cacheDir', 'outDir', 'publicAssetsDir'],
          projectConfig,
          wasmMode: 'build'
        });
        await events.phase('astro-check', {}, () =>
          runOxiquillCheck(projectConfig, [], {
            generationId,
            loadCheck,
            lockToken: lease.token,
            runCommand,
            selectNode
          })
        );
        await events.phase('astro-build', {}, () =>
          runAstro(projectConfig, ['build', ...astroArgs], {
            generationId,
            runCommand,
            runtimeOwner: 'cli',
            lockToken: lease.token,
            selectNode
          })
        );
        if (values['check-links']) await events.phase('check-links', {}, () => runLinkCheck({ paths, events }));
        return;
      }
      case 'check': {
        const { generationId } = await generateRuntime({ projectConfig, wasmMode: 'dev' });
        await events.phase('astro-check', {}, () =>
          runOxiquillCheck(projectConfig, commandArgs, {
            generationId,
            lockToken: lease.token,
            loadCheck,
            runCommand,
            selectNode
          })
        );
        return;
      }
      case 'docgen':
        await generateRuntime({ projectConfig, wasmMode: values.wasm });
        return;
      case 'clean':
        await cleanOxiquillWorkspace({ configFile: projectConfig.configFile, paths, lockToken: lease.token });
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
        await runHelperCargo({ argv: ['fmt', '--all', '--', '--check'], paths });
        await runHelperCargo({ argv: ['clippy', '--all-targets', '--', '-D', 'warnings'], paths });
        return;
      case 'doc-rust':
        await runHelperCargo({ argv: ['doc', '--no-deps'], paths });
        return;
      case 'test-wasm': {
        await runWasmTests({ projectConfig, values, generateRuntime, log });
        return;
      }
    }
  } finally {
    lease?.release();
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

async function generateProjectRuntime({
  ownershipFields = ['cacheDir', 'publicAssetsDir'],
  projectConfig,
  tolerateHaskellBuildFailure = false,
  wasmMode,
  log = console.log,
  runtimeOptions = {},
  events,
  format,
  explain = false,
  trackChild
}) {
  const { paths } = projectConfig;
  if (!explain)
    await prepareCleanupOwnership({
      configFile: projectConfig.configFile,
      fields: ownershipFields,
      paths
    });
  const context = await createDocRuntimeContext({
    paths,
    pythonOptions: projectConfig.python,
    rustOptions: projectConfig.rust
  });
  try {
    const summary = await syncDocRuntime({
      ...context,
      ...runtimeOptions,
      events,
      format,
      explain,
      trackChild,
      mode: wasmMode,
      tolerateHaskellBuildFailure
    });
    if (events)
      events.report({
        type: 'diagnostic',
        message: `${explain ? 'Planned' : 'Generated'} ${summary.cellCount} interactive cell(s).`
      });
    else log(`Generated ${summary.cellCount} interactive cell(s).`);
    if (summary.haskellBuildResult) warnToleratedHaskellBuildFailure(summary.haskellBuildResult);
    return summary;
  } finally {
    context.highlighter?.dispose?.();
  }
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

async function runAstro(projectConfig, args, { generationId, lockToken, runCommand, runtimeOwner, selectNode }) {
  const { paths } = projectConfig;
  const nodePath = selectNode(paths);

  await runCommand(nodePath, [frameworkBinScript(paths, 'astro'), ...args], {
    cwd: projectConfig.cwd,
    source: 'astro',
    phase: args[0] === 'build' ? 'astro-build' : 'astro-check',
    env: frameworkEnv(paths, { generationId, lockToken, nodePath, runtimeOwner })
  });
}

async function runOxiquillCheck(projectConfig, args, { generationId, lockToken, loadCheck, runCommand, selectNode }) {
  const { paths } = projectConfig;
  await runAstro(projectConfig, ['sync', ...projectConfig.astroConfigArgs], {
    generationId,
    lockToken,
    runtimeOwner: 'cli',
    runCommand,
    selectNode
  });

  if (!loadCheck) {
    const nodePath = selectNode(paths);
    await runCommand(
      nodePath,
      [frameworkBinScript(paths, '@astrojs/check', 'astro-check'), '--root', paths.workspaceRoot, ...args],
      {
        cwd: projectConfig.cwd,
        source: 'astro-check',
        phase: 'astro-check',
        env: frameworkEnv(paths, { generationId, lockToken, nodePath, runtimeOwner: 'cli' })
      }
    );
    return;
  }
  const { check, parseArgsAsCheckConfig } = await loadCheck(paths, '@astrojs/check');
  const config = parseArgsAsCheckConfig(['node', 'oxiquill-check', ...args]);
  config.root = pathFromUrl(paths.workspaceRoot);

  console.info(`Getting diagnostics for Astro files in ${config.root}...`);
  const inherited = {
    OXIQUILL_GENERATION_ID: generationId,
    OXIQUILL_LOCK_TOKEN: lockToken,
    OXIQUILL_RUNTIME_OWNER: 'cli'
  };
  const previous = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
  try {
    Object.entries(inherited).forEach(([key, value]) => {
      if (value !== undefined) process.env[key] = value;
    });
    if (await check(config)) throw new Error('Astro check reported diagnostics.');
    // @astrojs/check returns after its initial lint even when its watcher remains active.
    // Keep the command's lock and environment until that process exits.
    if (config.watch) await new Promise(() => {});
  } finally {
    Object.entries(previous).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  }
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
  const vitePath = resolveAstroVite(pathInUrl(paths.frameworkRoot, 'package.json'));
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
  let packageJsonPath;
  try {
    packageJsonPath = resolveFromWorkspaceOrFramework(paths, `${packageName}/package.json`);
  } catch (error) {
    if (error?.code !== 'ERR_PACKAGE_PATH_NOT_EXPORTED') throw error;
    let directory = path.dirname(resolveFromWorkspaceOrFramework(paths, packageName));
    while (directory !== path.dirname(directory)) {
      const candidate = path.join(directory, 'package.json');
      if (existsSync(candidate) && JSON.parse(readFileSync(candidate, 'utf8')).name === packageName) {
        packageJsonPath = candidate;
        break;
      }
      directory = path.dirname(directory);
    }
    if (!packageJsonPath) throw error;
  }
  const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  const binPath = typeof packageJson.bin === 'string' ? packageJson.bin : packageJson.bin?.[binName];

  if (!binPath) {
    throw new Error(`Package "${packageName}" does not define a "${binName}" bin.`);
  }

  return path.resolve(path.dirname(packageJsonPath), binPath);
}

export function frameworkEnv(paths, { env = process.env, generationId, lockToken, nodePath, runtimeOwner } = {}) {
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

  if (generationId) nextEnv.OXIQUILL_GENERATION_ID = generationId;
  if (runtimeOwner) nextEnv.OXIQUILL_RUNTIME_OWNER = runtimeOwner;
  if (lockToken) nextEnv.OXIQUILL_LOCK_TOKEN = lockToken;

  return nextEnv;
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
