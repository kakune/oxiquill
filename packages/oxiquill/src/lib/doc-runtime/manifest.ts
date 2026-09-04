import { runtimeVersion as generatedRuntimeVersion } from 'virtual:oxiquill/runtime-version';
import { resetInteractiveRuntime } from './runtime-client.js';
import type { CellManifest } from './types.js';

type RuntimeVersionModule = {
  runtimeVersion: string;
};

type GeneratedManifestPayload = {
  cells: readonly CellManifest[];
  runtimeVersion: string;
};

type ManifestSnapshot = {
  cells: readonly CellManifest[];
  version: string;
};

type ManifestHotData = Partial<ManifestSnapshot>;

type ManifestRefreshResult =
  | {
      snapshot: ManifestSnapshot;
      status: 'success';
    }
  | {
      status: 'failure';
    };

type ManifestRefreshWindow = Pick<Window, 'clearTimeout' | 'setTimeout'>;

type ManifestRefreshGeneration = {
  generation: number;
  queued: boolean;
  refresh: (options?: Pick<ManifestRefreshOptions, 'signal'>) => Promise<ManifestRefreshResult>;
  succeeded: boolean;
  timers: Set<number>;
  windowObject: ManifestRefreshWindow;
};

type ActiveManifestRefresh = {
  abortController: AbortController | undefined;
  generation: ManifestRefreshGeneration;
};

const hotData = import.meta.hot?.data as ManifestHotData | undefined;
let cellsSnapshot = initialCellsSnapshot(hotData);
let versionSnapshot = initialVersionSnapshot(hotData);
const listeners = new Set<() => void>();
let freshImportSequence = 0;
let refreshGenerationSequence = 0;
let currentRefreshGeneration: ManifestRefreshGeneration | undefined;
let activeManifestRefresh: ActiveManifestRefresh | undefined;

export function getCell(cellId: string): CellManifest | undefined {
  return cellsSnapshot.find((cell) => cell.id === cellId);
}

export function getManifestSnapshot(): ManifestSnapshot {
  return {
    cells: cellsSnapshot,
    version: versionSnapshot
  };
}

export function subscribeManifest(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

if (import.meta.hot?.data) {
  persistHotData();
  scheduleGeneratedManifestRefresh();
  import.meta.hot.on('oxiquill:manifest-changed', () => {
    scheduleGeneratedManifestRefresh();
  });

  import.meta.hot.accept('virtual:oxiquill/runtime-version', (module) => {
    if (module) {
      applyRuntimeVersionSnapshot((module as unknown as RuntimeVersionModule).runtimeVersion);
    }
  });

  import.meta.hot.dispose(disposeGeneratedManifestRefresh);
}

function initialCellsSnapshot(data: ManifestHotData | undefined): readonly CellManifest[] {
  return data?.cells && data.version ? data.cells : [];
}

function initialVersionSnapshot(data: ManifestHotData | undefined): string {
  return data?.cells && data.version ? data.version : generatedRuntimeVersion;
}

function persistHotData(): void {
  if (!import.meta.hot?.data) return;

  const data = import.meta.hot.data as ManifestHotData;
  data.cells = cellsSnapshot;
  data.version = versionSnapshot;
}

export function applyCellsSnapshot(nextCells: readonly CellManifest[]): void {
  if (nextCells === cellsSnapshot) return;

  cellsSnapshot = nextCells;
  persistHotData();
  notifyManifestListeners();
  syncRenderedSourceBlocks();
}

export function applyRuntimeVersionSnapshot(nextVersion: string): void {
  if (nextVersion === versionSnapshot) return;

  versionSnapshot = nextVersion;
  persistHotData();
  resetGeneratedWasmRuntimes();
  notifyManifestListeners();
  syncRenderedSourceBlocks();
}

export function applyGeneratedSnapshot(nextSnapshot: ManifestSnapshot): void {
  const cellsChanged = nextSnapshot.cells !== cellsSnapshot;
  const versionChanged = nextSnapshot.version !== versionSnapshot;
  if (!cellsChanged && !versionChanged) return;

  cellsSnapshot = nextSnapshot.cells;
  versionSnapshot = nextSnapshot.version;
  persistHotData();
  if (versionChanged) resetGeneratedWasmRuntimes();
  notifyManifestListeners();
  syncRenderedSourceBlocks();
}

function notifyManifestListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}

function resetGeneratedWasmRuntimes(): void {
  resetInteractiveRuntime('rust');
  resetInteractiveRuntime('haskell');
}

type ManifestRefreshOptions = {
  fetchImpl?: typeof fetch;
  hasHotRuntime?: boolean;
  now?: () => number;
  signal?: AbortSignal;
  windowObject?: Window;
};

export async function refreshGeneratedManifest({
  fetchImpl = globalThis.fetch,
  hasHotRuntime = Boolean(import.meta.hot),
  now = Date.now,
  signal,
  windowObject = globalThis.window
}: ManifestRefreshOptions = {}): Promise<ManifestRefreshResult> {
  if (!hasHotRuntime || !windowObject || typeof fetchImpl !== 'function') return { status: 'failure' };

  try {
    const response = await fetchImpl(freshManifestUrl(now), {
      cache: 'no-store',
      ...(signal ? { signal } : {})
    });
    if (!response.ok) {
      throw new Error(`Received ${response.status} from the generated manifest endpoint.`);
    }

    const payload = (await response.json()) as GeneratedManifestPayload;

    return {
      snapshot: {
        cells: payload.cells,
        version: payload.runtimeVersion
      },
      status: 'success'
    };
  } catch (error) {
    if (signal?.aborted || error instanceof TypeError) return { status: 'failure' };
    console.warn('Oxiquill could not refresh the generated interactive cell manifest.', error);
    return { status: 'failure' };
  }
}

type ManifestScheduleOptions = {
  refresh?: (options?: Pick<ManifestRefreshOptions, 'signal'>) => Promise<ManifestRefreshResult>;
  windowObject?: ManifestRefreshWindow;
};

export function scheduleGeneratedManifestRefresh({
  refresh = refreshGeneratedManifest,
  windowObject = globalThis.window
}: ManifestScheduleOptions = {}): () => void {
  if (!windowObject) return disposeGeneratedManifestRefresh;

  cancelRefreshGeneration(currentRefreshGeneration);
  abortActiveManifestRefresh();

  const generation: ManifestRefreshGeneration = {
    generation: ++refreshGenerationSequence,
    queued: false,
    refresh,
    succeeded: false,
    timers: new Set(),
    windowObject
  };
  currentRefreshGeneration = generation;

  for (const delay of [0, 250, 1_000, 2_500, 5_000]) {
    const timer = windowObject.setTimeout(() => {
      generation.timers.delete(timer);
      requestManifestRefresh(generation);
    }, delay);
    generation.timers.add(timer);
  }

  return disposeGeneratedManifestRefresh;
}

function requestManifestRefresh(generation: ManifestRefreshGeneration): void {
  if (currentRefreshGeneration !== generation || generation.succeeded) return;

  if (activeManifestRefresh) {
    generation.queued = true;
    return;
  }

  const attempt: ActiveManifestRefresh = {
    abortController: typeof AbortController === 'undefined' ? undefined : new AbortController(),
    generation
  };
  activeManifestRefresh = attempt;

  void generation.refresh({ signal: attempt.abortController?.signal }).then(
    (result) => finishManifestRefresh(attempt, result),
    (error: unknown) => {
      console.warn('Oxiquill could not refresh the generated interactive cell manifest.', error);
      finishManifestRefresh(attempt, { status: 'failure' });
    }
  );
}

function finishManifestRefresh(attempt: ActiveManifestRefresh, result: ManifestRefreshResult): void {
  if (activeManifestRefresh !== attempt) return;

  activeManifestRefresh = undefined;
  const generation = attempt.generation;
  if (currentRefreshGeneration !== generation) {
    requestQueuedManifestRefresh();
    return;
  }

  if (result.status === 'success') {
    generation.succeeded = true;
    generation.queued = false;
    cancelRefreshTimers(generation);
    applyGeneratedSnapshot(result.snapshot);
    return;
  }

  if (generation.queued) {
    generation.queued = false;
    requestManifestRefresh(generation);
  }
}

function requestQueuedManifestRefresh(): void {
  const generation = currentRefreshGeneration;
  if (!generation?.queued) return;

  generation.queued = false;
  requestManifestRefresh(generation);
}

function disposeGeneratedManifestRefresh(): void {
  cancelRefreshGeneration(currentRefreshGeneration);
  currentRefreshGeneration = undefined;
  abortActiveManifestRefresh();
}

function abortActiveManifestRefresh(): void {
  const activeRefresh = activeManifestRefresh;
  activeManifestRefresh = undefined;
  activeRefresh?.abortController?.abort();
}

function cancelRefreshGeneration(generation: ManifestRefreshGeneration | undefined): void {
  if (!generation) return;

  generation.queued = false;
  cancelRefreshTimers(generation);
}

function cancelRefreshTimers(generation: ManifestRefreshGeneration): void {
  for (const timer of generation.timers) {
    generation.windowObject.clearTimeout(timer);
  }
  generation.timers.clear();
}

export function freshManifestUrl(now: () => number = Date.now): string {
  freshImportSequence += 1;
  return `/__oxiquill/manifest.json?oxiquill-fresh=${now()}-${freshImportSequence}`;
}

export function syncRenderedSourceBlocks(documentObject: Document | undefined = globalThis.document): void {
  if (!documentObject) return;

  for (const sourceBlock of documentObject.querySelectorAll<HTMLElement>(
    '.doc-cell[data-cell-id] [data-testid="cell-source"]'
  )) {
    const cellId = sourceBlock.closest<HTMLElement>('.doc-cell[data-cell-id]')?.dataset.cellId;
    const cell = cellId ? getCell(cellId) : undefined;
    if (cell && sourceBlock.innerHTML !== cell.sourceHtml) {
      sourceBlock.innerHTML = cell.sourceHtml;
    }
  }
}
