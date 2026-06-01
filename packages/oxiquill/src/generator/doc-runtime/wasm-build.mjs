import { spawn } from 'node:child_process';
import {
  createOxiquillPaths,
  pathFromUrl,
  pathInUrl
} from '../../config/paths.mjs';
import { postprocessRustWasm } from '../postprocess-rust-wasm.mjs';
import { defaultFileSystem } from './file-system.mjs';

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
  fileSystem = defaultFileSystem,
  mode,
  paths,
  root = process.cwd(),
  runCommand = runCommandWithInheritedStdio
}) {
  const resolvedPaths = paths ?? createOxiquillPaths({ workspaceRoot: root });
  const buildDir = pathInUrl(resolvedPaths.haskellCellsDir, 'build');
  const outputDir = pathFromUrl(resolvedPaths.haskellWasmPublicDir);
  const optimizationFlag = mode === 'build' ? '-O2' : '-O0';

  await Promise.all([
    fileSystem.mkdir(buildDir, { recursive: true }),
    fileSystem.mkdir(outputDir, { recursive: true })
  ]);
  await runCommand('wasm32-wasi-ghc', [
    optimizationFlag,
    '-odir',
    buildDir,
    '-hidir',
    buildDir,
    pathInUrl(resolvedPaths.haskellCellsDir, 'Main.hs'),
    '-o',
    pathInUrl(resolvedPaths.haskellWasmPublicDir, 'doc_haskell_cells.wasm')
  ], { cwd: pathFromUrl(resolvedPaths.workspaceRoot) });
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
