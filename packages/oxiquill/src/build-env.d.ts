declare module 'virtual:oxiquill/cells' {
  import type { CellManifest } from './lib/doc-runtime/types.js';

  export const cells: readonly CellManifest[];
}

declare module 'virtual:oxiquill/runtime-version' {
  export const runtimeVersion: string;
}

declare module 'virtual:oxiquill/runtime-paths' {
  export const haskellWasmPath: string;
  export const pyodidePath: string;
}

declare module 'virtual:oxiquill/rust-wasm' {
  export default function init(): Promise<void>;
  export function run_rust_cell(cellId: string, inputsJson: string): string;
}
