import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { pathFromUrl } from '../config/paths.mjs';
import { createDocRuntimeContext, markRuntimeReady, syncDocRuntime } from '../generator/doc-runtime-service.mjs';
import { buildRustWasm } from '../generator/doc-runtime/wasm-build.mjs';
import remarkInteractiveCells from '../lib/doc-runtime/remark-interactive-cells.mjs';
import remarkMermaidDiagrams from '../lib/doc-runtime/remark-mermaid-diagrams.mjs';
import remarkPublicAssetBase from '../lib/doc-runtime/remark-public-asset-base.mjs';
import { createOxiquillPaths } from '../config/paths.mjs';
import { oxiquillVirtualModulesPlugin } from './virtual-modules.mjs';

export function defineOxiquillConfig(options = {}) {
  const {
    base,
    framework = {},
    integrations = [],
    markdown = {},
    paths,
    starlight: starlightOptions = {},
    vite = {},
    ...astroOptions
  } = options;
  const preactIntegration = resolveIntegrationFactory(framework.preact, preact, 'framework.preact');
  const starlightIntegration = resolveIntegrationFactory(framework.starlight, starlight, 'framework.starlight');

  return defineConfig({
    output: 'static',
    srcDir: '.',
    ...astroOptions,
    ...(base ? { base } : {}),
    integrations: [
      oxiquillIntegration({ base, markdown, paths, vite }),
      preactIntegration(),
      starlightIntegration(createStarlightOptions(starlightOptions)),
      ...integrations
    ]
  });
}

function resolveIntegrationFactory(factory, fallback, optionName) {
  if (factory == null) return fallback;
  if (typeof factory === 'function') return factory;

  throw new TypeError(`defineOxiquillConfig expected ${optionName} to be an Astro integration factory.`);
}

export function oxiquillIntegration({ base, markdown = {}, paths: pathOptions, vite = {} } = {}) {
  let paths;

  return {
    name: 'oxiquill',
    hooks: {
      'astro:config:setup': ({ addWatchFile, config, updateConfig }) => {
        paths = createOxiquillPaths({ workspaceRoot: config.root, ...pathOptions });
        addWatchFile(paths.docsDir);
        addWatchFile(paths.cratesDir);

        updateConfig({
          markdown: mergeMarkdownConfig(base, paths, markdown),
          vite: mergeViteConfig(paths, vite)
        });
      },
      'astro:config:done': ({ injectTypes }) => {
        injectTypes({
          filename: 'virtual-modules.d.ts',
          content: [
            'declare module "virtual:oxiquill/cells" {',
            '  import type { CellManifest } from "oxiquill/runtime/types";',
            '  export const cells: readonly CellManifest[];',
            '}',
            'declare module "virtual:oxiquill/runtime-version" {',
            '  export const runtimeVersion: string;',
            '}',
            'declare module "virtual:oxiquill/rust-wasm" {',
            '  export default function init(): Promise<void>;',
            '  export function run_rust_cell(cellId: string, inputsJson: string): string;',
            '}'
          ].join('\n')
        });
      },
      'astro:build:start': async () => {
        if (!paths) return;

        const context = await createDocRuntimeContext({ paths });
        const summary = await syncDocRuntime(context);
        await buildRustWasm({ mode: 'build', paths });
        await markRuntimeReady({ paths, summary });
      }
    }
  };
}

function createStarlightOptions(options) {
  const {
    components = {},
    customCss = [],
    description = 'A static documentation workspace for Rust, Python, math, diagrams, and media-rich MDX notes.',
    title = 'Oxiquill',
    ...rest
  } = options;

  return {
    title,
    description,
    ...rest,
    customCss: [
      'oxiquill/styles/katex.css',
      'oxiquill/styles/custom.css',
      ...customCss
    ],
    components: {
      PageFrame: 'oxiquill/components/starlight/PageFrame',
      ...components
    }
  };
}

function mergeMarkdownConfig(base, paths, markdown) {
  return {
    ...markdown,
    syntaxHighlight: {
      type: 'shiki',
      excludeLangs: ['math', 'mermaid'],
      ...markdown.syntaxHighlight
    },
    remarkPlugins: [
      remarkMath,
      [remarkPublicAssetBase, { base }],
      [remarkInteractiveCells, { root: pathFromUrl(paths.workspaceRoot) }],
      [remarkMermaidDiagrams],
      ...(markdown.remarkPlugins ?? [])
    ],
    rehypePlugins: [
      rehypeKatex,
      ...(markdown.rehypePlugins ?? [])
    ]
  };
}

function mergeViteConfig(paths, vite) {
  const worker = vite.worker ?? {};

  return {
    ...vite,
    worker: {
      format: 'es',
      ...worker,
      plugins: () => [
        oxiquillVirtualModulesPlugin(paths),
        ...resolveWorkerPlugins(worker.plugins)
      ]
    },
    build: {
      chunkSizeWarningLimit: 650,
      ...vite.build
    },
    plugins: [
      oxiquillVirtualModulesPlugin(paths),
      ...(vite.plugins ?? [])
    ]
  };
}

function resolveWorkerPlugins(plugins) {
  if (!plugins) return [];

  const resolved = typeof plugins === 'function' ? plugins() : plugins;
  return Array.isArray(resolved) ? resolved : [resolved];
}
