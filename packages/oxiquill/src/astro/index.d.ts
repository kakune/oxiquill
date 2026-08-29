import type {
  AstroIntegration,
  AstroUserConfig,
  FontProvider,
  Locales,
  SessionDriverConfig
} from 'astro';
import type { Options as PreactIntegrationOptions } from '@astrojs/preact';
import type { StarlightUserConfig } from '@astrojs/starlight/types';
import type { UserConfig as ViteUserConfig } from 'vite';

type BaseAstroUserConfig = AstroUserConfig<Locales, SessionDriverConfig | undefined, FontProvider[]>;
type AstroIntegrations = NonNullable<BaseAstroUserConfig['integrations']>;
type AstroMarkdownConfig = NonNullable<BaseAstroUserConfig['markdown']>;
type IntegrationFactory<Options> = (options: Options) => AstroIntegration;

export type OxiquillPathOptions = Partial<Record<
  | 'cacheDir'
  | 'cratesDir'
  | 'docsDir'
  | 'frameworkRoot'
  | 'generatedDir'
  | 'haskellCellsDir'
  | 'haskellWasmPublicDir'
  | 'publicAssetsDir'
  | 'publicDir'
  | 'pyodidePublicDir'
  | 'rustCellsDir'
  | 'rustWasmPublicDir'
  | 'workspaceRoot',
  string | URL
>>;

export interface OxiquillFrameworkOptions {
  preact?: IntegrationFactory<PreactIntegrationOptions | undefined>;
  starlight?: IntegrationFactory<StarlightUserConfig>;
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

export declare function defineOxiquillConfig(options?: OxiquillConfig): BaseAstroUserConfig;

export declare function oxiquillIntegration(options?: OxiquillIntegrationOptions): AstroIntegration;
