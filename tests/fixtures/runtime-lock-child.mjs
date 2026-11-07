import { spawn } from 'node:child_process';
import { once, EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createOxiquillPaths } from '../../packages/oxiquill/src/config/paths.mjs';
import { runCli } from '../../packages/oxiquill/src/cli/commands.mjs';
import { acquireRuntimeLock, readRuntimeLock } from '../../packages/oxiquill/src/generator/runtime-lock.mjs';
import { watchDocRuntime } from '../../packages/oxiquill/src/generator/watch-doc-runtime.mjs';
import {
  createDirectoryStage,
  publishDirectoryStages
} from '../../packages/oxiquill/src/generator/doc-runtime/atomic-output.mjs';

const [mode, root] = process.argv.slice(2);
const paths = createOxiquillPaths({ workspaceRoot: root });
const projectConfig = { cwd: root, paths, astroConfigArgs: [] };
const send = (type, details = {}) => process.send({ type, ...details });
const messages = new EventEmitter();
process.on('message', (message) => messages.emit(message.type, message));
const wait = (type) => new Promise((resolve) => messages.once(type, resolve));
const log = (message) => send('waiting', { message });
const lockPath = path.join(paths.cacheDir, 'runtime.lock');

async function outputs() {
  return Promise.all(
    [paths.generatedDir, paths.publicAssetsDir].map(async (directory) => {
      try {
        return await readFile(path.join(directory, 'manifest.json'), 'utf8');
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    })
  );
}

async function generate(pause) {
  const state = await readFile(path.join(paths.docsDir, 'index.mdx'), 'utf8');
  const stages = await Promise.all(
    [paths.generatedDir, paths.publicAssetsDir].map(async (targetPath) => {
      const stagePath = await createDirectoryStage(targetPath);
      await writeFile(path.join(stagePath, 'manifest.json'), state);
      return { stagePath, targetPath };
    })
  );
  send('stage', { stagePaths: stages.map(({ stagePath }) => stagePath), state });
  if (pause) await wait('finish-generation');
  await publishDirectoryStages(stages);
  send('generated', { state, outputs: await outputs() });
  return {
    cellCount: 0,
    generationId: state,
    plan: { languages: { rust: { public: 'keep' }, haskell: { public: 'keep' } } }
  };
}

try {
  if (mode === 'watcher') {
    const events = Object.assign(new EventEmitter(), { add: () => undefined, close: async () => undefined });
    const watcher = await watchDocRuntime({
      projectConfig,
      skipInitial: true,
      serviceOverrides: {
        acquireRuntimeLock: (options) => acquireRuntimeLock({ ...options, log }),
        watch: () => events,
        createDocRuntimeContext: async () => ({ paths }),
        syncDocRuntime: () => generate(false)
      }
    });
    messages.on('change', () => {
      events.emit('all', 'change', path.join(paths.docsDir, 'index.mdx'));
      send('event');
    });
    send('ready');
    await wait('close');
    await watcher.close();
    send('closed');
  } else if (['build', 'check', 'check-watch', 'clean'].includes(mode)) {
    await runCli(mode === 'check-watch' ? ['check', '--watch'] : [mode, ...process.argv.slice(4)], {
      loadProjectConfig: async () => projectConfig,
      acquireLock: (options) => acquireRuntimeLock({ ...options, log }),
      selectNode: () => process.execPath,
      generate: () => generate(true),
      runCommand: async (_command, args, options) => {
        send('phase', {
          name: args[1],
          outputs: await outputs(),
          token: options.env.OXIQUILL_LOCK_TOKEN,
          owner: options.env.OXIQUILL_RUNTIME_OWNER,
          holder: readRuntimeLock(lockPath).record
        });
        await wait('continue');
      },
      loadCheck: async () => ({
        parseArgsAsCheckConfig: () => ({ watch: mode === 'check-watch' }),
        check: async () => {
          send('phase', {
            name: 'check',
            outputs: await outputs(),
            token: process.env.OXIQUILL_LOCK_TOKEN,
            owner: process.env.OXIQUILL_RUNTIME_OWNER,
            holder: readRuntimeLock(lockPath).record
          });
          await wait('continue');
          return false;
        }
      })
    });
    send('done', { outputs: await outputs() });
  } else {
    let intercepted = false;
    const fileSystem =
      mode === 'delayed-reclaimer'
        ? {
            ...fs,
            readFileSync: (file, ...args) => {
              const result = fs.readFileSync(file, ...args);
              if (file === lockPath && !intercepted) {
                intercepted = true;
                send('observed-stale');
                const deadline = Date.now() + 15_000;
                while (!fs.existsSync(path.join(root, `resume-${process.pid}`))) {
                  if (Date.now() > deadline) throw new Error('Reclaimer barrier timed out');
                  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
                }
              }
              return result;
            }
          }
        : fs;
    const lease = await acquireRuntimeLock({ paths, command: mode, fileSystem, log });
    if (mode === 'holder-with-child') {
      const child = spawn(
        process.execPath,
        [
          '-e',
          `
        process.on('SIGTERM', () => {
          require('node:fs').writeFileSync(process.argv[2], String(require('node:fs').existsSync(process.argv[1])));
          process.exit(0);
        });
        process.send('ready');
        setInterval(() => {}, 1000);
      `,
          lockPath,
          path.join(root, 'child-stopped-with-lock')
        ],
        { detached: process.platform !== 'win32', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] }
      );
      lease.trackChild(child, process.platform !== 'win32');
      await once(child, 'message');
    }
    send('acquired', { token: lease.token });
    await wait('release');
    lease.release();
    send('released');
  }
} catch (error) {
  send('error', { message: error.stack });
  process.exitCode = 1;
} finally {
  process.disconnect();
}
