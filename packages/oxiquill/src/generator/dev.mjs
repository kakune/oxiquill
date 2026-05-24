import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import {
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  syncDocRuntime
} from './doc-runtime-service.mjs';

export async function main() {
  const root = process.cwd();
  const context = await createDocRuntimeContext({ root });
  const result = await syncDocRuntime(context);
  console.log(`[dev] generated ${result.cellCount} interactive cell(s)`);
  await buildRustWasm({ mode: 'dev', paths: context.paths });
  await markRuntimeReady({ paths: context.paths, summary: result });

  const workspaceRoot = pathFromUrl(context.paths.workspaceRoot);
  const astroBin = resolveBin(context.paths, 'astro');
  const children = [
    spawn(process.execPath, [fileURLToPath(new URL('./watch-doc-runtime.mjs', import.meta.url)), '--skip-initial'], {
      cwd: workspaceRoot,
      stdio: 'inherit'
    }),
    spawn(astroBin, ['dev'], {
      cwd: workspaceRoot,
      env: { ...process.env, NODE_PATH: pathInUrl(context.paths.frameworkRoot, 'node_modules') },
      stdio: 'inherit'
    })
  ];

  const stop = () => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };

  process.on('SIGINT', () => {
    stop();
    process.exitCode = 130;
  });
  process.on('SIGTERM', () => {
    stop();
    process.exitCode = 143;
  });

  await new Promise((resolve, reject) => {
    for (const child of children) {
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        stop();
        if (code === 0 || signal === 'SIGTERM') {
          resolve();
        } else {
          reject(new Error(`dev child exited with ${signal ?? code}`));
        }
      });
    }
  });
}

function resolveBin(paths, name) {
  const workspaceBin = pathInUrl(paths.workspaceRoot, `node_modules/.bin/${name}`);
  return existsSync(workspaceBin) ? workspaceBin : pathInUrl(paths.frameworkRoot, `node_modules/.bin/${name}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
