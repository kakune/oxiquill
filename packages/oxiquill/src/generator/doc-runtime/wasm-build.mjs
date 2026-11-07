import { trackRuntimeCommand } from '../runtime-lock.mjs';
import path from 'node:path';
import { runProcess } from './process-runner.mjs';
import { createRuntimeEvents } from './runtime-events.mjs';
import { ensureToolDownload } from './tool-downloads.mjs';
import { optimizeRustWasmFiles, resolveWasmOpt } from './wasm-opt-cache.mjs';
import { createOxiquillPaths, pathFromUrl, pathInUrl } from '../../config/paths.mjs';
import { postprocessRustWasm } from '../postprocess-rust-wasm.mjs';
import { defaultFileSystem, writeIfChanged } from './file-system.mjs';
import { hashText } from './hashing.mjs';
import { haskellCacheDirectory, syncHaskellCacheSources, wasmPackEnvironment } from './compiler-cache.mjs';

export const HASKELL_WASI_COMPILER = 'wasm32-wasi-ghc';
export const HASKELL_WASI_COMPILER_ENV = 'OXIQUILL_HASKELL_GHC';
export const HASKELL_WASM_FILE = 'doc_haskell_cells.wasm';
export const HASKELL_RUNTIME_STATUS_FILE = 'status.json';

export class MissingHaskellWasiCompilerError extends Error {
  constructor(command, options = {}) {
    super(
      [
        `Haskell WASI compiler "${command}" was not found.`,
        `Install ${HASKELL_WASI_COMPILER}, source ~/.ghc-wasm/env if using ghc-wasm-meta,`,
        `or set ${HASKELL_WASI_COMPILER_ENV} to the compiler path.`
      ].join(' '),
      options
    );
    this.name = 'MissingHaskellWasiCompilerError';
    this.code = 'OXIQUILL_MISSING_HASKELL_WASI_GHC';
    this.command = command;
  }
}

export class HaskellWasmBuildError extends Error {
  constructor(command, error) {
    const message = error instanceof Error && error.message ? error.message : String(error);
    super(`Haskell WASI runtime build failed with ${command}: ${message}`, { cause: error });
    this.name = 'HaskellWasmBuildError';
    this.command = command;
  }
}

export async function buildRustWasm({
  fileSystem = defaultFileSystem,
  wasmOpt,
  environment = process.env,
  mode,
  paths,
  postprocess = postprocessRustWasm,
  root = process.cwd(),
  runCommand = runProcess,
  events = createRuntimeEvents(),
  format = 'human',
  trackChild
}) {
  const execute = trackRuntimeCommand(runCommand, trackChild);
  runCommand = (command, args, options) =>
    execute(command, args, { events, format, language: 'rust', module: 'site', phase: 'compile', ...options });
  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const modeFlag = mode === 'build' ? '--release' : '--dev';
  const env = wasmPackEnvironment({ environment, paths: resolvedPaths });
  const optimizer =
    mode === 'build'
      ? (wasmOpt ??
        (await resolveWasmOpt({
          environment: env,
          cwd: pathFromUrl(resolvedPaths.workspaceRoot),
          fileSystem,
          runCommand,
          provision: true,
          paths: resolvedPaths
        })))
      : undefined;
  await events.phase('compile', { language: 'rust', module: 'site' }, () =>
    runCommand(
      'wasm-pack',
      [
        'build',
        pathFromUrl(resolvedPaths.rustCellsDir),
        '--target',
        'web',
        modeFlag,
        '--out-dir',
        pathFromUrl(resolvedPaths.rustWasmPublicDir),
        '--out-name',
        'doc_rust_cells',
        ...(optimizer?.command ? ['--no-opt'] : []),
        '--locked'
      ],
      { cwd: pathFromUrl(resolvedPaths.workspaceRoot), env }
    )
  );
  if (optimizer?.command) {
    if (optimizer.url)
      await ensureToolDownload(optimizer, {
        fileSystem,
        runCommand,
        processOptions: { env, events, format, phase: 'optimize', language: 'rust', module: 'site' }
      });
    await optimizeRustWasmFiles({
      events,
      context: { language: 'rust', module: 'site' },
      directory: pathFromUrl(resolvedPaths.rustWasmPublicDir),
      cacheDir: resolvedPaths.wasmOptCacheDir,
      cwd: pathFromUrl(resolvedPaths.workspaceRoot),
      optimizer,
      environment: env,
      runCommand,
      fileSystem
    });
  } else
    events.skipped('optimize', {
      language: 'rust',
      module: 'site',
      reason: mode === 'build' ? 'managed-by-wasm-pack' : 'dev'
    });
  await postprocess({ rustWasmDir: pathFromUrl(resolvedPaths.rustWasmPublicDir) });
}

export async function buildRustGroups({
  groups,
  paths,
  mode,
  wasmBindgen,
  wasmOpt,
  environment = process.env,
  fileSystem = defaultFileSystem,
  runCommand = runProcess,
  events = createRuntimeEvents(),
  format = 'human',
  trackChild,
  postprocess = postprocessRustWasm
}) {
  const invalid = groups.filter((group) => group.public === 'build');
  if (!invalid.length) {
    events.skipped('compile', { language: 'rust', cache: 'hit' });
    events.skipped('optimize', { language: 'rust', cache: 'hit' });
    return;
  }
  const env = wasmPackEnvironment({ environment, paths });
  const execute = (command, args, options = {}) =>
    runCommand(command, args, {
      env,
      cwd: paths.workspaceRoot,
      events,
      format,
      trackChild,
      language: 'rust',
      phase: 'compile',
      ...options
    });
  if (wasmBindgen.url) await ensureToolDownload(wasmBindgen, { fileSystem, runCommand: execute });
  if (mode === 'build' && wasmOpt.url)
    await ensureToolDownload(wasmOpt, { fileSystem, runCommand: execute, processOptions: { phase: 'optimize' } });
  let output;
  try {
    output = await events.phase('compile', { language: 'rust' }, () =>
      execute(
        'cargo',
        [
          'build',
          '--manifest-path',
          path.join(paths.rustCellsDir, 'Cargo.toml'),
          '--target',
          'wasm32-unknown-unknown',
          '--locked',
          '--message-format=json-render-diagnostics',
          ...(mode === 'build' ? ['--release'] : []),
          ...invalid.flatMap((group) => ['--package', group.packageName])
        ],
        { captureOutput: true, source: 'cargo' }
      )
    );
  } catch (cause) {
    const diagnostics = `${cause.stdout ?? ''}\n${cause.message}`;
    const failed = invalid.filter(
      (group) =>
        diagnostics.includes(`pages/${group.id}/src/`) ||
        diagnostics.includes(`could not compile \`${group.packageName}\``)
    );
    const affected = failed.length ? failed : invalid;
    const error = new Error(
      `Rust compilation failed for ${affected.map((group) => `${group.id} (${group.page})`).join(', ')}: ${cause.message}`,
      { cause }
    );
    error.exitCode = cause.exitCode;
    throw error;
  }
  const artifacts = String(output)
    .split('\n')
    .flatMap((line) => {
      try {
        const value = JSON.parse(line);
        return value.reason === 'compiler-artifact' ? [value] : [];
      } catch {
        return [];
      }
    });
  for (const group of invalid) {
    const directory = path.join(paths.rustWasmPublicDir, group.id);
    await fileSystem.mkdir(directory, { recursive: true });
    const artifact = artifacts
      .find((entry) => entry.target?.name === group.packageName.replaceAll('-', '_'))
      ?.filenames.find((name) => name.endsWith('.wasm'));
    const wasm =
      artifact ??
      path.join(
        env.CARGO_TARGET_DIR,
        'wasm32-unknown-unknown',
        mode === 'build' ? 'release' : 'debug',
        `${group.packageName.replaceAll('-', '_')}.wasm`
      );
    try {
      await events.phase('generation', { language: 'rust', module: group.id }, () =>
        execute(
          wasmBindgen.command,
          [
            wasm,
            '--target',
            'web',
            '--out-dir',
            directory,
            '--out-name',
            'doc_rust_cells',
            ...(mode === 'build' ? [] : ['--debug', '--keep-debug'])
          ],
          { module: group.id, source: 'wasm-bindgen', phase: 'generation' }
        )
      );
      if (mode === 'build')
        await optimizeRustWasmFiles({
          directory,
          cacheDir: paths.wasmOptCacheDir,
          cwd: paths.workspaceRoot,
          optimizer: wasmOpt,
          environment: env,
          runCommand: execute,
          fileSystem,
          events,
          context: { language: 'rust', module: group.id }
        });
      else events.skipped('optimize', { language: 'rust', module: group.id, reason: 'dev' });
      await postprocess({ rustWasmDir: directory, fileSystem });
    } catch (cause) {
      const error = new Error(`Rust module ${group.id} (${group.page}) failed: ${cause.message}`, { cause });
      error.exitCode = cause.exitCode;
      throw error;
    }
  }
}

export async function buildHaskellWasm({
  compilerVersion,
  environment = process.env,
  fileSystem = defaultFileSystem,
  haskellFingerprint = '',
  mode,
  paths,
  root = process.cwd(),
  runCommand = runProcess,
  events = createRuntimeEvents(),
  format = 'human',
  tolerateFailure = false,
  trackChild
}) {
  const execute = trackRuntimeCommand(runCommand, trackChild);
  runCommand = (command, args, options) =>
    execute(command, args, { events, format, phase: 'compile', language: 'haskell', module: 'site', ...options });
  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const outputDir = pathFromUrl(resolvedPaths.haskellWasmPublicDir);
  const optimizationFlag = mode === 'build' ? '-O2' : '-O0';
  const compiler = resolveHaskellWasiCompiler(environment);

  await fileSystem.mkdir(outputDir, { recursive: true });

  try {
    const version =
      compilerVersion ??
      String(await runCommand(compiler, ['--numeric-version'], { captureOutput: true, env: environment })).trim();
    const cacheDir = haskellCacheDirectory({ compilerVersion: version, mode, paths: resolvedPaths });
    const sourceDir = pathInUrl(cacheDir, 'src');
    const buildDir = pathInUrl(cacheDir, 'objects');
    await syncHaskellCacheSources({ fileSystem, sourceDir: resolvedPaths.haskellCellsDir, targetDir: sourceDir });
    await fileSystem.mkdir(buildDir, { recursive: true });
    await runCommand(
      compiler,
      [
        optimizationFlag,
        '-i.',
        '-odir',
        buildDir,
        '-hidir',
        buildDir,
        'Main.hs',
        '-o',
        pathInUrl(resolvedPaths.haskellWasmPublicDir, HASKELL_WASM_FILE)
      ],
      // GHC embeds source paths in Wasm. Keep random staging roots out of the output.
      { cwd: sourceDir, env: environment }
    );
  } catch (error) {
    const buildError = normalizeHaskellBuildError(error, compiler);
    if (!tolerateFailure) throw buildError;

    await markHaskellRuntimeUnavailable({
      error: buildError,
      fileSystem,
      haskellFingerprint,
      paths: resolvedPaths
    });
    return { error: buildError, ok: false };
  }

  await writeHaskellRuntimeStatus({
    fileSystem,
    haskellFingerprint,
    paths: resolvedPaths,
    status: 'ready'
  });
  return { ok: true };
}

export function resolveHaskellWasiCompiler(environment = process.env) {
  const override = environment[HASKELL_WASI_COMPILER_ENV]?.trim();
  return override || HASKELL_WASI_COMPILER;
}

export function createHaskellRuntimeStatus({ haskellFingerprint = '', message = '', status }) {
  return {
    status,
    haskellFingerprintHash: hashText(haskellFingerprint),
    message
  };
}

export function generateHaskellRuntimeStatusJson(status) {
  return `${JSON.stringify(status, null, 2)}\n`;
}

function normalizeHaskellBuildError(error, command) {
  if (error && error.code === 'ENOENT') {
    return new MissingHaskellWasiCompilerError(command, { cause: error });
  }

  return new HaskellWasmBuildError(command, error);
}

async function markHaskellRuntimeUnavailable({ error, fileSystem, haskellFingerprint, paths }) {
  await Promise.all([
    fileSystem.rm(pathInUrl(paths.haskellWasmPublicDir, HASKELL_WASM_FILE), { force: true }),
    writeHaskellRuntimeStatus({
      fileSystem,
      haskellFingerprint,
      message: haskellUnavailableMessage(error),
      paths,
      status: 'unavailable'
    })
  ]);
}

function haskellUnavailableMessage(error) {
  if (error instanceof MissingHaskellWasiCompilerError) {
    return `install ${HASKELL_WASI_COMPILER} and rerun pnpm wasm:dev.`;
  }

  return error instanceof Error && error.message
    ? error.message
    : 'rerun pnpm wasm:dev after fixing the Haskell runtime build.';
}

async function writeHaskellRuntimeStatus({ fileSystem, haskellFingerprint, message, paths, status }) {
  return writeIfChanged(
    pathInUrl(paths.haskellWasmPublicDir, HASKELL_RUNTIME_STATUS_FILE),
    generateHaskellRuntimeStatusJson(createHaskellRuntimeStatus({ haskellFingerprint, message, status })),
    { fileSystem }
  );
}
