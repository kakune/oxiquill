import { vi } from 'vitest';
import type { CellManifest } from '../../../packages/oxiquill/src/lib/doc-runtime/types';

export const cells: readonly CellManifest[] = [];
export const runtimeVersion = 'test-runtime-version';
export const initializeRustWasm = vi.fn(async () => undefined);
export const run_rust_cell = vi.fn(() => JSON.stringify({ stdout: '', plots: [], outputs: [] }));

export default initializeRustWasm;
