/// <reference types="astro/client" />
/// <reference types="@astrojs/starlight/locals" />

declare module 'virtual:oxiquill/cells' {
  import type { CellManifest } from './lib/doc-runtime/types';

  export const cells: readonly CellManifest[];
}

declare module 'virtual:oxiquill/runtime-version' {
  export const runtimeVersion: string;
}

declare module 'virtual:oxiquill/rust-wasm' {
  export default function init(): Promise<void>;
  export function run_rust_cell(cellId: string, inputsJson: string): string;
}
