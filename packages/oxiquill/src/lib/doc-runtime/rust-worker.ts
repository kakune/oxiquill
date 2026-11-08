import { boundedErrorMessage } from './output-limits.mjs';
import type {
  RawCellExecutionResult,
  RuntimeWorkerRequest,
  RuntimeWorkerResponse,
  RustRuntimeModule,
  RustRuntimeRegistry,
  RustWorkerRequest
} from './types.js';
import { boundWorkerResult } from './worker-output.js';

type RustGlue = {
  default: (options: { module_or_path: Response }) => Promise<unknown>;
  run_rust_cell: (cellId: string, inputs: string, dependencies: string) => string;
};

type WorkerScope = {
  addEventListener(type: 'message', listener: (event: MessageEvent<RustWorkerRequest>) => void): void;
  postMessage(response: RuntimeWorkerResponse): void;
};

export function createRustRuntimeLoader({
  fetchImpl = globalThis.fetch,
  importGlue = (url: string): Promise<RustGlue> => import(/* @vite-ignore */ url)
}: { fetchImpl?: typeof fetch; importGlue?: (url: string) => Promise<RustGlue> } = {}) {
  const loaded = new Map<string, Promise<RustGlue>>();
  let current: RustRuntimeRegistry | undefined;
  const key = (module: Pick<RustRuntimeModule, 'id' | 'fingerprint'>) =>
    JSON.stringify([module.id, module.fingerprint]);
  const isCurrent = (module: RustRuntimeModule) =>
    !current || current.modules.some((candidate) => key(candidate) === key(module));

  function update(registry: RustRuntimeRegistry): void {
    current = registry;
    const retained = new Set(registry.modules.map(key));
    for (const entry of loaded.keys()) if (!retained.has(entry)) loaded.delete(entry);
  }

  function load(module: RustRuntimeModule): Promise<RustGlue> {
    if (!isCurrent(module)) return Promise.reject(new Error(`Rust module ${module.id} has an obsolete fingerprint.`));
    const moduleKey = key(module);
    const cached = loaded.get(moduleKey);
    if (cached) return cached;
    const attempt = Promise.all([
      importGlue(module.glue.url),
      fetchImpl(module.wasm.url, { integrity: module.wasm.integrity })
    ])
      .then(async ([glue, response]) => {
        if (!response.ok) throw new Error(`Wasm fetch returned HTTP ${response.status}.`);
        await glue.default({ module_or_path: response });
        if (!isCurrent(module)) throw new Error('The module fingerprint is obsolete.');
        return glue;
      })
      .catch((cause: unknown) => {
        if (loaded.get(moduleKey) === attempt) loaded.delete(moduleKey);
        throw new Error(`Rust module ${module.id} could not load: ${boundedErrorMessage(cause)}`);
      });
    loaded.set(moduleKey, attempt);
    return attempt;
  }
  return { load, update, isCurrent };
}

export function createRustWorkerRequestHandler({
  loader,
  postMessage
}: {
  loader: ReturnType<typeof createRustRuntimeLoader>;
  postMessage: (response: RuntimeWorkerResponse) => void;
}) {
  return async (request: RuntimeWorkerRequest): Promise<void> => {
    const rustModule = request.rustModule;
    const identity = rustModule ? { rustModule: { id: rustModule.id, fingerprint: rustModule.fingerprint } } : {};
    try {
      if (!rustModule || !rustModule.cells.includes(request.cellId))
        throw new Error(`Rust cell ${request.cellId} has no matching module descriptor.`);
      const glue = await loader.load(rustModule);
      if (!loader.isCurrent(rustModule)) throw new Error(`Rust module ${rustModule.id} has an obsolete fingerprint.`);
      const result = boundWorkerResult(
        JSON.parse(
          glue.run_rust_cell(request.cellId, JSON.stringify(request.inputs), JSON.stringify(request.dependencies ?? {}))
        ) as RawCellExecutionResult
      );
      postMessage({ requestId: request.requestId, ...identity, ok: true, result });
    } catch (error) {
      postMessage({ requestId: request.requestId, ...identity, ok: false, error: boundedErrorMessage(error) });
    }
  };
}

const worker = self as unknown as WorkerScope;
const loader = createRustRuntimeLoader();
const handleRequest = createRustWorkerRequestHandler({
  loader,
  postMessage: (response) => worker.postMessage(response)
});
worker.addEventListener('message', (event) => {
  if ('type' in event.data) loader.update(event.data.registry);
  else void handleRequest(event.data);
});
