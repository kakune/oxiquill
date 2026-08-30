import { pyodidePath } from 'virtual:oxiquill/runtime-paths';
import { pythonDisplaySupportCode } from './python-display-support.js';
import { createPythonCellResult, toOutputArtifacts } from './python-cell-result.js';
import { createSerialRequestQueue } from './python-worker-queue.js';
import type { RuntimeWorkerRequest, RuntimeWorkerResponse } from './types.js';

export { pythonDisplaySupportCode } from './python-display-support.js';
export { createPythonCellResult } from './python-cell-result.js';
export { createSerialRequestQueue } from './python-worker-queue.js';

type LoadPyodide = typeof import('pyodide').loadPyodide;
type PyodideRuntime = Awaited<ReturnType<LoadPyodide>>;

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RuntimeWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

type PyodideModule = { loadPyodide: LoadPyodide };
type PythonWorkerHandlerDependencies = {
  ensurePyodide: () => Promise<PyodideRuntime>;
  postMessage: (response: RuntimeWorkerResponse) => void;
};
type PyodideModuleDependencies = {
  createObjectUrl?: (blob: Blob) => string;
  fetchImplementation?: typeof fetch;
  importModule?: (moduleUrl: string) => Promise<PyodideModule>;
  revokeObjectUrl?: (moduleUrl: string) => void;
};

const worker = self as unknown as WorkerScope;
const pyodideUrls = resolvePyodideUrls();
const ensurePyodide = createPythonRuntimeLoader(pyodideUrls);
const handleRequest = createPythonWorkerRequestHandler({
  ensurePyodide,
  postMessage: (response) => worker.postMessage(response)
});
const requestQueue = createSerialRequestQueue(handleRequest);

worker.addEventListener('message', (event) => {
  requestQueue.enqueue(event.data);
});

export function createPythonWorkerRequestHandler({
  ensurePyodide,
  postMessage
}: PythonWorkerHandlerDependencies): (request: RuntimeWorkerRequest) => Promise<void> {
  return async (request) => {
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
      pyodide.runPython('__oxiquill_prepare_cell()');

      const globals = pyodide.toPy(request.inputs);
      let value: unknown = null;

      try {
        for (const inputName of request.integerInputNames ?? []) {
          pyodide.runPython(pythonIntegerConversionCode(inputName), { globals });
        }
        value = toSerializable(await pyodide.runPythonAsync(request.source ?? '', { globals }));
      } finally {
        globals.destroy();
      }
      const displayOutputs = toOutputArtifacts(toSerializable(pyodide.runPython('__oxiquill_take_outputs()')));
      const matplotlibOutputs = toOutputArtifacts(
        toSerializable(pyodide.runPython('__oxiquill_collect_matplotlib_outputs()'))
      );

      const result = createPythonCellResult({
        stdout: stdout.join('\n').trimEnd(),
        stderr: stderr.join('\n').trimEnd(),
        value,
        plots: [],
        displayOutputs: [...displayOutputs, ...matplotlibOutputs]
      });

      postMessage({ requestId: request.requestId, ok: true, result });
    } catch (error) {
      postMessage({
        requestId: request.requestId,
        ok: false,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  };
}

export function createPythonRuntimeLoader({
  indexUrl,
  importModule = importPyodideModule,
  moduleUrl
}: {
  indexUrl: string;
  importModule?: (moduleUrl: string) => Promise<PyodideModule>;
  moduleUrl: string;
}): () => Promise<PyodideRuntime> {
  let pyodideReady: Promise<PyodideRuntime> | undefined;
  let loadPyodideReady: Promise<LoadPyodide> | undefined;

  return () => {
    loadPyodideReady ??= importModule(moduleUrl).then((module) => module.loadPyodide);
    pyodideReady ??= loadPyodideReady.then(async (loadPyodide) => {
      const pyodide = await loadPyodide({ indexURL: indexUrl });
      await pyodide.runPythonAsync(pythonDisplaySupportCode);
      return pyodide;
    });
    return pyodideReady;
  };
}

export function pythonIntegerConversionCode(inputName: string): string {
  if (!/^[a-z][a-z0-9_]*$/u.test(inputName)) throw new Error(`Invalid integer input name: ${inputName}`);
  return `${inputName} = int(${inputName})`;
}

export async function importPyodideModule(
  pyodideModuleUrl: string,
  {
    createObjectUrl = (blob) => URL.createObjectURL(blob),
    fetchImplementation = fetch,
    importModule = importModuleUrl,
    revokeObjectUrl = (moduleUrl) => URL.revokeObjectURL(moduleUrl)
  }: PyodideModuleDependencies = {}
): Promise<PyodideModule> {
  const response = await fetchImplementation(pyodideModuleUrl);
  if (!response.ok) {
    throw new Error(`Failed to load ${pyodideModuleUrl}: ${response.status} ${response.statusText}`);
  }

  const moduleUrl = createObjectUrl(new Blob([await response.text()], { type: 'text/javascript' }));

  try {
    return await importModule(moduleUrl);
  } finally {
    revokeObjectUrl(moduleUrl);
  }
}

async function importModuleUrl(moduleUrl: string): Promise<PyodideModule> {
  return (await import(/* @vite-ignore */ moduleUrl)) as PyodideModule;
}

export function resolvePyodideUrls(
  baseUrl = import.meta.env.BASE_URL,
  runtimePath = pyodidePath
): {
  indexUrl: string;
  moduleUrl: string;
} {
  const base = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const normalizedRuntimePath = runtimePath.replace(/^\/+|\/+$/gu, '');
  const indexUrl = `${base}${normalizedRuntimePath}/`;

  return {
    indexUrl,
    moduleUrl: `${indexUrl}pyodide.mjs`
  };
}

function toSerializable(value: unknown): unknown {
  if (value == null) return null;

  if (typeof value === 'object' && value && 'toJs' in value) {
    const proxy = value as { destroy?: () => void; toJs: (options?: unknown) => unknown };
    try {
      return proxy.toJs({ dict_converter: Object.fromEntries });
    } finally {
      proxy.destroy?.();
    }
  }

  if (typeof value === 'number' || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }

  return String(value);
}
