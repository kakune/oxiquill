import { spawn } from 'node:child_process';
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
  runCommand = runCommandWithInheritedStdio
}) {
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
          memoize: fileSystem === defaultFileSystem && runCommand === runCommandWithInheritedStdio
        })))
      : undefined;
  await runCommand(
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
  );
  if (optimizer?.command) {
    await optimizeRustWasmFiles({
      directory: pathFromUrl(resolvedPaths.rustWasmPublicDir),
      cacheDir: resolvedPaths.wasmOptCacheDir,
      cwd: pathFromUrl(resolvedPaths.workspaceRoot),
      optimizer,
      environment: env,
      runCommand,
      fileSystem
    });
  }
  await postprocess({ rustWasmDir: pathFromUrl(resolvedPaths.rustWasmPublicDir) });
}

export async function buildHaskellWasm({
  compilerVersion,
  environment = process.env,
  fileSystem = defaultFileSystem,
  haskellFingerprint = '',
  mode,
  paths,
  root = process.cwd(),
  runCommand = runCommandWithInheritedStdio,
  tolerateFailure = false
}) {
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

/* v8 ignore start -- external process adapter covered through injected runCommand in tests. */
function runCommandWithInheritedStdio(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.captureOutput ? ['ignore', 'pipe', 'inherit'] : 'inherit'
    });

    const output = [];
    child.stdout?.on('data', (chunk) => output.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(output).toString('utf8'));
      } else {
        reject(new Error(`${command} exited with ${signal ?? code}`));
      }
    });
  });
}

/* v8 ignore stop */
