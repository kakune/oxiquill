import type { CellExecutionResult, RuntimeWorkerRequest, RuntimeWorkerResponse } from './types';

type LoadPyodide = typeof import('pyodide').loadPyodide;
type PyodideRuntime = Awaited<ReturnType<LoadPyodide>>;

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

const worker = self as unknown as WorkerScope;
let pyodideReady: Promise<PyodideRuntime> | undefined;
let loadPyodideReady: Promise<LoadPyodide> | undefined;
const pyodideModuleUrl = '/pyodide/pyodide.mjs';
const requestQueue = createSerialRequestQueue(handleRequest);

worker.addEventListener('message', (event) => {
  requestQueue.enqueue(event.data);
});

export function createSerialRequestQueue<Request>(
  handle: (request: Request) => Promise<void>
): { enqueue: (request: Request) => void } {
  let tail = Promise.resolve();

  return {
    enqueue(request) {
      tail = tail
        .catch(() => undefined)
        .then(() => handle(request))
        .catch(() => undefined);
    }
  };
}

async function handleRequest(request: RuntimeWorkerRequest): Promise<void> {
  try {
    const pyodide = await ensurePyodide();
    const stdout: string[] = [];
    const stderr: string[] = [];

    pyodide.setStdout({ batched: (output) => stdout.push(output) });
    pyodide.setStderr({ batched: (output) => stderr.push(output) });

    if (request.packages && request.packages.length > 0) {
      await pyodide.loadPackage(Array.from(request.packages));
    }
    if (request.source) {
      await pyodide.loadPackagesFromImports(request.source);
    }

    const globals = pyodide.toPy(request.inputs);
    let value: unknown = null;

    try {
      value = toSerializable(await pyodide.runPythonAsync(request.source ?? '', { globals }));
    } finally {
      globals.destroy();
    }

    const result: CellExecutionResult = {
      stdout: stdout.join('\n').trimEnd(),
      stderr: stderr.join('\n').trimEnd(),
      value,
      plots: []
    };

    worker.postMessage({ requestId: request.requestId, ok: true, result });
  } catch (error) {
    worker.postMessage({
      requestId: request.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    });
  }
}

function ensurePyodide(): Promise<PyodideRuntime> {
  pyodideReady ??= getLoadPyodide().then((loadPyodide) => loadPyodide({ indexURL: '/pyodide/' }));
  return pyodideReady;
}

function getLoadPyodide(): Promise<LoadPyodide> {
  loadPyodideReady ??= importPyodideModule().then((module) => module.loadPyodide);
  return loadPyodideReady;
}

async function importPyodideModule(): Promise<{ loadPyodide: LoadPyodide }> {
  const response = await fetch(pyodideModuleUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${pyodideModuleUrl}: ${response.status} ${response.statusText}`);
  }

  const moduleUrl = URL.createObjectURL(
    new Blob([await response.text()], { type: 'text/javascript' })
  );

  try {
    return (await import(/* @vite-ignore */ moduleUrl)) as { loadPyodide: LoadPyodide };
  } finally {
    URL.revokeObjectURL(moduleUrl);
  }
}

function toSerializable(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === 'object' && value && 'toJs' in value) {
    const proxy = value as { destroy?: () => void; toJs: (options?: unknown) => unknown };
    try {
      return proxy.toJs();
    } finally {
      proxy.destroy?.();
    }
  }

  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}
