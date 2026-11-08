import { trackRuntimeCommand } from '../runtime-lock.mjs';
import { spawn } from 'node:child_process';
import { resolveWasmOpt } from './wasm-opt-cache.mjs';
import { defaultFileSystem } from './file-system.mjs';
import { compareVersions, parseToolVersion, parseVersion } from './toolchain-versions.mjs';
import { resolveWasmBindgen } from './tool-downloads.mjs';
import { parse } from 'smol-toml';

export async function preflightRequiredToolchains({
  cwd = process.cwd(),
  environment = process.env,
  fileSystem = defaultFileSystem,
  haskellCellCount,
  explain = false,
  paths,
  mode,
  platform = process.platform,
  runCommand = runCommandWithCapturedOutput,
  runtimeInputs,
  rustCellCount,
  tolerateHaskellFailure = false,
  trackChild
}) {
  if (mode === undefined) return Object.freeze({});
  const execute = trackRuntimeCommand(runCommand, trackChild);
  runCommand = (command, args, options) => execute(command, args, { captureOutput: true, ...options });

  const [rust, haskell] = await Promise.all([
    rustCellCount > 0
      ? preflightRustToolchain({
          cwd,
          environment,
          platform,
          fileSystem,
          runCommand,
          runtimeInputs: runtimeInputs.rust,
          explain,
          paths
        })
      : undefined,
    haskellCellCount > 0
      ? preflightHaskellToolchain({
          environment,
          platform,
          runCommand,
          runtimeInputs: runtimeInputs.haskell,
          tolerateFailure: tolerateHaskellFailure,
          explain
        })
      : undefined
  ]);

  // Every Rust module is bound with the CLI matching the pinned wasm-bindgen crate.
  const wasmBindgen = rust
    ? await resolveWasmBindgen({
        version: parse(runtimeInputs.rustLock).package.find((entry) => entry.name === 'wasm-bindgen').version,
        paths,
        runCommand,
        environment,
        platform
      })
    : undefined;
  return Object.freeze({
    ...(rust ? { rust: wasmBindgen ? { ...rust, wasmBindgen } : rust } : {}),
    ...(haskell ? { haskell } : {})
  });
}

export async function preflightRustToolchain({
  cwd = process.cwd(),
  environment = process.env,
  platform = process.platform,
  fileSystem = defaultFileSystem,
  explain = false,
  paths,
  runCommand,
  runtimeInputs
}) {
  const runVersion = (command, args) => runCommand(command, args, { env: environment, cwd });
  const commands = [
    ['rustc', runtimeInputs.minimumVersion, undefined],
    ['cargo', runtimeInputs.minimumVersion, undefined]
  ];
  const versions = Object.fromEntries(
    await Promise.all(
      commands.map(async ([command, minimum, maximum]) => {
        const expected = maximum ? `>=${minimum} <${maximum}` : `>=${minimum} (tested ${runtimeInputs.testedVersion})`;
        const output = await runVersionCommand(command, ['--version'], {
          expected: `${command} ${expected}`,
          minimum,
          maximum,
          guidance: rustSetupGuidance(runtimeInputs),
          runCommand: runVersion
        });
        return [command, output];
      })
    )
  );

  if (!explain) {
    const targetCommand = ['rustc', ['--print', 'target-libdir', '--target', runtimeInputs.target]];
    const targetLibdir = await runVersion(...targetCommand).catch((error) => {
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
  }

  const wasmOpt = await resolveWasmOpt({
    cwd,
    environment,
    platform,
    fileSystem,
    runCommand,
    paths,
    provision: Boolean(paths),
    memoize: fileSystem === defaultFileSystem && runCommand === runCommandWithCapturedOutput
  });
  return Object.freeze({ ...versions, wasmOpt, target: runtimeInputs.target });
}

export async function preflightHaskellToolchain({
  environment,
  platform,
  runCommand,
  runtimeInputs,
  tolerateFailure = false,
  explain = false
}) {
  const compiler = environment.OXIQUILL_HASKELL_GHC?.trim() || runtimeInputs.compiler;
  const command = [compiler, [explain ? '--version' : '--numeric-version']];
  try {
    if (platform === 'win32') {
      throw new Error('native Windows Haskell/WASI generation is unsupported');
    }
    const output = String(await runCommand(...command)).trim();
    const version = explain ? (output.match(/\d+(?:\.\d+)+/u)?.[0] ?? output) : output;
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

async function runVersionCommand(command, args, { expected, guidance, minimum, maximum, runCommand }) {
  let output;
  try {
    output = String(await runCommand(command, args));
  } catch (error) {
    throw preflightError([command, args], expected, errorMessage(error), guidance);
  }
  const version = parseToolVersion(output, command);
  if (
    !version ||
    compareVersions(version, parseVersion(minimum)) < 0 ||
    (maximum && compareVersions(version, parseVersion(maximum)) >= 0)
  ) {
    throw preflightError([command, args], expected, JSON.stringify(output), guidance);
  }
  return output.trim();
}

function preflightError([command, args], expected, actual, guidance) {
  return new Error(
    `Toolchain preflight failed: "${[command, ...args].join(' ')}" expected ${expected}; received ${actual}. ${guidance}`
  );
}

function rustSetupGuidance(runtimeInputs) {
  return `Install Rust and Cargo >=${runtimeInputs.minimumVersion} (tested ${runtimeInputs.testedVersion}) and run "rustup target add ${runtimeInputs.target}". The pinned wasm-bindgen CLI and Binaryen wasm-opt are used from PATH or downloaded and verified automatically. Rust beta/nightly channels are accepted but untested.`;
}

function errorMessage(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}

export function runCommandWithCapturedOutput(command, args, options = {}, spawnProcess = spawn) {
  return new Promise((resolve, reject) => {
    const { trackChild, ...spawnOptions } = options;
    const detached = Boolean(trackChild) && process.platform !== 'win32';
    const child = spawnProcess(command, args, {
      ...spawnOptions,
      ...(trackChild ? { detached } : {}),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    trackChild?.(child, detached);
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
