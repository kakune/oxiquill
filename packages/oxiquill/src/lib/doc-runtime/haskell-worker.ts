import { ConsoleStdout, File, OpenFile, WASI } from '@bjorn3/browser_wasi_shim';
import { haskellWasmPath } from 'virtual:oxiquill/runtime-paths';
import { boundedErrorMessage, outputArtifactLimits, truncateUtf8 } from './output-limits.mjs';
import type { RawCellExecutionResult, RuntimeWorkerRequest, RuntimeWorkerResponse, TextArtifact } from './types.js';
import { boundWorkerResult } from './worker-output.js';

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

type HaskellWorkerHandlerDependencies = {
  loadModule: (expectedFingerprintHash: string | undefined) => Promise<WebAssembly.Module>;
  postMessage: (response: RuntimeWorkerResponse) => void;
  runCell?: typeof runHaskellCell;
};

type WasiInstance = WebAssembly.Instance & {
  exports: {
    memory: WebAssembly.Memory;
    _start: () => unknown;
  };
};

export type HaskellRuntimeStatus =
  | {
      status: 'ready';
      haskellFingerprintHash: string;
      message: string;
    }
  | {
      status: 'unavailable';
      haskellFingerprintHash: string;
      message: string;
    };

const worker = self as unknown as WorkerScope;
const haskellWasmUrl = resolveHaskellWasmUrl();
const haskellRuntimeStatusUrl = resolveHaskellRuntimeStatusUrl();
const loadModule = createHaskellModuleLoader({
  statusUrl: haskellRuntimeStatusUrl,
  wasmUrl: haskellWasmUrl
});
const handleRequest = createHaskellWorkerRequestHandler({
  loadModule,
  postMessage: (response) => worker.postMessage(response)
});

worker.addEventListener('message', (event) => {
  void handleRequest(event.data);
});

export function createHaskellWorkerRequestHandler({
  loadModule,
  postMessage,
  runCell = runHaskellCell
}: HaskellWorkerHandlerDependencies): (request: RuntimeWorkerRequest) => Promise<void> {
  return async (request) => {
    try {
      const module = await loadModule(request.haskellFingerprintHash);
      const result = await runCell(module, request);

      postMessage({ requestId: request.requestId, ok: true, result: boundWorkerResult(result) });
    } catch (error) {
      postMessage({
        requestId: request.requestId,
        ok: false,
        error: boundedErrorMessage(error)
      });
    }
  };
}

export async function runHaskellCell(
  module: WebAssembly.Module,
  request: Pick<RuntimeWorkerRequest, 'cellId' | 'inputArgs'>
): Promise<RawCellExecutionResult> {
  const stdout = createOutputCapture();
  const stderr = createOutputCapture();
  const wasi = new WASI(
    ['doc_haskell_cells', request.cellId, ...(request.inputArgs ?? [])],
    [],
    [new OpenFile(new File([])), stdout.file, stderr.file]
  );
  const instance = (await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport
  })) as WasiInstance;
  const exitCode = wasi.start(instance);
  const stdoutResult = stdout.take();
  const stderrResult = stderr.take();
  const result = createHaskellCellResult({
    stdout: stdoutResult.value,
    stdoutTruncated: stdoutResult.truncated,
    stderr: stderrResult.value,
    stderrTruncated: stderrResult.truncated
  });

  if (exitCode !== 0) {
    throw new Error(result.stderr || `Haskell cell exited with status ${exitCode}`);
  }

  return result;
}

export function createHaskellCellResult({
  stderr,
  stderrTruncated = false,
  stdout,
  stdoutTruncated = false
}: {
  stderr: string;
  stderrTruncated?: boolean;
  stdout: string;
  stdoutTruncated?: boolean;
}): RawCellExecutionResult {
  const outputs: TextArtifact[] = [
    stdout
      ? [
          {
            kind: 'text',
            stream: 'stdout',
            content: stdout,
            ...(stdoutTruncated ? { truncated: true } : {})
          } satisfies TextArtifact
        ]
      : [],
    stderr
      ? [
          {
            kind: 'text',
            stream: 'stderr',
            content: stderr,
            ...(stderrTruncated ? { truncated: true } : {})
          } satisfies TextArtifact
        ]
      : []
  ].flat();

  return {
    stdout,
    ...(stderr ? { stderr } : {}),
    plots: [],
    outputs
  };
}

export function resolveHaskellWasmUrl(baseUrl = import.meta.env.BASE_URL, runtimePath = haskellWasmPath): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedRuntimePath = runtimePath.replace(/^\/+|\/+$/gu, '');
  return `${base}${normalizedRuntimePath}/doc_haskell_cells.wasm`;
}

export function resolveHaskellRuntimeStatusUrl(
  baseUrl = import.meta.env.BASE_URL,
  runtimePath = haskellWasmPath
): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedRuntimePath = runtimePath.replace(/^\/+|\/+$/gu, '');
  return `${base}${normalizedRuntimePath}/status.json`;
}

export function createHaskellModuleLoader({
  fetchModule = fetchHaskellModule,
  fetchStatus = fetchHaskellRuntimeStatus,
  statusUrl,
  wasmUrl
}: {
  fetchModule?: typeof fetchHaskellModule;
  fetchStatus?: typeof fetchHaskellRuntimeStatus;
  statusUrl: string;
  wasmUrl: string;
}): (expectedFingerprintHash: string | undefined) => Promise<WebAssembly.Module> {
  let wasmModuleReady: Promise<WebAssembly.Module> | undefined;
  let wasmModuleFingerprintHash: string | undefined;

  return (expectedFingerprintHash) => {
    if (!wasmModuleReady || wasmModuleFingerprintHash !== expectedFingerprintHash) {
      wasmModuleFingerprintHash = expectedFingerprintHash;
      wasmModuleReady = fetchStatus(statusUrl).then((status) => {
        assertReadyHaskellRuntimeStatus(status, expectedFingerprintHash);
        return fetchModule(wasmUrl);
      });
    }
    return wasmModuleReady;
  };
}

export async function fetchHaskellRuntimeStatus(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<HaskellRuntimeStatus> {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Haskell WASI runtime is not available: generated runtime status is missing; rerun pnpm wasm:dev.`);
  }

  return parseHaskellRuntimeStatus(await response.json());
}

export function assertReadyHaskellRuntimeStatus(
  status: HaskellRuntimeStatus,
  expectedFingerprintHash: string | undefined
): void {
  if (status.status === 'unavailable') {
    throw new Error(`Haskell WASI runtime is not available: ${status.message}`);
  }

  if (expectedFingerprintHash && status.haskellFingerprintHash !== expectedFingerprintHash) {
    throw new Error('Haskell WASI runtime is not available: generated runtime is stale; rerun pnpm wasm:dev.');
  }
}

export function parseHaskellRuntimeStatus(value: unknown): HaskellRuntimeStatus {
  if (!isRecord(value)) {
    throw new Error('Haskell WASI runtime is not available: generated runtime status is invalid.');
  }

  const { haskellFingerprintHash, message, status } = value;
  if (
    (status !== 'ready' && status !== 'unavailable') ||
    typeof haskellFingerprintHash !== 'string' ||
    typeof message !== 'string'
  ) {
    throw new Error('Haskell WASI runtime is not available: generated runtime status is invalid.');
  }

  return { haskellFingerprintHash, message, status };
}

export async function fetchHaskellModule(url: string, fetchImpl: typeof fetch = fetch): Promise<WebAssembly.Module> {
  const response = await fetchImpl(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }
  const fallbackResponse = response.clone();

  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(Promise.resolve(response));
    } catch {
      // Vite's dev server can serve .wasm with a non-wasm content type.
    }
  }

  return WebAssembly.compile(await fallbackResponse.arrayBuffer());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function createOutputCapture(maxBytes = outputArtifactLimits.bytesPerStream): {
  file: ConsoleStdout;
  take: () => { truncated: boolean; value: string };
} {
  const chunks: string[] = [];
  const decoder = new TextDecoder();
  let byteLength = 0;
  let truncated = false;

  return {
    file: new ConsoleStdout((buffer) => {
      if (truncated) return;
      const retained = buffer.subarray(0, Math.max(0, maxBytes - byteLength));
      if (retained.byteLength > 0) {
        chunks.push(decoder.decode(retained, { stream: true }));
        byteLength += retained.byteLength;
      }
      truncated = retained.byteLength < buffer.byteLength;
    }),
    take: () => {
      const bounded = truncateUtf8(`${chunks.join('')}${decoder.decode()}`.trimEnd(), maxBytes);
      return { value: bounded.value, truncated: truncated || bounded.truncated };
    }
  };
}
