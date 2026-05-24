import { createRequire } from 'node:module';
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import type {
  AstroIntegration,
  AstroUserConfig,
  FontProvider,
  Locales,
  SessionDriverConfig
} from 'astro';
import type { Options as PreactIntegrationOptions } from '@astrojs/preact';
import type { StarlightUserConfig } from '@astrojs/starlight/types';
import type { PluginOption, UserConfig as ViteUserConfig } from 'vite';
import { pathFromUrl, pathInUrl } from '../config/paths.mjs';
import { createDocRuntimeContext, markRuntimeReady, syncDocRuntime } from '../generator/doc-runtime-service.mjs';
import { buildRustWasm } from '../generator/doc-runtime/wasm-build.mjs';
import remarkInteractiveCells from '../lib/doc-runtime/remark-interactive-cells.mjs';
import remarkMermaidDiagrams from '../lib/doc-runtime/remark-mermaid-diagrams.mjs';
import remarkPublicAssetBase from '../lib/doc-runtime/remark-public-asset-base.mjs';
import { createOxiquillPaths } from '../config/paths.mjs';
import { oxiquillVirtualModulesPlugin } from './virtual-modules.mjs';

type IntegrationFactory<Options> = (options: Options) => AstroIntegration;
type PreactIntegrationFactory = IntegrationFactory<PreactIntegrationOptions | undefined>;
type StarlightIntegrationFactory = IntegrationFactory<StarlightUserConfig>;
type BaseAstroUserConfig = AstroUserConfig<Locales, SessionDriverConfig | undefined, FontProvider[]>;
type OxiquillPaths = ReturnType<typeof createOxiquillPaths>;
type OxiquillPathOptionName =
  | 'cacheDir'
  | 'cratesDir'
  | 'docsDir'
  | 'frameworkRoot'
  | 'generatedDir'
  | 'publicAssetsDir'
  | 'publicDir'
  | 'pyodidePublicDir'
  | 'rustCellsDir'
  | 'rustWasmPublicDir'
  | 'workspaceRoot';
export type OxiquillPathOptions = Partial<Record<OxiquillPathOptionName, string | URL>>;
type AstroIntegrations = NonNullable<BaseAstroUserConfig['integrations']>;
type AstroMarkdownConfig = NonNullable<BaseAstroUserConfig['markdown']>;
type SyntaxHighlightObject = Extract<AstroMarkdownConfig['syntaxHighlight'], object>;
type ViteWorkerPlugins = PluginOption[] | (() => PluginOption[]);
type DocRuntimeContext = Awaited<ReturnType<typeof createDocRuntimeContext>>;

export interface OxiquillFrameworkOptions {
  preact?: PreactIntegrationFactory;
  starlight?: StarlightIntegrationFactory;
}

export interface OxiquillConfig extends Omit<BaseAstroUserConfig, 'integrations' | 'markdown' | 'vite'> {
  description?: StarlightUserConfig['description'];
  framework?: OxiquillFrameworkOptions;
  integrations?: AstroIntegrations;
  markdown?: AstroMarkdownConfig;
  paths?: OxiquillPathOptions;
  sidebar?: StarlightUserConfig['sidebar'];
  starlight?: Partial<StarlightUserConfig>;
  title?: StarlightUserConfig['title'];
  vite?: ViteUserConfig;
}

export interface OxiquillIntegrationOptions {
  base?: BaseAstroUserConfig['base'];
  markdown?: AstroMarkdownConfig;
  paths?: OxiquillPathOptions;
  vite?: ViteUserConfig;
}

const createDocRuntimeContextForPaths = createDocRuntimeContext as unknown as (
  options: { paths: OxiquillPaths }
) => Promise<DocRuntimeContext>;

export function defineOxiquillConfig(options: OxiquillConfig = {}): BaseAstroUserConfig {
  const {
    base,
    framework = {},
    integrations = [],
    markdown = {},
    paths,
    description,
    sidebar,
    starlight: starlightOptions = {},
    title,
    vite = {},
    ...astroOptions
  } = options;
  const preactIntegration = resolveIntegrationFactory<PreactIntegrationOptions | undefined>(
    framework.preact,
    preact,
    'framework.preact'
  );
  const starlightIntegration = resolveIntegrationFactory<StarlightUserConfig>(
    framework.starlight,
    starlight,
    'framework.starlight'
  );
  const mergedStarlightOptions = {
    ...(description == null ? {} : { description }),
    ...(sidebar == null ? {} : { sidebar }),
    ...(title == null ? {} : { title }),
    ...starlightOptions
  };

  const config: BaseAstroUserConfig = {
    output: 'static',
    srcDir: '.',
    ...astroOptions,
    ...(base ? { base } : {}),
    integrations: [
      oxiquillIntegration({ base, markdown, paths, vite }),
      preactIntegration(undefined),
      starlightIntegration(createStarlightOptions(mergedStarlightOptions)),
      ...integrations
    ]
  };

  return defineConfig(config) as BaseAstroUserConfig;
}

function resolveIntegrationFactory<Options>(
  factory: IntegrationFactory<Options> | undefined,
  fallback: IntegrationFactory<Options>,
  optionName: string
): IntegrationFactory<Options> {
  if (factory == null) return fallback;
  if (typeof factory === 'function') return factory;

  throw new TypeError(`defineOxiquillConfig expected ${optionName} to be an Astro integration factory.`);
}

export function oxiquillIntegration({
  base,
  markdown = {},
  paths: pathOptions,
  vite = {}
}: OxiquillIntegrationOptions = {}): AstroIntegration {
  let paths: OxiquillPaths | undefined;

  return {
    name: 'oxiquill',
    hooks: {
      'astro:config:setup': ({ addWatchFile, config, updateConfig }) => {
        paths = createOxiquillPaths({ workspaceRoot: config.root, ...pathOptions });
        addWatchFile(paths.docsDir);
        addWatchFile(paths.cratesDir);

        const update = {
          markdown: mergeMarkdownConfig(base, paths, markdown),
          vite: mergeViteConfig(paths, vite)
        } as unknown as Parameters<typeof updateConfig>[0];

        updateConfig(update);
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

        const context = await createDocRuntimeContextForPaths({ paths });
        const summary = await syncDocRuntime(context);
        await buildRustWasm({ mode: 'build', paths });
        await markRuntimeReady({ paths, summary });
      }
    }
  };
}

function createStarlightOptions(options: Partial<StarlightUserConfig>): StarlightUserConfig {
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

function mergeMarkdownConfig(
  base: BaseAstroUserConfig['base'],
  paths: OxiquillPaths,
  markdown: AstroMarkdownConfig
) {
  const {
    rehypePlugins = [],
    remarkPlugins = [],
    syntaxHighlight,
    ...markdownRest
  } = markdown;
  const syntaxHighlightOptions = syntaxHighlightConfig(syntaxHighlight);

  return {
    ...markdownRest,
    syntaxHighlight: {
      ...syntaxHighlightOptions,
      type: syntaxHighlightOptions.type ?? 'shiki',
      excludeLangs: syntaxHighlightOptions.excludeLangs ?? ['math', 'mermaid']
    },
    remarkPlugins: [
      remarkMath,
      [remarkPublicAssetBase, { base }],
      [remarkInteractiveCells, { root: pathFromUrl(paths.workspaceRoot) }],
      remarkMermaidDiagrams,
      ...remarkPlugins
    ],
    rehypePlugins: [
      rehypeKatex,
      ...rehypePlugins
    ]
  };
}

function syntaxHighlightConfig(value: AstroMarkdownConfig['syntaxHighlight']): Partial<SyntaxHighlightObject> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function mergeViteConfig(paths: OxiquillPaths, vite: ViteUserConfig): ViteUserConfig {
  const worker = vite.worker ?? {};

  return {
    ...vite,
    worker: {
      format: 'es',
      ...worker,
      plugins: () => [
        oxiquillDependencyResolverPlugin(paths),
        oxiquillVirtualModulesPlugin(paths),
        ...resolveWorkerPlugins(worker.plugins as ViteWorkerPlugins | undefined)
      ]
    },
    build: {
      chunkSizeWarningLimit: 650,
      ...vite.build
    },
    plugins: [
      oxiquillDependencyResolverPlugin(paths),
      oxiquillVirtualModulesPlugin(paths),
      ...(vite.plugins ?? [])
    ]
  };
}

function oxiquillDependencyResolverPlugin(paths: OxiquillPaths): PluginOption {
  const require = createRequire(pathInUrl(paths.frameworkRoot, 'package.json'));
  const packageNames = ['astro', '@astrojs/preact', '@astrojs/starlight'];

  return {
    enforce: 'pre',
    name: 'oxiquill-dependency-resolver',
    resolveId(source: string) {
      if (!packageNames.some((packageName) => source === packageName || source.startsWith(`${packageName}/`))) {
        return undefined;
      }

      try {
        return require.resolve(source);
      } catch {
        return undefined;
      }
    }
  };
}

function resolveWorkerPlugins(plugins: ViteWorkerPlugins | undefined): PluginOption[] {
  if (!plugins) return [];

  const resolved = typeof plugins === 'function' ? plugins() : plugins;
  return Array.isArray(resolved) ? resolved : [resolved];
}
