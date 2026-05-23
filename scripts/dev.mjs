import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  syncDocRuntime
} from './doc-runtime-service.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function main() {
  const context = await createDocRuntimeContext({ root });
  const result = await syncDocRuntime({ root, ...context });
  console.log(`[dev] generated ${result.cellCount} interactive cell(s)`);
  await buildRustWasm({ mode: 'dev', root });
  await markRuntimeReady({ paths: context.paths, summary: result });

  const children = [
    spawn(process.execPath, ['scripts/watch-doc-runtime.mjs', '--skip-initial'], {
      cwd: root,
      stdio: 'inherit'
    }),
    spawn('pnpm', ['exec', 'astro', 'dev'], {
      cwd: root,
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

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
