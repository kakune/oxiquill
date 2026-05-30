import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { defineConfig } from 'astro/config';
import preact from '@astrojs/preact';
import starlight from '@astrojs/starlight';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { mergeAlias } from 'vite';
import type {
  AstroIntegration,
  AstroUserConfig,
  FontProvider,
  Locales,
  SessionDriverConfig
} from 'astro';
import type { Options as PreactIntegrationOptions } from '@astrojs/preact';
import type { StarlightUserConfig } from '@astrojs/starlight/types';
import type { Alias, Plugin, PluginOption, UserConfig as ViteUserConfig } from 'vite';
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

const frameworkPackageNames = ['astro', '@astrojs/preact', '@astrojs/starlight'];
const viteManagedPackageNames = [
  ...frameworkPackageNames,
  '@preact/signals',
  'aria-query',
  'axobject-query',
  'echarts',
  'html-escaper',
  'katex',
  'mermaid',
  'preact',
  'preact-render-to-string',
  'pyodide'
];
const viteAliasedPackageNames = [
  'astro',
  '@astrojs/preact',
  '@preact/signals',
  'preact',
  'aria-query',
  'axobject-query',
  'html-escaper'
];
const viteSsrNoExternalPackageNames = [
  '@astrojs/preact',
  'preact',
  'preact-render-to-string'
];
const viteResolveDedupePackageNames = [
  '@preact/signals',
  'preact'
];

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
  const server = vite.server ?? {};
  const serverFs = server.fs ?? {};
  const ssr = vite.ssr ?? {};
  const resolve = vite.resolve ?? {};
  const alias = mergeAlias(oxiquillDependencyAliases(paths), resolve.alias);

  return {
    ...vite,
    resolve: {
      ...resolve,
      ...(alias ? { alias } : {}),
      dedupe: mergeStringList(resolve.dedupe, viteResolveDedupePackageNames)
    },
    ssr: {
      ...ssr,
      noExternal: mergeSsrNoExternal(ssr.noExternal, viteSsrNoExternalPackageNames)
    },
    server: {
      ...server,
      fs: {
        ...serverFs,
        allow: mergeServerFsAllow(serverFs.allow, oxiquillServeAllow(paths))
      }
    },
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

function oxiquillDependencyResolverPlugin(paths: OxiquillPaths): Plugin {
  const contextPaths = dependencyResolutionContextPaths(paths);

  return {
    enforce: 'pre',
    name: 'oxiquill-dependency-resolver',
    async resolveId(source, _importer, options) {
      if (!isPackageManagedDependency(source)) {
        return undefined;
      }

      for (const contextPath of contextPaths) {
        const resolved = await this.resolve(source, contextPath, { ...options, skipSelf: true });
        if (resolved) return resolved;
      }

      return undefined;
    }
  };
}

function oxiquillServeAllow(paths: OxiquillPaths): string[] {
  const requires = dependencyRequireContexts(paths);
  const allowPaths = [
    pathFromUrl(paths.workspaceRoot),
    pathFromUrl(paths.frameworkRoot),
    pathInUrl(paths.frameworkRoot, 'node_modules')
  ];

  for (const packageName of viteManagedPackageNames) {
    const packageRoot = resolvePackageRoot(requires, packageName);
    if (!packageRoot) continue;

    allowPaths.push(packageRoot);
    allowPaths.push(...nodeModulesAncestors(packageRoot));
  }

  return existingRealPaths(allowPaths);
}

function oxiquillDependencyAliases(paths: OxiquillPaths): Alias[] {
  const requires = dependencyRequireContexts(paths);
  const aliases: Alias[] = [];

  for (const packageName of viteAliasedPackageNames) {
    aliases.push(...resolvePackageExportAliases(requires, packageName));
  }

  return aliases;
}

function dependencyResolutionContextPaths(paths: OxiquillPaths): string[] {
  const frameworkPackageJsonPath = pathInUrl(paths.frameworkRoot, 'package.json');
  const frameworkRequire = createRequire(frameworkPackageJsonPath);
  const contextPaths = [frameworkPackageJsonPath];

  for (const packageName of frameworkPackageNames) {
    const contextPath = resolvePackageContextPath(frameworkRequire, packageName);
    if (contextPath) contextPaths.push(contextPath);
  }

  return existingRealPaths(contextPaths);
}

function dependencyRequireContexts(paths: OxiquillPaths): NodeRequire[] {
  return dependencyResolutionContextPaths(paths).map((contextPath) => createRequire(contextPath));
}

function resolvePackageRoot(requires: NodeRequire[], packageName: string): string | undefined {
  for (const require of requires) {
    const packageRoot = resolveSpecifierPackageRoot(require, packageName);
    if (packageRoot) return packageRoot;
  }

  return undefined;
}

function resolvePackageSpecifier(requires: NodeRequire[], specifier: string): string | undefined {
  for (const require of requires) {
    const packageRoot = resolveSpecifierPackageRoot(require, specifier);
    const exported = packageRoot ? resolvePackageExport(packageRoot, specifier) : undefined;
    if (exported) return exported;

    try {
      return require.resolve(specifier);
    } catch {}
  }

  return undefined;
}

function resolvePackageExportAliases(requires: NodeRequire[], packageName: string): Alias[] {
  const packageRoot = resolvePackageRoot(requires, packageName);
  if (!packageRoot) return [];

  const packageJson = readPackageJson(path.join(packageRoot, 'package.json'));
  if (!packageJson) return [];

  const exportKeys = packageExportKeys(packageJson.exports);
  if (exportKeys.length === 0) {
    const entryPoint = packageEntryPoint(packageRoot, packageJson);
    return entryPoint ? [{ find: exactSpecifierPattern(packageName), replacement: entryPoint }] : [];
  }

  const aliases: Alias[] = [];
  for (const exportKey of exportKeys) {
    const target = selectPackageExport(packageJson.exports, exportKey);
    if (!target) continue;

    aliases.push({
      find: exportKeyPattern(packageName, exportKey),
      replacement: exportTargetReplacement(packageRoot, target)
    });
  }

  return aliases;
}

function packageExportKeys(exports: unknown): string[] {
  if (exports == null) return [];
  if (!isRecord(exports)) return ['.'];

  const keys = Object.keys(exports).filter((key) => key.startsWith('.'));
  return keys.length > 0 ? keys : ['.'];
}

function exportKeyPattern(packageName: string, exportKey: string): string | RegExp {
  const specifier = exportKey === '.' ? packageName : `${packageName}${exportKey.slice(1)}`;
  if (!specifier.includes('*')) return exactSpecifierPattern(specifier);

  const [prefix, suffix] = specifier.split('*');
  return new RegExp(`^${escapeRegExp(prefix)}(.+)${escapeRegExp(suffix)}$`);
}

function exportTargetReplacement(packageRoot: string, target: string): string {
  return path.join(packageRoot, target).replace('*', '$1');
}

function exactSpecifierPattern(id: string): RegExp {
  return new RegExp(`^${escapeRegExp(id)}$`);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolveSpecifierPackageRoot(require: NodeRequire, specifier: string): string | undefined {
  const packageName = packageNameFromSpecifier(specifier);
  const packageJsonPath = resolvePackageJson(require, packageName);
  if (packageJsonPath) return path.dirname(packageJsonPath);

  const packageEntry = resolvePackageEntry(require, packageName);
  return packageEntry ? findPackageRoot(packageEntry, packageName) : undefined;
}

function resolvePackageExport(packageRoot: string, specifier: string): string | undefined {
  const packageJson = readPackageJson(path.join(packageRoot, 'package.json'));
  if (!packageJson || typeof packageJson.name !== 'string') return undefined;

  const subpath = specifier.slice(packageJson.name.length).replace(/^\//, '');
  const exportKey = subpath ? `./${subpath}` : '.';
  const exportTarget = selectPackageExport(packageJson.exports, exportKey);
  if (exportTarget) return path.join(packageRoot, exportTarget);

  if (!subpath) return packageEntryPoint(packageRoot, packageJson);
  return undefined;
}

function readPackageJson(packageJsonPath: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(readFileSync(packageJsonPath, 'utf8'));
  } catch {
    return undefined;
  }
}

function selectPackageExport(exports: unknown, exportKey: string): string | undefined {
  if (typeof exports === 'string') return exportKey === '.' ? exports : undefined;
  if (Array.isArray(exports)) return selectPackageExport(exports[0], exportKey);
  if (!isRecord(exports)) return undefined;
  if (exportKey === '.' && !Object.keys(exports).some((key) => key.startsWith('.'))) {
    return selectConditionalExport(exports);
  }

  const exact = selectConditionalExport(exports[exportKey]);
  if (exact) return exact;

  for (const [key, value] of Object.entries(exports)) {
    if (!key.includes('*')) continue;

    const [prefix, suffix] = key.split('*');
    if (!exportKey.startsWith(prefix) || !exportKey.endsWith(suffix)) continue;

    const matched = exportKey.slice(prefix.length, exportKey.length - suffix.length);
    const target = selectConditionalExport(value);
    if (target) return target.replace('*', matched);
  }

  return undefined;
}

function selectConditionalExport(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return selectConditionalExport(value[0]);
  if (!isRecord(value)) return undefined;

  for (const condition of ['import', 'browser', 'module', 'default']) {
    const selected = selectConditionalExport(value[condition]);
    if (selected) return selected;
  }

  return undefined;
}

function packageEntryPoint(packageRoot: string, packageJson: Record<string, unknown>): string | undefined {
  for (const field of ['module', 'main']) {
    const entry = packageJson[field];
    if (typeof entry === 'string') return path.join(packageRoot, entry);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function packageNameFromSpecifier(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

function findPackageRoot(filePath: string, packageName: string): string | undefined {
  let current = path.dirname(filePath);

  while (current !== path.dirname(current)) {
    const packageJsonPath = path.join(current, 'package.json');
    const packageJson = readPackageJson(packageJsonPath);
    if (packageJson?.name === packageName) return current;
    current = path.dirname(current);
  }

  return undefined;
}

function resolvePackageContextPath(require: NodeRequire, packageName: string): string | undefined {
  return resolvePackageJson(require, packageName) ?? resolvePackageEntry(require, packageName);
}

function resolvePackageEntry(require: NodeRequire, packageName: string): string | undefined {
  try {
    return require.resolve(packageName);
  } catch {
    return undefined;
  }
}

function resolvePackageJson(require: NodeRequire, packageName: string): string | undefined {
  try {
    return require.resolve(`${packageName}/package.json`);
  } catch {
    return undefined;
  }
}

function isPackageManagedDependency(source: string): boolean {
  return viteManagedPackageNames.some((packageName) => source === packageName || source.startsWith(`${packageName}/`));
}

function nodeModulesAncestors(filePath: string): string[] {
  const ancestors: string[] = [];
  let current = path.dirname(filePath);

  while (current !== path.dirname(current)) {
    if (path.basename(current) === 'node_modules') ancestors.push(current);
    current = path.dirname(current);
  }

  return ancestors;
}

function existingRealPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const realPaths: string[] = [];

  for (const candidate of paths) {
    if (!existsSync(candidate)) continue;

    const realPath = realpathSync(candidate);
    if (seen.has(realPath)) continue;

    seen.add(realPath);
    realPaths.push(realPath);
  }

  return realPaths;
}

function mergeServerFsAllow(allow: string[] | undefined, additions: string[]): string[] {
  return [...new Set([...(allow ?? []), ...additions])];
}

type SsrNoExternal = NonNullable<NonNullable<ViteUserConfig['ssr']>['noExternal']>;
type SsrNoExternalEntry = string | RegExp;

function mergeSsrNoExternal(
  noExternal: SsrNoExternal | undefined,
  additions: SsrNoExternalEntry[]
): SsrNoExternal {
  if (noExternal === true) return true;

  return uniqueSsrNoExternalEntries([
    ...ssrNoExternalEntries(noExternal),
    ...additions
  ]);
}

function ssrNoExternalEntries(noExternal: SsrNoExternal | undefined): SsrNoExternalEntry[] {
  if (noExternal == null || noExternal === true) return [];
  return Array.isArray(noExternal) ? noExternal : [noExternal];
}

function uniqueSsrNoExternalEntries(entries: SsrNoExternalEntry[]): SsrNoExternalEntry[] {
  const seen = new Set<string>();
  const unique: SsrNoExternalEntry[] = [];

  for (const entry of entries) {
    const key = typeof entry === 'string' ? `string:${entry}` : `regexp:${entry.toString()}`;
    if (seen.has(key)) continue;

    seen.add(key);
    unique.push(entry);
  }

  return unique;
}

function mergeStringList(value: string[] | undefined, additions: string[]): string[] {
  return [...new Set([...(value ?? []), ...additions])];
}

function resolveWorkerPlugins(plugins: ViteWorkerPlugins | undefined): PluginOption[] {
  if (!plugins) return [];

  const resolved = typeof plugins === 'function' ? plugins() : plugins;
  return Array.isArray(resolved) ? resolved : [resolved];
}
