import { spawn } from 'node:child_process';
import { defaultFileSystem } from './file-system.mjs';

export async function preflightRequiredToolchains({
  environment = process.env,
  fileSystem = defaultFileSystem,
  haskellCellCount,
  mode,
  platform = process.platform,
  runCommand = runCommandWithCapturedOutput,
  runtimeInputs,
  rustCellCount,
  tolerateHaskellFailure = false
}) {
  if (mode === undefined) return Object.freeze({});

  const [rust, haskell] = await Promise.all([
    rustCellCount > 0
      ? preflightRustToolchain({ fileSystem, runCommand, runtimeInputs: runtimeInputs.rust })
      : undefined,
    haskellCellCount > 0
      ? preflightHaskellToolchain({
          environment,
          platform,
          runCommand,
          runtimeInputs: runtimeInputs.haskell,
          tolerateFailure: tolerateHaskellFailure
        })
      : undefined
  ]);

  return Object.freeze({ ...(rust ? { rust } : {}), ...(haskell ? { haskell } : {}) });
}

export async function preflightRustToolchain({ fileSystem = defaultFileSystem, runCommand, runtimeInputs }) {
  const commands = [
    ['rustc', ['--version'], 'rustc', runtimeInputs.rustcVersion],
    ['cargo', ['--version'], 'cargo', runtimeInputs.cargoVersion],
    ['wasm-pack', ['--version'], 'wasm-pack', runtimeInputs.wasmPackVersion]
  ];
  const versions = {};

  for (const [command, args, label, expected] of commands) {
    const output = await runVersionCommand(command, args, {
      expected,
      guidance: rustSetupGuidance(runtimeInputs),
      label,
      runCommand
    });
    versions[label] = output;
  }

  const targetCommand = ['rustc', ['--print', 'target-libdir', '--target', runtimeInputs.target]];
  const targetLibdir = await runCommand(...targetCommand).catch((error) => {
    throw preflightError(
      targetCommand,
      `support for ${runtimeInputs.target}`,
      errorMessage(error),
      rustSetupGuidance(runtimeInputs)
    );
  });
  const targetPath = String(targetLibdir).trim();
  let targetFiles;
  try {
    targetFiles = await fileSystem.readdir(targetPath);
  } catch (error) {
    throw preflightError(
      targetCommand,
      `installed target ${runtimeInputs.target}`,
      errorMessage(error),
      rustSetupGuidance(runtimeInputs)
    );
  }
  if (!targetFiles.some((entry) => String(typeof entry === 'string' ? entry : entry.name).startsWith('libcore-'))) {
    throw preflightError(
      targetCommand,
      `installed target ${runtimeInputs.target}`,
      `no Rust core library was found in ${targetPath}`,
      rustSetupGuidance(runtimeInputs)
    );
  }

  return Object.freeze({ ...versions, target: runtimeInputs.target });
}

export async function preflightHaskellToolchain({
  environment,
  platform,
  runCommand,
  runtimeInputs,
  tolerateFailure = false
}) {
  const compiler = environment.OXIQUILL_HASKELL_GHC?.trim() || runtimeInputs.compiler;
  const command = [compiler, ['--numeric-version']];
  try {
    if (platform === 'win32') {
      throw new Error('native Windows Haskell/WASI generation is unsupported');
    }
    const version = String(await runCommand(...command)).trim();
    if (!version.startsWith(runtimeInputs.supportedVersionPrefix)) {
      throw new Error(`reported ${version || '(empty output)'}`);
    }
    return Object.freeze({ command: compiler, version });
  } catch (error) {
    const failure = preflightError(
      command,
      `${runtimeInputs.supportedVersionPrefix.slice(0, -1)}.x support on Linux or macOS`,
      errorMessage(error),
      `Install ${runtimeInputs.compiler}, source ~/.ghc-wasm/env when using ghc-wasm-meta, or set OXIQUILL_HASKELL_GHC to the compiler path. Generated Haskell Wasm remains browser-portable.`
    );
    if (!tolerateFailure) throw failure;
    return Object.freeze({ command: compiler, error: failure.message, unavailable: true });
  }
}

async function runVersionCommand(command, args, { expected, guidance, label, runCommand }) {
  let output;
  try {
    output = String(await runCommand(command, args)).trim();
  } catch (error) {
    throw preflightError([command, args], `${label} ${expected}`, errorMessage(error), guidance);
  }
  const version = output.split(/\s+/u)[1];
  if (version !== expected) {
    throw preflightError([command, args], `${label} ${expected}`, output || '(empty output)', guidance);
  }
  return output;
}

function preflightError([command, args], expected, actual, guidance) {
  return new Error(
    `Toolchain preflight failed: "${[command, ...args].join(' ')}" expected ${expected}; received ${actual}. ${guidance}`
  );
}

function rustSetupGuidance(runtimeInputs) {
  return `Install Rust ${runtimeInputs.rustcVersion}, run "rustup target add ${runtimeInputs.target} --toolchain ${runtimeInputs.rustcVersion}", and install wasm-pack ${runtimeInputs.wasmPackVersion}.`;
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function runCommandWithCapturedOutput(command, args, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout).toString('utf8'));
      } else {
        reject(new Error(Buffer.concat(stderr).toString('utf8').trim() || `${command} exited with ${signal ?? code}`));
      }
    });
  });
}
