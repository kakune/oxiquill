import path from 'node:path';
import { pathFromUrl } from '../../config/paths.mjs';
import {
  cdylibWasm,
  isBuildScriptMessage,
  isErrorMessage,
  messageGroup,
  parseCargoMessage
} from './cargo-messages.mjs';
import { cargoEnvironment } from './compiler-cache.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { runProcess } from './process-runner.mjs';
import { createRuntimeEvents } from './runtime-events.mjs';
import { createTaskPool, postLinkParallelism, wasmOptThreads } from './task-pool.mjs';
import { ensureToolDownload } from './tool-downloads.mjs';
import { optimizeRustWasmFiles, pruneWasmOptCache } from './wasm-opt-cache.mjs';

export const RUST_MODULE_OUTPUT_NAME = 'doc_rust_cells';
// Windows limits a command line to 32,767 characters; stay well below it.
const MAX_PACKAGE_ARGUMENT_LENGTH = 24_000;
const MAX_MESSAGES_PER_GROUP = 50;

// Cargo unifies dependency features across the packages of one invocation.
// Selecting the stale modules plus one module per helper crate reproduces the
// feature set of a clean build that selects every module.
export function cargoBuildSelection({ stale, members, representatives = [], exclude = [] }) {
  const selected = [...new Set([...stale.map((group) => group.packageName), ...representatives])].sort();
  const length = selected.reduce((total, name) => total + name.length + 11, 0);
  if (selected.length >= members.length || length > MAX_PACKAGE_ARGUMENT_LENGTH)
    return ['--workspace', ...[...exclude].sort().flatMap((name) => ['--exclude', name])];
  return selected.flatMap((name) => ['--package', name]);
}

export function cargoBuildArguments({ paths, mode, selection, messageFormat = 'json' }) {
  return [
    'build',
    '--manifest-path',
    path.join(pathFromUrl(paths.rustCellsDir), 'Cargo.toml'),
    '--target',
    'wasm32-unknown-unknown',
    '--locked',
    '--keep-going',
    `--message-format=${messageFormat}`,
    ...(mode === 'build' ? ['--release'] : []),
    ...selection
  ];
}

// Compiles the stale modules in one Cargo invocation. Post-link work (bindgen,
// release optimization, content-addressed finalization) starts for each module
// as soon as Cargo reports its artifact and runs in a bounded pool.
export async function buildRustModules({
  groups,
  members = groups,
  representatives = [],
  exclude = [],
  paths,
  stageDir,
  mode,
  toolchain = {},
  finalize,
  environment = process.env,
  fileSystem = defaultFileSystem,
  runCommand = runProcess,
  events = createRuntimeEvents(),
  format = 'human',
  stderr = process.stderr,
  parallelism = postLinkParallelism(environment),
  ensureTool = ensureToolDownload,
  optimize = optimizeRustWasmFiles,
  prune = pruneWasmOptCache
}) {
  if (!groups.length) return { results: [], dependencyMessages: [], maxConcurrency: 0 };
  const env = cargoEnvironment({ environment, paths });
  const execute = (command, args, options = {}) =>
    runCommand(command, args, {
      env,
      cwd: pathFromUrl(paths.workspaceRoot),
      events,
      format,
      language: 'rust',
      ...options
    });
  const { wasmBindgen, wasmOpt } = toolchain;
  if (!wasmBindgen?.command) throw new Error('Rust module builds require the pinned wasm-bindgen CLI.');
  if (mode === 'build' && !wasmOpt?.command) throw new Error('Rust release builds require wasm-opt.');
  // Verified tool downloads overlap with compilation; post-link jobs await them.
  const tools = Promise.all([
    wasmBindgen.url ? ensureTool(wasmBindgen, { fileSystem, runCommand: execute }) : undefined,
    mode === 'build' && wasmOpt.url
      ? ensureTool(wasmOpt, { fileSystem, runCommand: execute, processOptions: { phase: 'optimize' } })
      : undefined
  ]);
  tools.catch(() => {});
  const pool = createTaskPool(parallelism.pool);
  const threads = wasmOptThreads({ cores: parallelism.cores, pool: parallelism.pool, staleCount: groups.length });
  const optimizerEnvironment = env.BINARYEN_CORES === undefined ? { ...env, BINARYEN_CORES: String(threads) } : env;
  const lookup = {
    byCrate: new Map(groups.map((group) => [group.crateName, group])),
    byId: new Map(groups.map((group) => [group.id, group]))
  };
  const state = new Map(groups.map((group) => [group.id, { messages: [], job: undefined }]));
  const dependencyMessages = [];
  let finished;
  const render = (rendered) => {
    if (!rendered) return;
    if (format === 'json')
      rendered
        .replace(/\n$/u, '')
        .split('\n')
        .forEach((line) => events.report({ type: 'output', source: 'rustc', stream: 'stderr', line }));
    else stderr.write(rendered.endsWith('\n') ? rendered : `${rendered}\n`);
  };
  const postLink = (group, wasm) =>
    pool.run(async () => {
      await tools;
      const directory = path.join(stageDir, group.id);
      await fileSystem.rm(directory, { recursive: true, force: true });
      await fileSystem.mkdir(directory, { recursive: true });
      const context = { language: 'rust', module: group.id };
      await events.phase('generation', context, () =>
        execute(
          wasmBindgen.command,
          [
            wasm,
            '--target',
            'web',
            '--no-typescript',
            '--out-dir',
            directory,
            '--out-name',
            RUST_MODULE_OUTPUT_NAME,
            ...(mode === 'build' ? [] : ['--debug', '--keep-debug'])
          ],
          { module: group.id, source: 'wasm-bindgen', phase: 'generation' }
        )
      );
      if (mode === 'build')
        await optimize({
          directory,
          cacheDir: pathFromUrl(paths.wasmOptCacheDir),
          cwd: pathFromUrl(paths.workspaceRoot),
          optimizer: wasmOpt,
          environment: optimizerEnvironment,
          runCommand: execute,
          fileSystem,
          events,
          context,
          prune: false
        });
      else events.skipped('optimize', { ...context, reason: 'dev' });
      return finalize(group, directory);
    });
  let streamed = false;
  // Only queues work; the process runner must never wait on this callback.
  const onStdoutLine = (line) => {
    streamed = true;
    const message = parseCargoMessage(line);
    if (!message) return;
    if (message.reason === 'build-finished') {
      finished = message.success === true;
      return;
    }
    if (message.reason === 'compiler-message') {
      render(message.message?.rendered);
      if (!isErrorMessage(message)) return;
      const group = messageGroup(message, lookup);
      const entry = { ...message.message, targetFile: message.target?.src_path };
      if (group) {
        const target = state.get(group.id).messages;
        if (target.length < MAX_MESSAGES_PER_GROUP) target.push(entry);
      } else
        dependencyMessages.push({
          package: message.package_id,
          target: message.target?.name,
          buildScript: isBuildScriptMessage(message),
          message: entry
        });
      return;
    }
    if (message.reason !== 'compiler-artifact') return;
    const group = messageGroup(message, lookup);
    const wasm = group ? cdylibWasm(message) : undefined;
    const entry = group && state.get(group.id);
    if (!wasm || entry.job) return;
    entry.job = postLink(group, wasm);
    entry.job.catch(() => {});
  };
  let cargoError;
  try {
    const output = await events.phase('compile', { language: 'rust' }, () =>
      execute(
        'cargo',
        cargoBuildArguments({
          paths,
          mode,
          selection: cargoBuildSelection({ stale: groups, members, representatives, exclude }),
          messageFormat: format === 'human' && stderr.isTTY ? 'json-diagnostic-rendered-ansi' : 'json'
        }),
        { source: 'cargo', phase: 'compile', onStdoutLine }
      )
    );
    // Runners that capture instead of streaming still report every artifact.
    if (!streamed && typeof output === 'string') output.split(/\r?\n/u).forEach(onStdoutLine);
  } catch (error) {
    if (error?.name === 'AbortError') {
      await pool.idle();
      throw error;
    }
    if (!streamed && typeof error?.stdout === 'string') error.stdout.split(/\r?\n/u).forEach(onStdoutLine);
    cargoError = error;
  }
  await pool.idle();
  if (mode === 'build')
    await prune({
      cacheDir: pathFromUrl(paths.wasmOptCacheDir),
      fileSystem,
      keep: 2 * members.length
    }).catch(() => {});
  const buildScriptFailure = dependencyMessages.some((entry) => entry.buildScript);
  const results = [];
  for (const group of [...groups].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const { job, messages } = state.get(group.id);
    if (job) {
      try {
        results.push({ group, ok: true, value: await job });
      } catch (error) {
        results.push({ group, ok: false, kind: 'tool', messages: [], error });
      }
      continue;
    }
    // Only deterministic compiler errors may be remembered between dev syncs.
    const kind =
      finished === false && !buildScriptFailure && (messages.length || dependencyMessages.length)
        ? messages.length
          ? 'compile'
          : 'dependency'
        : 'cargo';
    results.push({
      group,
      ok: false,
      kind,
      messages,
      error: cargoError ?? new Error(`cargo did not produce a Wasm artifact for ${group.packageName}.`)
    });
  }
  return { results, dependencyMessages, cargoError, maxConcurrency: pool.maxActive };
}
