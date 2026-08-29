import { cells as generatedCells } from 'virtual:oxiquill/cells';
import { runtimeVersion as generatedRuntimeVersion } from 'virtual:oxiquill/runtime-version';
import { resetInteractiveRuntime } from './runtime-client.js';
import type { CellManifest } from './types.js';

type GeneratedCellsModule = {
  cells: readonly CellManifest[];
};

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

const hotData = import.meta.hot?.data as ManifestHotData | undefined;
let cellsSnapshot = initialCellsSnapshot(hotData);
let versionSnapshot = initialVersionSnapshot(hotData);
const listeners = new Set<() => void>();
let freshImportSequence = 0;

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

  import.meta.hot.accept('virtual:oxiquill/cells', (module) => {
    if (module) {
      applyCellsSnapshot((module as unknown as GeneratedCellsModule).cells);
    }
  });

  import.meta.hot.accept('virtual:oxiquill/runtime-version', (module) => {
    if (module) {
      applyRuntimeVersionSnapshot((module as unknown as RuntimeVersionModule).runtimeVersion);
    }
  });
}

function initialCellsSnapshot(data: ManifestHotData | undefined): readonly CellManifest[] {
  return data?.cells && data.version ? data.cells : (generatedCells as readonly CellManifest[]);
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
  windowObject?: Window;
};

export async function refreshGeneratedManifest({
  fetchImpl = globalThis.fetch,
  hasHotRuntime = Boolean(import.meta.hot),
  now = Date.now,
  windowObject = globalThis.window
}: ManifestRefreshOptions = {}): Promise<void> {
  if (!hasHotRuntime || !windowObject || typeof fetchImpl !== 'function') return;

  try {
    const response = await fetchImpl(freshManifestUrl(now), { cache: 'no-store' });
    if (!response.ok) {
      throw new Error(`Received ${response.status} from the generated manifest endpoint.`);
    }

    const payload = (await response.json()) as GeneratedManifestPayload;

    applyGeneratedSnapshot({
      cells: payload.cells,
      version: payload.runtimeVersion
    });
  } catch (error) {
    if (error instanceof TypeError) return;
    console.warn('Oxiquill could not refresh the generated interactive cell manifest.', error);
  }
}

type ManifestScheduleOptions = {
  refresh?: () => Promise<void>;
  windowObject?: Pick<Window, 'setTimeout'>;
};

export function scheduleGeneratedManifestRefresh({
  refresh = refreshGeneratedManifest,
  windowObject = globalThis.window
}: ManifestScheduleOptions = {}): void {
  if (!windowObject) return;

  for (const delay of [0, 250, 1_000, 2_500, 5_000]) {
    windowObject.setTimeout(() => {
      void refresh();
    }, delay);
  }
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
