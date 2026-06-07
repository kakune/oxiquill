import { spawn } from 'node:child_process';
import {
  createOxiquillPaths,
  pathFromUrl,
  pathInUrl
} from '../../config/paths.mjs';
import { postprocessRustWasm } from '../postprocess-rust-wasm.mjs';
import {
  defaultFileSystem,
  writeIfChanged
} from './file-system.mjs';
import { hashText } from './hashing.mjs';

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
  mode,
  paths,
  postprocess = postprocessRustWasm,
  root = process.cwd(),
  runCommand = runCommandWithInheritedStdio
}) {
  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const modeFlag = mode === 'build' ? '--release' : '--dev';
  await runCommand('wasm-pack', [
    'build',
    pathFromUrl(resolvedPaths.rustCellsDir),
    '--target',
    'web',
    modeFlag,
    '--out-dir',
    pathFromUrl(resolvedPaths.rustWasmPublicDir),
    '--out-name',
    'doc_rust_cells'
  ], { cwd: pathFromUrl(resolvedPaths.workspaceRoot) });
  await postprocess({ rustWasmDir: pathFromUrl(resolvedPaths.rustWasmPublicDir) });
}

export async function buildHaskellWasm({
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
  const buildDir = pathInUrl(resolvedPaths.haskellCellsDir, 'build');
  const outputDir = pathFromUrl(resolvedPaths.haskellWasmPublicDir);
  const optimizationFlag = mode === 'build' ? '-O2' : '-O0';
  const compiler = resolveHaskellWasiCompiler(environment);

  await Promise.all([
    fileSystem.mkdir(buildDir, { recursive: true }),
    fileSystem.mkdir(outputDir, { recursive: true })
  ]);

  try {
    await runCommand(compiler, [
      optimizationFlag,
      '-odir',
      buildDir,
      '-hidir',
      buildDir,
      pathInUrl(resolvedPaths.haskellCellsDir, 'Main.hs'),
      '-o',
      pathInUrl(resolvedPaths.haskellWasmPublicDir, HASKELL_WASM_FILE)
    ], { cwd: pathFromUrl(resolvedPaths.workspaceRoot) });
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

export function createHaskellRuntimeStatus({
  haskellFingerprint = '',
  message = '',
  status
}) {
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

async function markHaskellRuntimeUnavailable({
  error,
  fileSystem,
  haskellFingerprint,
  paths
}) {
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

async function writeHaskellRuntimeStatus({
  fileSystem,
  haskellFingerprint,
  message,
  paths,
  status
}) {
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
      env: wasmPackEnv(),
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

function wasmPackEnv() {
  const { NODE_PATH, ...env } = process.env;
  return env;
}
/* v8 ignore stop */
