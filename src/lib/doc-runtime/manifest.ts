import { cells as generatedCells } from '../../generated/doc-runtime/cells';
import { runtimeVersion as generatedRuntimeVersion } from '../../generated/doc-runtime/runtime-version';
import { resetInteractiveRuntime } from './runtime-client';
import type { CellManifest } from './types';

type GeneratedCellsModule = {
  cells: readonly CellManifest[];
};

type RuntimeVersionModule = {
  runtimeVersion: string;
};

type ManifestSnapshot = {
  cells: readonly CellManifest[];
  version: string;
};

let cellsSnapshot = generatedCells as readonly CellManifest[];
let versionSnapshot = generatedRuntimeVersion;
const listeners = new Set<() => void>();

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

if (import.meta.hot) {
  import.meta.hot.accept('../../generated/doc-runtime/cells', (module) => {
    if (module) {
      cellsSnapshot = (module as unknown as GeneratedCellsModule).cells;
    }
  });

  import.meta.hot.accept('../../generated/doc-runtime/runtime-version', (module) => {
    if (module) {
      versionSnapshot = (module as unknown as RuntimeVersionModule).runtimeVersion;
      resetInteractiveRuntime('rust');
      notifyManifestListeners();
    }
  });
}

function notifyManifestListeners(): void {
  for (const listener of listeners) {
    listener();
  }
}
