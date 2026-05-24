#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOxiquillPaths, pathFromUrl, pathInUrl } from '../config/paths.mjs';
import {
  buildRustWasm,
  createDocRuntimeContext,
  markRuntimeReady,
  syncDocRuntime
} from '../generator/doc-runtime-service.mjs';
import { cleanOxiquillWorkspace } from '../generator/clean.mjs';
import { runHelperCargo } from '../generator/run-helper-cargo.mjs';
import { main as watchDocRuntime } from '../generator/watch-doc-runtime.mjs';

const command = process.argv[2] ?? 'help';
const args = process.argv.slice(3);

try {
  await runCli(command, args);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}

export async function runCli(command, args = [], { cwd = process.cwd(), runCommand = runCommandWithInheritedStdio } = {}) {
  const paths = createOxiquillPaths({ workspaceRoot: cwd });

  switch (command) {
    case 'dev':
      await generateRuntime({ paths, wasmMode: 'dev' });
      await runDevServer({ paths });
      return;
    case 'dev:runtime':
      await watchDocRuntime(args);
      return;
    case 'dev:astro':
      await runAstro(paths, ['dev', ...args], { runCommand });
      return;
    case 'preview':
      await runAstro(paths, ['preview', ...args], { runCommand });
      return;
    case 'build':
      await generateRuntime({ paths, wasmMode: 'build' });
      await runOxiquillCheck(paths, [], { runCommand });
      await runAstro(paths, ['build', ...args], { runCommand });
      return;
    case 'check':
      await generateRuntime({ paths, wasmMode: 'dev' });
      await runOxiquillCheck(paths, args, { runCommand });
      return;
    case 'docgen':
      await generateRuntime({ paths, wasmMode: parseWasmMode(args) });
      return;
    case 'clean':
      await cleanOxiquillWorkspace({ paths });
      return;
    case 'test-rust':
      await runHelperCargo({ argv: ['test'], paths });
      return;
    case 'test-rust-coverage':
      await runHelperCargo({
        argv: [
          'llvm-cov',
          '--fail-under-lines',
          '85',
          '--fail-under-functions',
          '85',
          '--fail-under-regions',
          '85',
          '--ignore-filename-regex',
          '(/target/|/.oxiquill/)'
        ],
        paths
      });
      return;
    case 'lint-rust':
      await runHelperCargo({ argv: ['clippy', '--all-targets', '--', '-D', 'warnings'], paths });
      return;
    case 'doc-rust':
      await runHelperCargo({ argv: ['doc', '--no-deps'], paths });
      return;
    case 'test-wasm':
      await generateRuntime({ paths, wasmMode: 'dev' });
      await runCommand('wasm-pack', ['test', '--node', pathFromUrl(paths.rustCellsDir)], {
        cwd: pathFromUrl(paths.workspaceRoot)
      });
      return;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      return;
    default:
      throw new Error(`Unknown oxiquill command "${command}".`);
  }
}

async function generateRuntime({ paths, wasmMode }) {
  const context = await createDocRuntimeContext({ paths });
  const summary = await syncDocRuntime(context);
  console.log(`Generated ${summary.cellCount} interactive cell(s).`);

  if (wasmMode) {
    await buildRustWasm({ mode: wasmMode, paths });
  }

  await markRuntimeReady({ paths, summary });
}

async function runDevServer({ paths }) {
  const children = [
    spawn(process.execPath, [fileURLToPath(new URL('../generator/watch-doc-runtime.mjs', import.meta.url)), '--skip-initial'], {
      cwd: pathFromUrl(paths.workspaceRoot),
      stdio: 'inherit'
    }),
    spawn(frameworkBin(paths, 'astro'), ['dev'], {
      cwd: pathFromUrl(paths.workspaceRoot),
      stdio: 'inherit'
    })
  ];

  const stop = () => {
    for (const child of children) {
      if (!child.killed) child.kill('SIGTERM');
    }
  };

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

async function runAstro(paths, args, { runCommand }) {
  await runCommand(frameworkBin(paths, 'astro'), args, { cwd: pathFromUrl(paths.workspaceRoot) });
}

async function runOxiquillCheck(paths, args, { runCommand }) {
  await runAstro(paths, ['sync'], { runCommand });

  const { check, parseArgsAsCheckConfig } = await importFromWorkspace(paths, '@astrojs/check');
  const config = parseArgsAsCheckConfig(['node', 'oxiquill-check', ...args]);
  config.root = pathFromUrl(paths.workspaceRoot);

  console.info(`Getting diagnostics for Astro files in ${config.root}...`);
  if (await check(config)) {
    throw new Error('Astro check reported diagnostics.');
  }
}

async function importFromWorkspace(paths, specifier) {
  const require = createRequire(pathInUrl(paths.workspaceRoot, 'package.json'));
  return import(pathToFileURL(require.resolve(specifier)).href);
}

function frameworkBin(paths, name) {
  const workspaceBin = pathInUrl(paths.workspaceRoot, `node_modules/.bin/${name}`);
  return existsSync(workspaceBin) ? workspaceBin : pathInUrl(paths.frameworkRoot, `node_modules/.bin/${name}`);
}

function parseWasmMode(args) {
  const wasmIndex = args.indexOf('--wasm');
  if (wasmIndex === -1) return undefined;

  const mode = args[wasmIndex + 1];
  if (mode === 'dev' || mode === 'build') return mode;

  throw new Error('--wasm must be followed by "dev" or "build".');
}

function printHelp() {
  console.log('Usage: oxiquill <dev|build|check|docgen|clean|test-rust|lint-rust|doc-rust|test-wasm>');
}

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
