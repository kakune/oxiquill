/// <reference types="astro/client" />
/// <reference types="@astrojs/starlight/locals" />

declare module 'virtual:oxiquill/cells' {
  import type { CellManifest } from './lib/doc-runtime/types';

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

declare module 'astro:content' {
  export interface RenderResult {
    Content: import('astro/runtime/server/index.js').AstroComponentFactory;
    headings: import('astro').MarkdownHeading[];
    remarkPluginFrontmatter: Record<string, unknown>;
  }
}
