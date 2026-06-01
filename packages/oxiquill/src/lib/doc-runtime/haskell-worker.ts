import {
  ConsoleStdout,
  File,
  OpenFile,
  WASI
} from '@bjorn3/browser_wasi_shim';
import type {
  RawCellExecutionResult,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
  TextArtifact
} from './types';

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

type WasiInstance = WebAssembly.Instance & {
  exports: {
    memory: WebAssembly.Memory;
    _start: () => unknown;
  };
};

const worker = self as unknown as WorkerScope;
let wasmModuleReady: Promise<WebAssembly.Module> | undefined;
const haskellWasmUrl = resolveHaskellWasmUrl();

worker.addEventListener('message', (event) => {
  void handleRequest(event.data);
});

async function handleRequest(request: RuntimeWorkerRequest): Promise<void> {
  try {
    const module = await ensureHaskellModule();
    const result = await runHaskellCell(module, request);

    worker.postMessage({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
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
    [
      new OpenFile(new File([])),
      stdout.file,
      stderr.file
    ]
  );
  const instance = await WebAssembly.instantiate(module, {
    wasi_snapshot_preview1: wasi.wasiImport
  }) as WasiInstance;
  const exitCode = wasi.start(instance);
  const result = createHaskellCellResult({
    stdout: stdout.take(),
    stderr: stderr.take()
  });

  if (exitCode !== 0) {
    throw new Error(result.stderr || `Haskell cell exited with status ${exitCode}`);
  }

  return result;
}

export function createHaskellCellResult({
  stderr,
  stdout
}: {
  stderr: string;
  stdout: string;
}): RawCellExecutionResult {
  const outputs: TextArtifact[] = [
    stdout ? [{ kind: 'text', stream: 'stdout', content: stdout } satisfies TextArtifact] : [],
    stderr ? [{ kind: 'text', stream: 'stderr', content: stderr } satisfies TextArtifact] : []
  ].flat();

  return {
    stdout,
    ...(stderr ? { stderr } : {}),
    plots: [],
    outputs
  };
}

export function resolveHaskellWasmUrl(baseUrl = import.meta.env.BASE_URL): string {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  return `${base}oxiquill/haskell-wasm/doc_haskell_cells.wasm`;
}

function ensureHaskellModule(): Promise<WebAssembly.Module> {
  wasmModuleReady ??= fetchHaskellModule(haskellWasmUrl);
  return wasmModuleReady;
}

async function fetchHaskellModule(url: string): Promise<WebAssembly.Module> {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) {
    throw new Error(`Failed to load ${url}: ${response.status} ${response.statusText}`);
  }

  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(Promise.resolve(response));
    } catch {
      // Vite's dev server can serve .wasm with a non-wasm content type.
    }
  }

  return WebAssembly.compile(await response.arrayBuffer());
}

function createOutputCapture(): {
  file: ConsoleStdout;
  take: () => string;
} {
  const chunks: string[] = [];
  const decoder = new TextDecoder();

  return {
    file: new ConsoleStdout((buffer) => {
      chunks.push(decoder.decode(buffer, { stream: true }));
    }),
    take: () => `${chunks.join('')}${decoder.decode()}`.trimEnd()
  };
}
