import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { defineConfig } from 'astro/config';
import { unified } from '@astrojs/markdown-remark';
import preact from '@astrojs/preact';
import rehypeKatex from 'rehype-katex';
import remarkMath from 'remark-math';
import { mergeAlias } from 'vite';
import type {
  AstroConfig,
  AstroIntegration,
  AstroUserConfig,
  FontProvider,
  Locales,
  SessionDriverConfig
} from 'astro';
import type { Options as PreactIntegrationOptions } from '@astrojs/preact';
import type { Alias, Plugin, PluginOption, UserConfig as ViteUserConfig } from 'vite';
import { directoryPath, pathFromUrl, pathInUrl, relativePathFromUrl } from '../config/paths.mjs';
import {
  attachOxiquillMetadata,
  createOxiquillConfigMetadata,
  createOxiquillIntegrationMetadata
} from '../config/metadata.mjs';
import { resolveOxiquillProjectConfig } from '../config/project-config.mjs';
import {
  collectBundleModuleIds,
  createBundledModuleCollector,
  createDocRuntimeContext,
  markRuntimeReady,
  syncDocRuntime,
  syncLicenseArtifacts
} from '../generator/doc-runtime-service.mjs';
import { createBrowserBundleCollector, syncBrowserBundleReport } from '../generator/browser-bundle-report.mjs';
import { buildHaskellWasm, buildRustWasm } from '../generator/doc-runtime/wasm-build.mjs';
import remarkInteractiveCells from '../lib/doc-runtime/remark-interactive-cells.mjs';
import remarkMermaidDiagrams from '../lib/doc-runtime/remark-mermaid-diagrams.mjs';
import remarkPublicAssetBase from '../lib/doc-runtime/remark-public-asset-base.mjs';
import { createOxiquillPaths } from '../config/paths.mjs';
import { oxiquillVirtualModulesPlugin } from './virtual-modules.mjs';

type IntegrationFactory<Options> = (options: Options) => AstroIntegration;
type PreactIntegrationFactory = IntegrationFactory<PreactIntegrationOptions | undefined>;
type BaseAstroUserConfig = AstroUserConfig<Locales, SessionDriverConfig | undefined, FontProvider[]>;
type OxiquillPaths = ReturnType<typeof createOxiquillPaths>;
type OxiquillPathOptionName =
  | 'cacheDir'
  | 'cratesDir'
  | 'docsDir'
  | 'frameworkRoot'
  | 'generatedDir'
  | 'haskellCellsDir'
  | 'haskellWasmPublicDir'
  | 'licensesPublicDir'
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
type BundledModuleCollector = ReturnType<typeof createBundledModuleCollector>;
type BrowserBundleCollector = ReturnType<typeof createBrowserBundleCollector>;
type StarlightOption<Options, Name extends PropertyKey, Fallback> =
  Options extends Partial<Record<Name, infer Value>> ? Value : Fallback;

const frameworkPackageNames = ['astro', '@astrojs/markdown-remark', '@astrojs/preact', '@astrojs/starlight'];
const viteManagedPackageNames = [
  ...frameworkPackageNames,
  '@preact/signals',
  'aria-query',
  'axobject-query',
  '@bjorn3/browser_wasi_shim',
  'echarts',
  'html-escaper',
  'katex',
  'mermaid',
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
const viteSsrNoExternalPackageNames = ['@astrojs/preact', 'oxiquill'];
const viteResolveDedupePackageNames = ['@preact/signals', 'preact'];

export interface OxiquillFrameworkOptions<StarlightOptions extends object = object> {
  preact?: PreactIntegrationFactory;
  starlight: IntegrationFactory<StarlightOptions>;
}

interface OxiquillStarlightOptions {
  components?: Record<string, string>;
  customCss?: string[];
  description?: string;
  sidebar?: unknown;
  title?: string;
  [option: string]: unknown;
}

export interface OxiquillConfig<StarlightOptions extends object = object> extends Omit<
  BaseAstroUserConfig,
  'integrations' | 'markdown' | 'vite'
> {
  description?: StarlightOption<StarlightOptions, 'description', string>;
  framework: OxiquillFrameworkOptions<StarlightOptions>;
  integrations?: AstroIntegrations;
  markdown?: AstroMarkdownConfig;
  paths?: OxiquillPathOptions;
  sidebar?: StarlightOption<StarlightOptions, 'sidebar', unknown>;
  starlight?: Partial<StarlightOptions>;
  title?: StarlightOption<StarlightOptions, 'title', string>;
  vite?: ViteUserConfig;
}

export interface OxiquillIntegrationOptions {
  base?: BaseAstroUserConfig['base'];
  markdown?: AstroMarkdownConfig;
  paths?: OxiquillPathOptions;
  vite?: ViteUserConfig;
}

const createDocRuntimeContextForPaths = createDocRuntimeContext as unknown as (options: {
  paths: OxiquillPaths;
}) => Promise<DocRuntimeContext>;

export function defineOxiquillConfig<StarlightOptions extends object>(
  options: OxiquillConfig<StarlightOptions>
): BaseAstroUserConfig {
  const explicitAstroPaths = selectedAstroDirectoryOptions(options);
  const {
    base,
    framework,
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
    framework?.preact,
    preact,
    'framework.preact'
  );
  const starlightIntegration = requiredIntegrationFactory(framework?.starlight, 'framework.starlight');
  const mergedStarlightOptions = {
    ...(description == null ? {} : { description }),
    ...(sidebar == null ? {} : { sidebar }),
    ...(title == null ? {} : { title }),
    ...starlightOptions
  } as OxiquillStarlightOptions;

  const integration = createOxiquillIntegration(
    { base, markdown, paths, vite },
    explicitAstroPaths
  );
  const effectiveRoot = explicitAstroPaths.root ?? paths?.workspaceRoot;
  const effectivePublicDir = explicitAstroPaths.publicDir ?? paths?.publicDir ?? 'public';
  const effectiveCacheDir = explicitAstroPaths.cacheDir ?? paths?.cacheDir ?? '.oxiquill';
  const effectiveOutDir = explicitAstroPaths.outDir ?? 'dist';
  const config: BaseAstroUserConfig = {
    compressHTML: true,
    output: 'static',
    srcDir: '.',
    ...astroOptions,
    ...(effectiveRoot === undefined ? {} : { root: astroDirectoryValue(effectiveRoot) }),
    publicDir: astroDirectoryValue(effectivePublicDir),
    cacheDir: astroDirectoryValue(effectiveCacheDir),
    outDir: astroDirectoryValue(effectiveOutDir),
    ...(base ? { base } : {}),
    integrations: [
      integration,
      preactIntegration(undefined),
      callStarlightIntegration(starlightIntegration, createStarlightOptions(mergedStarlightOptions)),
      ...integrations
    ]
  };

  const definedConfig = defineConfig(config) as BaseAstroUserConfig;
  return attachOxiquillMetadata(
    definedConfig,
    createOxiquillConfigMetadata({ astro: explicitAstroPaths })
  ) as BaseAstroUserConfig;
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

function requiredIntegrationFactory<Options>(
  factory: IntegrationFactory<Options> | undefined,
  optionName: string
): IntegrationFactory<Options> {
  if (typeof factory === 'function') return factory;

  throw new TypeError(`defineOxiquillConfig requires ${optionName} to be an Astro integration factory.`);
}

export function oxiquillIntegration({
  base,
  markdown = {},
  paths: pathOptions,
  vite = {}
}: OxiquillIntegrationOptions = {}): AstroIntegration {
  return createOxiquillIntegration({ base, markdown, paths: pathOptions, vite });
}

function createOxiquillIntegration(
  {
    base,
    markdown = {},
    paths: pathOptions,
    vite = {}
  }: OxiquillIntegrationOptions = {},
  astroOptions: Record<string, string | URL> = {}
): AstroIntegration {
  const metadata = createOxiquillIntegrationMetadata({ astro: astroOptions, paths: pathOptions });
  let paths: OxiquillPaths | undefined;
  const bundledModules = createBundledModuleCollector();
  const browserBundle = createBrowserBundleCollector();

  const integration: AstroIntegration = {
    name: 'oxiquill',
    hooks: {
      'astro:config:setup': ({ addWatchFile, config, updateConfig }) => {
        const projectConfig = resolveOxiquillProjectConfig({
          astroConfig: config,
          astroExplicitFields: inferAstroDirectoryFields(config),
          cwd: metadata.cwd,
          integrationMetadata: metadata
        });
        paths = projectConfig.paths;
        addWatchFile(paths.docsDir);
        addWatchFile(paths.cratesDir);

        const update = {
          cacheDir: astroDirectoryUrl(paths.cacheDir),
          markdown: mergeMarkdownConfig(base, paths, markdown),
          outDir: astroDirectoryUrl(paths.outDir),
          publicDir: astroDirectoryUrl(paths.publicDir),
          vite: mergeViteConfig(paths, vite, bundledModules, browserBundle)
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
            'declare module "virtual:oxiquill/runtime-paths" {',
            '  export const haskellWasmPath: string;',
            '  export const pyodidePath: string;',
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

        bundledModules.reset();
        browserBundle.reset();
        const context = await createDocRuntimeContextForPaths({ paths });
        const summary = await syncDocRuntime(context);
        await buildRustWasm({ mode: 'build', paths });
        if (summary.haskellCellCount > 0) {
          await buildHaskellWasm({ haskellFingerprint: summary.haskellFingerprint, mode: 'build', paths });
        }
        await syncLicenseArtifacts({ outputDirectory: undefined, paths });
        await markRuntimeReady({ paths, summary });
      },
      'astro:build:done': async ({ dir }) => {
        if (!paths) return;

        await syncLicenseArtifacts({
          moduleGroups: bundledModules.snapshot(),
          outputDirectory: pathInUrl(
            dir,
            relativePathFromUrl(paths.publicDir, paths.licensesPublicDir)
          ),
          paths
        });
        await syncBrowserBundleReport({
          chunks: browserBundle.snapshot(),
          frameworkRoot: paths.frameworkRoot,
          outputDirectory: dir,
          workspaceRoot: paths.workspaceRoot
        });
      }
    }
  };

  return attachOxiquillMetadata(integration, metadata) as AstroIntegration;
}

function selectedAstroDirectoryOptions(options: OxiquillConfig): Record<string, string | URL> {
  const optionNames = ['root', 'publicDir', 'cacheDir', 'outDir'] as const;
  return Object.fromEntries(
    optionNames
      .filter((fieldName) => Object.hasOwn(options, fieldName) && options[fieldName] !== undefined)
      .map((fieldName) => [fieldName, options[fieldName]])
  ) as Record<string, string | URL>;
}

function astroDirectoryValue(value: string | URL): string {
  return pathFromUrl(value);
}

function astroDirectoryUrl(value: string): URL {
  return pathToFileURL(value.endsWith(path.sep) ? value : `${value}${path.sep}`);
}

function inferAstroDirectoryFields(config: AstroConfig): string[] {
  const root = pathFromUrl(config.root);
  const defaults: Array<[
    'publicDir' | 'cacheDir' | 'outDir',
    string[]
  ]> = [
    ['publicDir', [directoryPath('public', root)]],
    ['cacheDir', [directoryPath('.oxiquill', root), directoryPath('.astro', root), directoryPath('node_modules/.astro', root)]],
    ['outDir', [directoryPath('dist', root)]]
  ];

  return [
    'root',
    ...defaults.flatMap(([fieldName, defaultPaths]) => {
      if (config[fieldName] === undefined) return [];
      const configuredPath = directoryPath(config[fieldName], root);
      return defaultPaths.includes(configuredPath) ? [] : [fieldName];
    })
  ];
}

function callStarlightIntegration<StarlightOptions extends object>(
  integration: IntegrationFactory<StarlightOptions>,
  options: OxiquillStarlightOptions
): AstroIntegration {
  return (integration as unknown as IntegrationFactory<OxiquillStarlightOptions>)(options);
}

function createStarlightOptions(options: OxiquillStarlightOptions): OxiquillStarlightOptions {
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
    customCss: ['oxiquill/styles/katex.css', 'oxiquill/styles/custom.css', ...customCss],
    components: {
      PageFrame: 'oxiquill/components/starlight/PageFrame',
      ...components
    }
  };
}

function mergeMarkdownConfig(base: BaseAstroUserConfig['base'], paths: OxiquillPaths, markdown: AstroMarkdownConfig) {
  const {
    gfm,
    processor,
    rehypePlugins = [],
    remarkRehype,
    remarkPlugins = [],
    smartypants,
    syntaxHighlight,
    ...markdownRest
  } = markdown;
  const syntaxHighlightOptions = syntaxHighlightConfig(syntaxHighlight);

  return {
    ...markdownRest,
    processor:
      processor ??
      unified({
        gfm,
        rehypePlugins: [rehypeKatex, ...rehypePlugins],
        remarkPlugins: [
          remarkMath,
          [remarkPublicAssetBase, { base }],
          [remarkInteractiveCells, { root: pathFromUrl(paths.workspaceRoot) }],
          remarkMermaidDiagrams,
          ...remarkPlugins
        ],
        remarkRehype,
        smartypants
      }),
    syntaxHighlight: {
      ...syntaxHighlightOptions,
      type: syntaxHighlightOptions.type ?? 'shiki',
      excludeLangs: syntaxHighlightOptions.excludeLangs ?? ['math', 'mermaid']
    }
  };
}

function syntaxHighlightConfig(value: AstroMarkdownConfig['syntaxHighlight']): Partial<SyntaxHighlightObject> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function mergeViteConfig(
  paths: OxiquillPaths,
  vite: ViteUserConfig,
  bundledModules: BundledModuleCollector,
  browserBundle: BrowserBundleCollector
): ViteUserConfig {
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
        bundledModuleCollectorPlugin(bundledModules, 'worker'),
        browserBundleCollectorPlugin(browserBundle, 'worker'),
        ...resolveWorkerPlugins(worker.plugins as ViteWorkerPlugins | undefined)
      ]
    },
    build: {
      chunkSizeWarningLimit: 675,
      ...vite.build
    },
    plugins: [
      oxiquillDependencyResolverPlugin(paths),
      oxiquillVirtualModulesPlugin(paths),
      bundledModuleCollectorPlugin(bundledModules, 'main'),
      browserBundleCollectorPlugin(browserBundle, 'main'),
      ...(vite.plugins ?? [])
    ]
  };
}

function browserBundleCollectorPlugin(collector: BrowserBundleCollector, source: 'main' | 'worker'): Plugin {
  return {
    name: `oxiquill-browser-bundle-${source}`,
    generateBundle(_options, bundle) {
      collector.add(source, bundle);
    }
  };
}

function bundledModuleCollectorPlugin(collector: BundledModuleCollector, source: 'main' | 'worker'): Plugin {
  return {
    name: `oxiquill-license-modules-${source}`,
    generateBundle(_options, bundle) {
      const browserBundle = Object.fromEntries(
        Object.entries(bundle).filter(([, output]) => output.type === 'chunk' && output.fileName.endsWith('.js'))
      );
      collector.add(source, collectBundleModuleIds(browserBundle));
    }
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
  const workspacePreactPackage = pathInUrl(paths.workspaceRoot, 'node_modules', 'preact', 'package.json');
  const aliases: Alias[] = [];

  for (const packageName of viteAliasedPackageNames) {
    if (packageName === 'preact' && existsSync(workspacePreactPackage)) continue;
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

function mergeSsrNoExternal(noExternal: SsrNoExternal | undefined, additions: SsrNoExternalEntry[]): SsrNoExternal {
  if (noExternal === true) return true;

  return uniqueSsrNoExternalEntries([...ssrNoExternalEntries(noExternal), ...additions]);
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
