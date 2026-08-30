import { readFile } from 'node:fs/promises';
import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';
import { pathInUrl } from '../../config/paths.mjs';
import { HASKELL_RUNTIME_STATUS_FILE, HASKELL_WASM_FILE } from './wasm-build.mjs';
import { hashText } from './hashing.mjs';

const defaultFileSystem = { readFile };

export async function testGeneratedHaskellCells({
  compile = WebAssembly.compile,
  executeCell = executeGeneratedHaskellCell,
  expectedFingerprint,
  fileSystem = defaultFileSystem,
  paths
}) {
  const cells = parseCellManifest(await fileSystem.readFile(paths.cellsJsonPath, 'utf8'));
  const haskellCells = cells.filter((cell) => cell.language === 'haskell');
  if (haskellCells.length === 0) return Object.freeze({ cellCount: 0 });

  const statusPath = pathInUrl(paths.haskellWasmPublicDir, HASKELL_RUNTIME_STATUS_FILE);
  const wasmPath = pathInUrl(paths.haskellWasmPublicDir, HASKELL_WASM_FILE);
  const [status, wasmBytes] = await Promise.all([
    readHaskellStatus(statusPath, { fileSystem }),
    fileSystem.readFile(wasmPath)
  ]);
  assertReadyStatus(status, expectedFingerprint, statusPath);
  const module = await compile(wasmBytes);

  for (const cell of haskellCells) {
    try {
      await executeCell({ cell, module });
    } catch (error) {
      const message = error instanceof Error && error.message ? error.message : String(error);
      throw new Error(`Generated Haskell cell "${cell.id}" failed with default inputs: ${message}`, {
        cause: error
      });
    }
  }

  return Object.freeze({ cellCount: haskellCells.length });
}

export async function executeGeneratedHaskellCell({
  cell,
  createWasi = createHaskellWasi,
  instantiate = WebAssembly.instantiate,
  module
}) {
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const args = ['doc_haskell_cells', cell.id, ...cell.inputs.map(({ value }) => inputArgument(value))];
  const wasi = createWasi({ args, stderr: stderr.write, stdout: stdout.write });
  const instance = await instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport
  });
  const exitCode = wasi.start(instance);
  const output = { stderr: stderr.take(), stdout: stdout.take() };

  if (exitCode !== 0) {
    throw new Error(output.stderr || output.stdout || `process exited with status ${exitCode}`);
  }

  return output;
}

function createHaskellWasi({ args, stderr, stdout }) {
  return new WASI(args, [], [new OpenFile(new File([])), new ConsoleStdout(stdout), new ConsoleStdout(stderr)]);
}

function createOutputCapture() {
  const chunks = [];
  const decoder = new TextDecoder();
  return {
    take: () => `${chunks.join('')}${decoder.decode()}`.trimEnd(),
    write: (buffer) => chunks.push(decoder.decode(buffer, { stream: true }))
  };
}

function inputArgument(value) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  throw new TypeError(`Unsupported Haskell default input value: ${String(value)}.`);
}

async function readHaskellStatus(filePath, { fileSystem }) {
  try {
    return JSON.parse(await fileSystem.readFile(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`Generated Haskell runtime status is invalid or missing: ${filePath}.`, { cause: error });
  }
}

function assertReadyStatus(status, expectedFingerprint, filePath) {
  if (
    !status ||
    status.status !== 'ready' ||
    typeof status.haskellFingerprintHash !== 'string' ||
    typeof status.message !== 'string'
  ) {
    const detail = typeof status?.message === 'string' && status.message ? ` ${status.message}` : '';
    throw new Error(`Generated Haskell runtime is not ready: ${filePath}.${detail}`);
  }
  if (expectedFingerprint !== undefined && status.haskellFingerprintHash !== hashText(expectedFingerprint)) {
    throw new Error(`Generated Haskell runtime is stale: ${filePath}.`);
  }
}

function parseCellManifest(source) {
  let cells;
  try {
    cells = JSON.parse(source);
  } catch (error) {
    throw new Error('Generated cell manifest is invalid JSON.', { cause: error });
  }
  if (!Array.isArray(cells)) throw new Error('Generated cell manifest must be an array.');
  for (const cell of cells) {
    if (
      !cell ||
      typeof cell.id !== 'string' ||
      typeof cell.language !== 'string' ||
      !Array.isArray(cell.inputs) ||
      cell.inputs.some((input) => !input || !Object.hasOwn(input, 'value'))
    ) {
      throw new Error('Generated cell manifest contains an invalid cell.');
    }
  }
  return cells;
}
