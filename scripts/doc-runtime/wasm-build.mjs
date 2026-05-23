import { spawn } from 'node:child_process';

export async function buildRustWasm({ mode, root, runCommand = runCommandWithInheritedStdio }) {
  const modeFlag = mode === 'build' ? '--release' : '--dev';
  await runCommand('wasm-pack', [
    'build',
    'src/generated/doc-runtime/rust-cells',
    '--target',
    'web',
    modeFlag,
    '--out-dir',
    '../rust-wasm',
    '--out-name',
    'doc_rust_cells'
  ], { cwd: root });
  await runCommand(process.execPath, ['scripts/postprocess-rust-wasm.mjs'], { cwd: root });
}

/* v8 ignore start -- external process adapter covered through injected runCommand in tests. */
function runCommandWithInheritedStdio(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
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
/* v8 ignore stop */
