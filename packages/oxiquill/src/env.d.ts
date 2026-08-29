/// <reference types="astro/client" />
/// <reference types="@astrojs/starlight/locals" />

declare module 'virtual:starlight/user-config' {
  const config: import('@astrojs/starlight/types').StarlightConfig;
  export default config;
}

declare module 'virtual:starlight/plugin-translations' {
  const translations: Record<string, Record<string, string>>;
  export default translations;
}

declare module 'virtual:starlight/project-context' {
  const project: {
    root: string;
    srcDir: string;
    trailingSlash: import('astro').AstroConfig['trailingSlash'];
    build: {
      format: import('astro').AstroConfig['build']['format'];
    };
  };
  export default project;
}

declare module 'virtual:oxiquill/cells' {
  import type { CellManifest } from './lib/doc-runtime/types.js';

  export const cells: readonly CellManifest[];
}

declare module 'virtual:oxiquill/cell?*' {
  import type { CellManifest } from './lib/doc-runtime/types';

  export const cell: CellManifest;
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
