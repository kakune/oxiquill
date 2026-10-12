import { pyodidePath } from 'virtual:oxiquill/runtime-paths';
import { boundedErrorMessage, createBoundedTextAccumulator, outputArtifactLimits } from './output-limits.mjs';
import { pythonDisplaySupportCode } from './python-display-support.js';
import { supportedPyodidePackages } from './python-packages.mjs';
import { createPythonCellResult, toOutputArtifacts } from './python-cell-result.js';
import { createSerialRequestQueue } from './python-worker-queue.js';
import type { PythonWorkerRequest, PythonWorkerResponse } from './types.js';
import { boundWorkerResult } from './worker-output.js';
import { markRuntimeEvent, measureRuntimePhase } from './runtime-timing.js';

export { pythonDisplaySupportCode } from './python-display-support.js';
export { createPythonCellResult } from './python-cell-result.js';
export { createSerialRequestQueue } from './python-worker-queue.js';

type LoadPyodide = typeof import('pyodide').loadPyodide;
type PyodideRuntime = Awaited<ReturnType<LoadPyodide>>;

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<PythonWorkerRequest>) => void): void;
  postMessage(response: PythonWorkerResponse): void;
};

type PyodideModule = { loadPyodide: LoadPyodide };
type PythonWorkerHandlerDependencies = {
  ensurePyodide: (packages?: readonly string[]) => Promise<PyodideRuntime>;
  postMessage: (response: PythonWorkerResponse) => void;
};
type PyodideModuleDependencies = {
  createObjectUrl?: (blob: Blob) => string;
  fetchImplementation?: typeof fetch;
  importModule?: (moduleUrl: string) => Promise<PyodideModule>;
  revokeObjectUrl?: (moduleUrl: string) => void;
};

const worker = self as unknown as WorkerScope;
markRuntimeEvent('worker-ready', 'python');
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
}: PythonWorkerHandlerDependencies): (request: PythonWorkerRequest) => Promise<void> {
  return async (request) => {
    let initializedRuntime: PyodideRuntime | undefined;
    let prepared = false;
    const stdout = createBoundedTextAccumulator(outputArtifactLimits.bytesPerStream, '\n');
    const stderr = createBoundedTextAccumulator(outputArtifactLimits.bytesPerStream, '\n');
    const collectResult = (value: unknown = null) => {
      const displayOutputs = initializedRuntime ? collectPythonOutputs(initializedRuntime) : [];
      const stdoutResult = stdout.take();
      const stderrResult = stderr.take();
      return boundWorkerResult(
        createPythonCellResult({
          stdout: stdoutResult.value.trimEnd(),
          stdoutTruncated: stdoutResult.truncated,
          stderr: stderrResult.value.trimEnd(),
          stderrTruncated: stderrResult.truncated,
          value,
          displayOutputs
        })
      );
    };
    try {
      postMessage({ type: 'progress', requestId: request.requestId, phase: 'preparing' });
      const pyodide = await ensurePyodide(request.packages);
      initializedRuntime = pyodide;
      const packages = request.packages?.filter((name) => !Object.hasOwn(pyodide.loadedPackages ?? {}, name)) ?? [];
      if (packages.length > 0) {
        await measureRuntimePhase('packages', 'cellId' in request ? request.cellId : 'python', () =>
          pyodide.loadPackage(packages)
        );
      }
      if (!('cellId' in request)) {
        postMessage({ type: 'ready', requestId: request.requestId, ok: true });
        return;
      }
      pyodide.setStdout({ batched: stdout.append });
      pyodide.setStderr({ batched: stderr.append });
      await measureRuntimePhase('display-prepare', request.cellId, () =>
        pyodide.runPython(
          `__oxiquill_prepare_cell(${Object.hasOwn(pyodide.loadedPackages ?? {}, 'matplotlib') ? 'True' : 'False'})`
        )
      );
      prepared = true;
      if (request.source) {
        assertSupportedPythonImports(pyodide, request.source, request.shippedPackages);
        await measureRuntimePhase('imports', request.cellId, () =>
          pyodide.loadPackagesFromImports(request.source ?? '')
        );
        pyodide.runPython(
          `__oxiquill_configure_matplotlib(${Object.hasOwn(pyodide.loadedPackages ?? {}, 'matplotlib') ? 'True' : 'False'})`
        );
      }
      postMessage({ type: 'progress', requestId: request.requestId, phase: 'executing' });

      const globals = pyodide.toPy(request.inputs);
      let value: unknown = null;

      try {
        for (const inputName of request.integerInputNames ?? []) {
          pyodide.runPython(pythonIntegerConversionCode(inputName), { globals });
        }
        value = toSerializable(
          await measureRuntimePhase('execution', request.cellId, () =>
            pyodide.runPythonAsync(request.source ?? '', { globals })
          )
        );
      } finally {
        try {
          globals.destroy();
        } catch (error) {
          stderr.append(`Failed to release Python globals: ${boundedErrorMessage(error)}`);
        }
      }
      const result = await measureRuntimePhase('display-collect', request.cellId, () => collectResult(value));

      postMessage({ requestId: request.requestId, ok: true, result });
    } catch (error) {
      const partialResult = prepared ? collectResult() : undefined;
      postMessage({
        requestId: request.requestId,
        ok: false,
        error: boundedErrorMessage(error),
        ...(partialResult?.outputs.length ? { partialResult } : {})
      });
    } finally {
      if (initializedRuntime && 'cellId' in request) {
        try {
          initializedRuntime.runPython('__oxiquill_close_figures()');
        } catch {
          // Cleanup must not replace the original execution error.
        }
      }
    }
  };
}

function collectPythonOutputs(pyodide: PyodideRuntime): readonly unknown[] {
  return ['__oxiquill_take_outputs()', '__oxiquill_collect_matplotlib_outputs()'].flatMap((source) => {
    try {
      return toOutputArtifacts(toSerializable(pyodide.runPython(source)));
    } catch (error) {
      return [{ kind: '__oxiquill_error', message: `Failed to collect Python output: ${boundedErrorMessage(error)}` }];
    }
  });
}

/**
 * Rejects imports of lock-file packages outside the site's shipped set, the declared packages' dependency
 * closure. The full lock file is copied, so Pyodide would otherwise try to fetch wheels that were never shipped.
 */
export function assertSupportedPythonImports(
  pyodide: Pick<PyodideRuntime, 'runPython' | 'lockfile'>,
  source: string,
  shippedPackages?: readonly string[]
): void {
  const proxy = pyodide.runPython(
    `__import__('pyodide.code', fromlist=['find_imports']).find_imports(${JSON.stringify(source)})`
  );
  const imports = toSerializable(proxy);
  if (!Array.isArray(imports)) throw new Error('Unable to inspect Python imports.');
  const available = shippedPackages
    ? lockfileDependencyClosure(pyodide.lockfile.packages, shippedPackages)
    : new Set(supportedPyodidePackages);
  const unsupported = Object.entries(pyodide.lockfile.packages).find(
    ([name, info]) => !available.has(name) && info.imports.some((module) => imports.includes(module.split('.')[0]))
  );
  if (unsupported) throw new Error(`Python package ${unsupported[0]} is not shipped with this site.`);
}

function lockfileDependencyClosure(
  packages: PyodideRuntime['lockfile']['packages'],
  roots: readonly string[]
): Set<string> {
  const selected = new Set<string>();
  const visit = (name: string): void => {
    if (selected.has(name)) return;
    selected.add(name);
    (packages[name]?.depends ?? []).forEach(visit);
  };
  roots.forEach(visit);
  return selected;
}

export function createPythonRuntimeLoader({
  indexUrl,
  importModule = importPyodideModule,
  moduleUrl
}: {
  indexUrl: string;
  importModule?: (moduleUrl: string) => Promise<PyodideModule>;
  moduleUrl: string;
}): (packages?: readonly string[]) => Promise<PyodideRuntime> {
  let pyodideReady: Promise<PyodideRuntime> | undefined;
  let loadPyodideReady: Promise<LoadPyodide> | undefined;

  return (packages = []) => {
    if (!loadPyodideReady) {
      const importedLoader = importModule(moduleUrl).then((module) => module.loadPyodide);
      loadPyodideReady = importedLoader;
      void importedLoader.catch(() => {
        if (loadPyodideReady === importedLoader) loadPyodideReady = undefined;
      });
    }

    if (!pyodideReady) {
      const runtime = loadPyodideReady.then(async (loadPyodide) => {
        const pyodide = await measureRuntimePhase('initialization', 'python', () =>
          loadPyodide({ indexURL: indexUrl, packages: Array.from(packages) })
        );
        await measureRuntimePhase('display-support', 'python', () => pyodide.runPythonAsync(pythonDisplaySupportCode));
        return pyodide;
      });
      pyodideReady = runtime;
      void runtime.catch(() => {
        if (pyodideReady === runtime) pyodideReady = undefined;
      });
    }

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
