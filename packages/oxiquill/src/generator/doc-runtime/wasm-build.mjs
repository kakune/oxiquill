import { spawn } from 'node:child_process';
import { createOxiquillPaths, pathFromUrl } from '../../config/paths.mjs';
import { postprocessRustWasm } from '../postprocess-rust-wasm.mjs';

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
